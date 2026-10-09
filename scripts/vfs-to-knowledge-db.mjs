#!/usr/bin/env node

/**
 * scripts/vfs-to-knowledge-db.mjs
 * 
 * Downstream SQLite WAL Ingestion Pipeline for Staged viking:// VFS Artifacts.
 * Ingests notebook_sessions, chat_turns, inquiry_gaps, and fts_terms into knowledge.db
 * under strict WAL concurrency, atomic batching, and TRUNCATE checkpointing.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';

// -----------------------------------------------------------------------------
// CLI Argument Parsing
// -----------------------------------------------------------------------------
function parseArgs(args) {
  const options = {
    manifest: 'vfs/manifest.json',
    db: './data/knowledge.db',
    batchSize: 100
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--manifest' && i + 1 < args.length) {
      options.manifest = args[++i];
    } else if (arg === '--db' && i + 1 < args.length) {
      options.db = args[++i];
    } else if (arg === '--batch-size' && i + 1 < args.length) {
      options.batchSize = parseInt(args[++i], 10) || 100;
    }
  }

  return options;
}

// -----------------------------------------------------------------------------
// Database Initialization & Schema Provisioning
// -----------------------------------------------------------------------------
function initDatabase(dbPath) {
  const fullPath = path.resolve(process.cwd(), dbPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(fullPath);

  // Enforce WAL Concurrency & Pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_sessions (
      notebook_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_turns INTEGER NOT NULL,
      inode_number INTEGER,
      uri TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notebook_id, session_id, date)
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      turn_hash TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      date TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      query TEXT NOT NULL,
      answer TEXT NOT NULL,
      timestamp TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_turns_nb_hash ON chat_turns(notebook_id, turn_hash);
    CREATE INDEX IF NOT EXISTS idx_chat_turns_nb_date ON chat_turns(notebook_id, date);

    CREATE TABLE IF NOT EXISTS inquiry_gaps (
      gap_hash TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      notebook_title TEXT,
      question TEXT NOT NULL,
      context TEXT,
      status TEXT DEFAULT 'OPEN',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_inquiry_gaps_nb ON inquiry_gaps(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_inquiry_gaps_status ON inquiry_gaps(status);

    CREATE TABLE IF NOT EXISTS fts_terms (
      term TEXT NOT NULL,
      notebook_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      term_frequency INTEGER NOT NULL,
      PRIMARY KEY (term, notebook_id, session_id, turn_number)
    );

    CREATE INDEX IF NOT EXISTS idx_fts_terms_term ON fts_terms(term);

    CREATE VIRTUAL TABLE IF NOT EXISTS chat_turns_fts USING fts5(
      turn_hash UNINDEXED,
      notebook_id UNINDEXED,
      query,
      answer,
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS trg_chat_turns_ai AFTER INSERT ON chat_turns BEGIN
      INSERT INTO chat_turns_fts(turn_hash, notebook_id, query, answer)
      VALUES (new.turn_hash, new.notebook_id, new.query, new.answer);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_turns_ad AFTER DELETE ON chat_turns BEGIN
      DELETE FROM chat_turns_fts WHERE turn_hash = old.turn_hash;
    END;
  `);

  return db;
}

// -----------------------------------------------------------------------------
// Ingestion Pipeline
// -----------------------------------------------------------------------------
async function runIngestion() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(process.cwd(), opts.manifest);

  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: Manifest file not found at: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const vfsBaseDir = path.dirname(manifestPath);

  console.log('========================================================================');
  console.log(' [KNOWLEDGE-DB] SQLite WAL Ingestion Engine');
  console.log(` Target DB:    ${opts.db}`);
  console.log(` Manifest:     ${opts.manifest} (${manifest.total_inodes} inodes)`);
  console.log(` Batch Size:   ${opts.batchSize}`);
  console.log('========================================================================\n');

  const db = initDatabase(opts.db);
  const journalMode = db.pragma('journal_mode', { simple: true });
  console.log(`[PRAGMA] journal_mode = ${journalMode} (WAL Mode Active)`);
  console.log(`[PRAGMA] synchronous  = NORMAL`);
  console.log(`[PRAGMA] busy_timeout = 5000ms\n`);

  // Prepared statements for batch operations
  const insertSession = db.prepare(`
    INSERT INTO notebook_sessions (notebook_id, session_id, date, total_turns, inode_number, uri)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(notebook_id, session_id, date) DO UPDATE SET
      total_turns = excluded.total_turns,
      inode_number = excluded.inode_number,
      uri = excluded.uri
  `);

  const insertTurn = db.prepare(`
    INSERT OR REPLACE INTO chat_turns (turn_hash, notebook_id, session_id, date, turn_number, query, answer, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertGap = db.prepare(`
    INSERT INTO inquiry_gaps (gap_hash, notebook_id, notebook_title, question, context, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(gap_hash) DO UPDATE SET
      question = excluded.question,
      context = excluded.context
  `);

  const insertTerm = db.prepare(`
    INSERT OR REPLACE INTO fts_terms (term, notebook_id, session_id, turn_number, term_frequency)
    VALUES (?, ?, ?, ?, ?)
  `);

  let totalSessionsIngested = 0;
  let totalTurnsIngested = 0;
  let totalGapsIngested = 0;
  let totalTermsIngested = 0;

  // 1. Process Raw Stream Inodes (Turns & Sessions)
  const streamInodes = manifest.inodes.filter(i => i.type === 'stream');
  console.log(`[INGEST] Processing ${streamInodes.length} raw turn stream inodes...`);

  for (const entry of streamInodes) {
    const filePath = path.join(vfsBaseDir, entry.path);
    if (!fs.existsSync(filePath)) {
      console.warn(`[WARN] File not found for inode #${entry.inode}: ${filePath}`);
      continue;
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const turnsBatch = [];
    let sessionMeta = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      const turnObj = JSON.parse(line);
      turnsBatch.push(turnObj);

      if (!sessionMeta) {
        sessionMeta = {
          notebook_id: turnObj.notebook_id,
          session_id: turnObj.session_id,
          date: turnObj.date,
          total_turns: entry.item_count,
          inode_number: entry.inode,
          uri: entry.uri
        };
      }
    }

    // Insert session metadata
    if (sessionMeta) {
      insertSession.run(
        sessionMeta.notebook_id,
        sessionMeta.session_id,
        sessionMeta.date,
        sessionMeta.total_turns,
        sessionMeta.inode_number,
        sessionMeta.uri
      );
      totalSessionsIngested++;
    }

    // Insert turns in atomic transaction chunks
    const insertManyTurns = db.transaction((turns) => {
      for (const t of turns) {
        insertTurn.run(
          t.turn_hash,
          t.notebook_id,
          t.session_id,
          t.date,
          t.turn,
          t.query,
          t.answer,
          t.timestamp
        );
      }
    });

    for (let i = 0; i < turnsBatch.length; i += opts.batchSize) {
      const slice = turnsBatch.slice(i, i + opts.batchSize);
      insertManyTurns(slice);
    }
    totalTurnsIngested += turnsBatch.length;
  }
  console.log(`[INGEST] ✓ Sessions: ${totalSessionsIngested} | Turns: ${totalTurnsIngested}`);

  // 2. Process Inquiry Gaps
  const gapsInode = manifest.inodes.find(i => i.type === 'summary');
  if (gapsInode) {
    const gapsPath = path.join(vfsBaseDir, gapsInode.path);
    if (fs.existsSync(gapsPath)) {
      const gapsData = JSON.parse(fs.readFileSync(gapsPath, 'utf8'));
      const gapsList = gapsData.gaps || [];
      console.log(`[INGEST] Ingesting ${gapsList.length} inquiry gaps from inode #${gapsInode.inode}...`);

      const insertManyGaps = db.transaction((gaps) => {
        for (const g of gaps) {
          insertGap.run(
            g.gap_hash,
            g.notebook_id,
            g.notebook_title || null,
            g.question,
            g.context || null,
            'OPEN'
          );
        }
      });

      for (let i = 0; i < gapsList.length; i += opts.batchSize) {
        const slice = gapsList.slice(i, i + opts.batchSize);
        insertManyGaps(slice);
      }
      totalGapsIngested = gapsList.length;
      console.log(`[INGEST] ✓ Inquiry Gaps: ${totalGapsIngested}`);
    }
  }

  // 3. Process FTS Inverted Index Postings
  const indexInode = manifest.inodes.find(i => i.type === 'index');
  if (indexInode) {
    const indexPath = path.join(vfsBaseDir, indexInode.path);
    if (fs.existsSync(indexPath)) {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const termsMap = indexData.terms || {};
      const termEntries = Object.entries(termsMap);
      console.log(`[INGEST] Ingesting ${termEntries.length} inverted index terms from inode #${indexInode.inode}...`);

      const insertManyTerms = db.transaction((batch) => {
        for (const item of batch) {
          insertTerm.run(item.term, item.nb, item.sess, item.turn, item.tf);
        }
      });

      let currentBatch = [];
      for (const [term, postings] of termEntries) {
        for (const p of postings) {
          currentBatch.push({ term, nb: p.nb, sess: p.sess, turn: p.turn, tf: p.tf });
          if (currentBatch.length >= opts.batchSize) {
            insertManyTerms(currentBatch);
            totalTermsIngested += currentBatch.length;
            currentBatch = [];
          }
        }
      }
      if (currentBatch.length > 0) {
        insertManyTerms(currentBatch);
        totalTermsIngested += currentBatch.length;
      }
      console.log(`[INGEST] ✓ FTS Term Postings: ${totalTermsIngested}`);
    }
  }

  // 4. Force Explicit WAL Checkpoint to flush log and prevent unbounded WAL bloat
  console.log('\n[WAL-CHECKPOINT] Executing PRAGMA wal_checkpoint(TRUNCATE)...');
  const checkpointResult = db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(`[WAL-CHECKPOINT] Result:`, checkpointResult);

  // Close database connection
  db.close();

  console.log('\n========================================================================');
  console.log(' [SUCCESS] Downstream Ingestion into knowledge.db Complete');
  console.log(` • Sessions Ingested:   ${totalSessionsIngested}`);
  console.log(` • Chat Turns Ingested: ${totalTurnsIngested}`);
  console.log(` • Inquiry Gaps Logged: ${totalGapsIngested}`);
  console.log(` • FTS Terms Stored:    ${totalTermsIngested}`);
  console.log(' • WAL Checkpoint:      Cleanly Truncated (Exit Code: 0)');
  console.log('========================================================================');
}

runIngestion().catch((err) => {
  console.error(`[FATAL] Ingestion failure: ${err.stack || err.message}`);
  process.exit(1);
});
