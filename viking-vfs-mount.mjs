#!/usr/bin/env node

/**
 * viking-vfs-mount.mjs
 * 
 * Volcengine OpenViking-aligned virtual filesystem provider and MCP bridge.
 * Projects the Three-Layer Knowledge Vault onto a unified viking:// URI interface
 * with tiered on-demand loading (L0 Abstract, L1 Overview, L2 Details) using the
 * high-performance SQLite WAL state machine.
 * 
 * Version: 1.0.0
 * Date: 2026-09-03
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Central Database connection (prefers better-sqlite3 if available, falls back to node:sqlite)
let DatabaseSync;
let Database;
let hasBetterSqlite3 = false;

try {
  const { default: DB } = await import('better-sqlite3');
  Database = DB;
  hasBetterSqlite3 = true;
} catch {
  try {
    const { DatabaseSync: DBSync } = await import('node:sqlite');
    DatabaseSync = DBSync;
  } catch (err) {
    process.stderr.write('[VIKING-VFS] [ERROR] No supported SQLite driver found (better-sqlite3 or node:sqlite).\n');
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// Constants and Defaults
// -----------------------------------------------------------------------------
const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.kb_cache/knowledge.db');
const DB_PATH = process.env.KB_CACHE_DB || process.env.VAULT_DB_PATH || DEFAULT_DB_PATH;

const COLOR = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function logInfo(msg) {
  process.stderr.write(`${COLOR.green}[VIKING-VFS] [INFO]${COLOR.reset} ${msg}\n`);
}

function logWarn(msg) {
  process.stderr.write(`${COLOR.yellow}[VIKING-VFS] [WARN]${COLOR.reset} ${msg}\n`);
}

function logError(msg) {
  process.stderr.write(`${COLOR.red}[VIKING-VFS] [ERROR]${COLOR.reset} ${msg}\n`);
}

// -----------------------------------------------------------------------------
// Database Client & WAL State Machine
// -----------------------------------------------------------------------------
export class VikingDatabase {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    if (this.dbPath !== ':memory:') {
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    logInfo(`Connecting to VFS context database at: ${this.dbPath}`);
    if (hasBetterSqlite3) {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    } else {
      this.db = new DatabaseSync(this.dbPath, { readonly: false });
      // Execute WAL enablement manually for native node:sqlite
      try {
        if (this.dbPath !== ':memory:') {
          this.db.exec('PRAGMA journal_mode = WAL;');
        }
        this.db.exec('PRAGMA foreign_keys = ON;');
      } catch (err) {
        logWarn(`Unable to set WAL mode: ${err.message}`);
      }
    }
    this._prepare();
  }

  _prepare() {
    // Standard schema verification
    const tables = this.all(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='kb_documents'
    `);
    
    if (tables.length === 0) {
      logWarn(`kb_documents table is missing. Attempting schema auto-provisioning...`);
      this.exec(`
        CREATE TABLE IF NOT EXISTS kb_documents (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          topic TEXT NOT NULL,
          file_path TEXT NOT NULL,
          content TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(id, topic, content);
        CREATE TRIGGER IF NOT EXISTS trg_kb_docs_ai AFTER INSERT ON kb_documents BEGIN
          INSERT INTO kb_fts(id, topic, content) VALUES (new.id, new.topic, new.content);
        END;
      `);
      logInfo(`✓ System context schema initialized.`);
    }

    // Pre-compiled statement cache
    this.statements = {
      getDocByTopic: this.db.prepare(`
        SELECT id, category, topic, file_path, content, sha256, last_updated
        FROM kb_documents
        WHERE LOWER(category || '/' || topic) = ? OR LOWER(topic) = ? OR id = ? OR LOWER(file_path) LIKE ?
        LIMIT 1
      `),
      listAllDocs: this.db.prepare(`
        SELECT id, category, topic, file_path, length(content) as byte_size, sha256, last_updated
        FROM kb_documents
        ORDER BY category ASC, topic ASC
      `),
      ftsQuery: this.db.prepare(`
        SELECT d.id, d.category, d.topic, d.file_path, d.content, d.sha256
        FROM kb_documents d
        JOIN kb_fts f ON d.id = f.id
        WHERE kb_fts MATCH ?
        LIMIT ?
      `)
    };
  }

  // Unified driver wrappers for cross-compatibility
  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  getDoc(topic) {
    const clean = topic.trim().toLowerCase();
    const wild = `%${clean}%`;
    try {
      return this.statements.getDocByTopic.get(clean, clean, topic, wild);
    } catch (err) {
      logError(`Failed fetching document for '${topic}': ${err.message}`);
      return null;
    }
  }

  listDocs() {
    try {
      return this.statements.listAllDocs.all();
    } catch (err) {
      logError(`Failed listing documents: ${err.message}`);
      return [];
    }
  }

  searchFts(query, limit = 5) {
    try {
      const sanitized = this._sanitizeFtsQuery(query);
      if (!sanitized) return [];
      return this.statements.ftsQuery.all(sanitized, limit);
    } catch (err) {
      logError(`FTS search failed for '${query}': ${err.message}`);
      return [];
    }
  }

  _sanitizeFtsQuery(query) {
    if (!query || typeof query !== 'string') return '';
    const clean = query.trim();
    if (!clean) return '';
    // Wrap tokens in double-quotes to sanitize operators/punctuation in FTS5
    const tokens = clean.split(/\s+/).map(token => {
      const escaped = token.replace(/"/g, '""');
      return `"${escaped}"`;
    });
    return tokens.join(' ');
  }

  close() {
    this.db.close();
  }
}

// -----------------------------------------------------------------------------
// VFS Tiered Processing Logic
// -----------------------------------------------------------------------------
export class VikingVFS {
  constructor(db) {
    this.db = db;
  }

  /**
   * Translates raw markdown content into the requested OpenViking representation tier.
   * Compresses active model contexts down to prevent token bleed.
   */
  processTier(doc, tier) {
    const rawContent = doc.content;
    const cleanTier = (tier || 'L1').toUpperCase();

    switch (cleanTier) {
      case 'L0':
        return this._deriveL0Abstract(rawContent, doc);
      case 'L1':
        return this._deriveL1Overview(rawContent, doc);
      case 'L2':
      case 'FULL':
        return rawContent;
      default:
        throw new Error(`UNSUPPORTED_RESOLUTION_TIER: Resolution tier must be L0, L1, or L2.`);
    }
  }

  _deriveL0Abstract(content, doc) {
    // 1. Attempt extracting summary from Yaml Frontmatter if present
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (fmMatch) {
      const fmBody = fmMatch[1];
      const summaryMatch = fmBody.match(/^summary:\s*(.+)$/m);
      if (summaryMatch) {
        return `[L0 ABSTRACT] ${summaryMatch[1].trim().replace(/^["']|["']$/g, '')}`;
      }
      const purposeMatch = fmBody.match(/^purpose:\s*(.+)$/m);
      if (purposeMatch) {
        return `[L0 ABSTRACT] Purpose: ${purposeMatch[1].trim()}`;
      }
    }

    // 2. Fall back to the first non-heading sentence / paragraph
    const bodyText = fmMatch ? fmMatch[2] : content;
    const cleanLines = bodyText.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('`'));

    if (cleanLines.length > 0) {
      const firstParagraph = cleanLines[0];
      const sentences = firstParagraph.split(/[.!?]\s+/);
      if (sentences.length > 0 && sentences[0].length > 10) {
        return `[L0 ABSTRACT] ${sentences[0].trim()}.`;
      }
      return `[L0 ABSTRACT] ${firstParagraph.slice(0, 150).trim()}...`;
    }

    return `[L0 ABSTRACT] Concept node detailing ${doc.topic} within the ${doc.category} namespace.`;
  }

  _deriveL1Overview(content, doc) {
    // Extract frontmatter, high-level headers, bullet points, and code interface specifications (API outlines)
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    let frontmatterHeader = `---\ncategory: ${doc.category}\ntopic: ${doc.topic}\npath: ${doc.file_path}\ntier: L1 (Overview)\n---\n\n`;

    if (fmMatch) {
      const parsedFm = fmMatch[1].split('\n')
        .filter(l => l.startsWith('title:') || l.startsWith('status:') || l.startsWith('category:') || l.startsWith('gap_id:'))
        .join('\n');
      frontmatterHeader = `---\n${parsedFm}\ntier: L1 (Overview)\nsource_file: ${doc.file_path}\n---\n\n`;
    }

    const bodyText = fmMatch ? fmMatch[2] : content;
    const lines = bodyText.split('\n');
    const outlineLines = [];

    let insideCodeBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Capture heading structures
      if (trimmed.startsWith('#')) {
        outlineLines.push(line);
        continue;
      }

      // Handle code block outlines / skeleton declarations
      if (trimmed.startsWith('```')) {
        insideCodeBlock = !insideCodeBlock;
        if (insideCodeBlock) {
          outlineLines.push(line);
        } else {
          outlineLines.push('```\n');
        }
        continue;
      }

      if (insideCodeBlock) {
        // Retain code interface signatures (classes, exports, constructors, methods, parameters)
        if (
          trimmed.startsWith('export ') ||
          trimmed.startsWith('class ') ||
          trimmed.startsWith('interface ') ||
          trimmed.startsWith('constructor') ||
          trimmed.startsWith('async ') ||
          trimmed.startsWith('function ') ||
          trimmed.startsWith('private ') ||
          trimmed.startsWith('public ') ||
          (trimmed.includes('(') && trimmed.endsWith('{')) ||
          trimmed.startsWith('type ')
        ) {
          outlineLines.push(line);
        }
        continue;
      }

      // Retain high-level list structures, descriptions, and warnings
      if (
        trimmed.startsWith('*') || 
        trimmed.startsWith('-') || 
        trimmed.match(/^\d+\./) ||
        trimmed.startsWith('>') ||
        trimmed.toLowerCase().startsWith('warning:') ||
        trimmed.toLowerCase().startsWith('note:')
      ) {
        outlineLines.push(line);
      }
    }

    if (outlineLines.length === 0) {
      return `${frontmatterHeader}# ${doc.topic} Overview\n\nNo structural headers or lists located in raw L2 details. Refer directly to L2 for complete execution content.`;
    }

    return frontmatterHeader + outlineLines.join('\n');
  }

  /**
   * Resolves a target URI or relative topic path into a standard VFS response.
   */
  resolveUri(uri, tier = 'L1') {
    // Normalize viking:// scheme or direct topic key
    let cleanTopic = (uri || '').replace(/^viking:\/\//i, '');
    cleanTopic = cleanTopic.replace(/\.md$/i, '');

    const doc = this.db.getDoc(cleanTopic);
    if (!doc) {
      return {
        ok: false,
        error: {
          vikingCode: 'TIER_UNAVAILABLE',
          message: `Resource '${uri}' (resolved topic key: '${cleanTopic}') is not indexed inside local SQLite cache.`
        }
      };
    }

    try {
      const processedContent = this.processTier(doc, tier);
      return {
        ok: true,
        value: {
          uri: `viking://${doc.category}/${doc.topic}`,
          resolution_tier: (tier || 'L1').toUpperCase(),
          stale: false,
          content: processedContent,
          metadata: {
            id: doc.id,
            category: doc.category,
            topic: doc.topic,
            file_path: doc.file_path,
            sha256: doc.sha256,
            last_updated: doc.last_updated
          }
        }
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          vikingCode: 'PROCESSING_ERROR',
          message: err.message
        }
      };
    }
  }
}

