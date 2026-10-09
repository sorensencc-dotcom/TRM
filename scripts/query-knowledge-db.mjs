#!/usr/bin/env node

/**
 * scripts/query-knowledge-db.mjs
 * 
 * Query Interface for TRM / Viking knowledge.db WAL Database.
 * Supports:
 *   - Lexical full-text search across 290+ chat turns
 *   - Inquiry gaps inspection and status filtering
 *   - Session registry inspection
 *   - Database summary statistics
 * 
 * Usage:
 *   node scripts/query-knowledge-db.mjs search "aviation" [--limit 5]
 *   node scripts/query-knowledge-db.mjs gaps [--filter "cuba"] [--limit 10]
 *   node scripts/query-knowledge-db.mjs sessions [--date 2026-10-08]
 *   node scripts/query-knowledge-db.mjs stats
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_DB = './data/knowledge.db';

function openDb(dbPath = DEFAULT_DB) {
  const fullPath = path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`[-] Error: Database file not found at ${fullPath}`);
    process.exit(1);
  }
  const db = new Database(fullPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function printHelp() {
  console.log(`
TRM Knowledge Database Query Tool
Database: ${DEFAULT_DB}

Commands:
  search <terms> [--limit <n>]     Search chat turns using FTS5 lexical matching
  gaps [--filter <term>] [--limit <n>] [--status <OPEN|RESOLVED>]
                                   List unresolved inquiry gaps
  sessions [--date <YYYY-MM-DD>]   List indexed notebook sessions
  stats                            Show database record counts and WAL state
  `);
}

function runStats(db) {
  console.log('\n=== TRM knowledge.db Statistics ===');
  const journalMode = db.pragma('journal_mode', { simple: true });
  console.log(`• Journal Mode:     ${journalMode}`);

  const sessionCount = db.prepare('SELECT count(*) as c FROM notebook_sessions').get().c;
  const turnsCount = db.prepare('SELECT count(*) as c FROM chat_turns').get().c;
  const ftsCount = db.prepare('SELECT count(*) as c FROM chat_turns_fts').get().c;
  const gapsCount = db.prepare('SELECT count(*) as c FROM inquiry_gaps').get().c;
  const termsCount = db.prepare('SELECT count(*) as c FROM fts_terms').get().c;

  console.log(`• Notebook Sessions: ${sessionCount}`);
  console.log(`• Chat Turns:        ${turnsCount} (FTS indexed: ${ftsCount})`);
  console.log(`• Inquiry Gaps:      ${gapsCount}`);
  console.log(`• Term Postings:     ${termsCount}\n`);
}

function runSearch(db, query, limit = 5) {
  if (!query) {
    console.error('[-] Error: Search terms required.');
    process.exit(1);
  }

  const stmt = db.prepare(`
    SELECT t.notebook_id, t.session_id, t.turn_number, t.query, t.answer, t.date
    FROM chat_turns_fts f
    JOIN chat_turns t ON f.turn_hash = t.turn_hash
    WHERE chat_turns_fts MATCH ?
    LIMIT ?
  `);

  let rows = [];
  try {
    rows = stmt.all(query, limit);
  } catch (err) {
    console.error(`[-] FTS query failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n=== FTS5 Search Results for '${query}' (${rows.length} hits) ===\n`);
  if (rows.length === 0) {
    console.log('No matching turns found.');
    return;
  }

  rows.forEach((r, idx) => {
    console.log(`[#${idx + 1}] Turn ${r.turn_number} (${r.date}) | Notebook: ${r.notebook_id}`);
    console.log(`  Q: ${r.query}`);
    const answerSnippet = r.answer.length > 250 ? r.answer.slice(0, 250) + '...' : r.answer;
    console.log(`  A: ${answerSnippet}\n`);
  });
}

function runGaps(db, filterTerm = null, status = 'OPEN', limit = 10) {
  let sql = 'SELECT notebook_id, notebook_title, question, status FROM inquiry_gaps WHERE status = ?';
  const params = [status];

  if (filterTerm) {
    sql += ' AND (LOWER(question) LIKE ? OR LOWER(notebook_title) LIKE ?)';
    const wild = `%${filterTerm.toLowerCase()}%`;
    params.push(wild, wild);
  }

  sql += ' LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  console.log(`\n=== Inquiry Gaps (${status}) ${filterTerm ? `[Filter: '${filterTerm}'] ` : ''}(${rows.length} results) ===\n`);

  if (rows.length === 0) {
    console.log('No matching inquiry gaps found.');
    return;
  }

  rows.forEach((r, idx) => {
    console.log(`[#${idx + 1}] [${r.status}] ${r.notebook_title || r.notebook_id}`);
    console.log(`  • ${r.question}\n`);
  });
}

function runSessions(db, targetDate = null) {
  let sql = 'SELECT notebook_id, session_id, date, total_turns, inode_number, uri FROM notebook_sessions';
  const params = [];

  if (targetDate) {
    sql += ' WHERE date = ?';
    params.push(targetDate);
  }
  sql += ' ORDER BY total_turns DESC';

  const rows = db.prepare(sql).all(...params);
  console.log(`\n=== Notebook Sessions ${targetDate ? `[Date: ${targetDate}] ` : ''}(${rows.length} entries) ===\n`);

  rows.forEach((r) => {
    console.log(`• Inode #${r.inode_number} | ${r.notebook_id} | ${r.date} | ${r.total_turns} turns`);
    console.log(`  URI: ${r.uri}`);
  });
  console.log();
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);
const command = args[0] || 'help';

let limit = 5;
let filterTerm = null;
let status = 'OPEN';
let date = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--limit' && i + 1 < args.length) limit = parseInt(args[++i], 10);
  if (args[i] === '--filter' && i + 1 < args.length) filterTerm = args[++i];
  if (args[i] === '--status' && i + 1 < args.length) status = args[++i];
  if (args[i] === '--date' && i + 1 < args.length) date = args[++i];
}

const db = openDb();

try {
  switch (command) {
    case 'stats':
      runStats(db);
      break;
    case 'search':
      runSearch(db, args[1], limit);
      break;
    case 'gaps':
      runGaps(db, filterTerm, status, limit);
      break;
    case 'sessions':
      runSessions(db, date);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
} finally {
  db.close();
}