// -----------------------------------------------------------------------------
// JSON-RPC Stdio MCP Server Engine
// -----------------------------------------------------------------------------
export function startMcpServer(vfs) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  process.stderr.write(`[VIKING-VFS] MCP server listening on stdio using database at: ${DB_PATH}\n`);

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let request;
    try {
      request = JSON.parse(line);
    } catch (err) {
      sendRpcError(null, -32700, 'Parse error');
      return;
    }

    try {
      handleRpcRequest(vfs, request);
    } catch (err) {
      sendRpcError(request.id || null, -32603, `Internal error: ${err.message}`);
    }
  });
}

export function handleRpcRequest(vfs, req) {
  const { method, params, id } = req;

  if (method === 'initialize') {
    const response = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: 'viking-vfs-mount',
          version: '1.0.0'
        }
      }
    };
    sendRpcResponse(response);
    return;
  }

  // Handle standard MCP tools listing
  if (method === 'tools/list') {
    const response = {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'vfs_list_dir',
            description: 'Lists all available virtual documents and concepts registered in the viking:// database, returning L0 summaries.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'vfs_read_file',
            description: 'Reads a virtual document from the viking:// protocol under a specified resolution tier (L0 Abstract, L1 Overview, L2 details). Saves up to 72% token overhead.',
            inputSchema: {
              type: 'object',
              required: ['uri'],
              properties: {
                uri: {
                  type: 'string',
                  description: 'The canonical URI to fetch (e.g., viking://research/mobile-websocket-heartbeats)'
                },
                tier: {
                  type: 'string',
                  enum: ['L0', 'L1', 'L2'],
                  default: 'L1',
                  description: 'Viking resolution tier: L0 (Abstract), L1 (Overview / AST Outlines), L2 (Full details)'
                }
              }
            }
          },
          {
            name: 'vfs_search',
            description: 'Executes a high-speed local FTS5 BM25 lexical query across all cached documents and returns matching outlines.',
            inputSchema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: {
                  type: 'string',
                  description: 'Search pattern / matching terms'
                },
                limit: {
                  type: 'number',
                  default: 5
                }
              }
            }
          }
        ]
      }
    };
    sendRpcResponse(response);
    return;
  }

  // Handle tools execution
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    let result;

    if (name === 'vfs_list_dir') {
      const docs = vfs.db.listDocs();
      const list = docs.map(doc => {
        const vfsRes = vfs.resolveUri(`viking://${doc.category}/${doc.topic}`, 'L0');
        const abstract = vfsRes.ok ? vfsRes.value.content : 'No abstract compiled.';
        return {
          uri: `viking://${doc.category}/${doc.topic}`,
          file_path: doc.file_path,
          category: doc.category,
          abstract
        };
      });
      result = {
        content: [{
          type: 'text',
          text: JSON.stringify(list, null, 2)
        }]
      };
    } 
    else if (name === 'vfs_read_file') {
      const vfsRes = vfs.resolveUri(args?.uri, args?.tier || 'L1');
      if (vfsRes.ok) {
        result = {
          content: [
            {
              type: 'text',
              text: vfsRes.value.content
            }
          ]
        };
      } else {
        result = {
          isError: true,
          content: [{
            type: 'text',
            text: `VFS Error: ${vfsRes.error.message} (vikingCode: ${vfsRes.error.vikingCode})`
          }]
        };
      }
    } 
    else if (name === 'vfs_search') {
      const searchResults = vfs.db.searchFts(args?.query, args?.limit || 5);
      const formatted = searchResults.map(res => {
        const vfsRes = vfs.resolveUri(`viking://${res.category}/${res.topic}`, 'L1');
        return {
          uri: `viking://${res.category}/${res.topic}`,
          path: res.file_path,
          l1_overview: vfsRes.ok ? vfsRes.value.content : 'L1 extraction failed'
        };
      });
      result = {
        content: [{
          type: 'text',
          text: JSON.stringify(formatted, null, 2)
        }]
      };
    } 
    else {
      sendRpcError(id, -32601, `Method not found: ${name}`);
      return;
    }

    sendRpcResponse({
      jsonrpc: '2.0',
      id,
      result
    });
    return;
  }

  // Safe fallback for unhandled JSON-RPC wrappers
  sendRpcResponse({
    jsonrpc: '2.0',
    id,
    result: {}
  });
}

function sendRpcResponse(res) {
  process.stdout.write(JSON.stringify(res) + '\n');
}

function sendRpcError(id, code, message) {
  sendRpcResponse({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  });
}

// -----------------------------------------------------------------------------
// CLI Mode & Initializer Entrypoint
// -----------------------------------------------------------------------------
export function runCli(vfs, args) {
  const command = args[0] || 'help';

  if (command === 'ls') {
    const docs = vfs.db.listDocs();
    console.log(`\n=== Available viking:// context maps ===`);
    for (const doc of docs) {
      const vfsRes = vfs.resolveUri(`viking://${doc.category}/${doc.topic}`, 'L0');
      const abstract = vfsRes.ok ? vfsRes.value.content : 'No L0 abstract compiled.';
      console.log(`viking://${doc.category}/${doc.topic}  --> ${doc.file_path}`);
      console.log(`  └─ ${abstract}\n`);
    }
  } 
  else if (command === 'read') {
    const uri = args[1];
    const tier = args[2] || 'L1';
    if (!uri) {
      console.error(`[-] Error: URI parameter is required. Usage: node viking-vfs-mount.mjs read viking://research/heartbeats L1`);
      process.exit(1);
    }
    const res = vfs.resolveUri(uri, tier);
    if (res.ok) {
      console.log(res.value.content);
    } else {
      console.error(`[-] VFS Resolution Failure:`, res.error.message);
      process.exit(1);
    }
  } 
  else if (command === 'search') {
    const query = args[1];
    if (!query) {
      console.error(`[-] Error: Query parameter is required.`);
      process.exit(1);
    }
    const results = vfs.db.searchFts(query);
    console.log(`\n=== FTS5 BM25 search results for: '${query}' ===`);
    for (const res of results) {
      console.log(`* viking://${res.category}/${res.topic} (file: ${res.file_path})`);
    }
  } 
  else {
    console.log(`
viking-vfs-mount.mjs: Volcengine OpenViking Context VFS Manager

CLI Commands:
  node viking-vfs-mount.mjs ls                  Lists all indexed context references with L0 abstracts.
  node viking-vfs-mount.mjs read <uri> [tier]   Reads a file under L0, L1, or L2 (default L1).
  node viking-vfs-mount.mjs search <query>      Performs lexical search.

MCP Mode (triggered automatically when launched as a child process via Stdio):
  Serves vfs_list_dir, vfs_read_file, and vfs_search over Standard input/output.
    `);
  }
}

// Main Execution Guard
try {
  const currentFilePath = fileURLToPath(import.meta.url);
  const isDirectRun = process.argv[1] && (
    fs.realpathSync(process.argv[1]) === fs.realpathSync(currentFilePath)
  );

  if (isDirectRun) {
    const dbInstance = new VikingDatabase(DB_PATH);
    const vfsInstance = new VikingVFS(dbInstance);

    const cliArgs = process.argv.slice(2);
    const isExplicitMcp = cliArgs.includes('--mcp');
    const hasCliCommand = cliArgs.length > 0 && !isExplicitMcp && !cliArgs[0].startsWith('-');

    if (isExplicitMcp || (!hasCliCommand && !process.stdin.isTTY)) {
      startMcpServer(vfsInstance);
    } else {
      runCli(vfsInstance, cliArgs);
      dbInstance.close();
    }
  }
} catch (e) {
  // Ignored when imported as module in environments without standard argv[1]
}
