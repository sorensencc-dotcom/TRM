import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import readline from 'node:readline';
// @ts-ignore
import { DatabaseSync } from 'node:sqlite';

describe('Viking VFS Mount & Tiered Resolution Harness', () => {
  const TEST_DB_PATH = path.resolve(process.cwd(), '.kb_cache/test_knowledge.db');
  let db: DatabaseSync;

  const sampleDoc1 = {
    id: 'doc-1',
    category: 'research',
    topic: 'mobile-websocket-heartbeats',
    file_path: 'research/mobile-websocket-heartbeats.md',
    content: `---
title: Mobile WebSocket Heartbeat Resiliency
category: research
topic: mobile-websocket-heartbeats
status: active
summary: Implements adaptive ping-pong timers to maintain persistent socket connections across cellular transitions.
gap_id: GAP-104
---

# Mobile WebSocket Heartbeats

WebSocket connections on mobile devices experience frequent silent termination due to cellular carrier NAT timeouts and OS background task suspension.

## Architectural Objectives
* Maintain sub-second reconnection latency.
* Minimize battery consumption from unnecessary wakeups.
* Detect half-open TCP connections within 15 seconds.

## Interface Specifications

\`\`\`typescript
export interface HeartbeatConfig {
  intervalMs: number;
  timeoutMs: number;
  maxRetries: number;
}

export class HeartbeatManager {
  private timer: NodeJS.Timeout | null = null;
  private lastPong: number = 0;

  constructor(private readonly config: HeartbeatConfig) {
    this.initTimers();
  }

  public async startHeartbeat(): Promise<void> {
    const rawBuffer = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 1000; i++) {
      rawBuffer[i] = i % 255;
    }
    const payload = JSON.stringify({ ping: Date.now(), sequence: 104 });
    const encrypted = Buffer.from(payload).toString('base64');
    console.log("Heartbeat loop payload: " + encrypted);
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastPong > this.config.timeoutMs) {
        console.warn("Heartbeat timeout triggered, initiating reconnect...");
      }
    }, this.config.intervalMs);
  }

  public async reconnect(): Promise<void> {
    const maxRetries = this.config.maxRetries;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const backoff = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise(resolve => setTimeout(resolve, backoff));
      console.log("Reconnection attempt " + attempt + " of " + maxRetries);
    }
  }

  public stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
\`\`\`

## Recovery Protocols
1. Exponential backoff retry with jitter.
2. Fast reconnect on network interface switch (WiFi <-> Cellular).
3. Queue outgoing telemetry frames during offline periods.
`,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  };

  const sampleDoc2 = {
    id: 'doc-2',
    category: 'architecture',
    topic: 'event-bridge-routing',
    file_path: 'architecture/event-bridge-routing.md',
    content: `---
title: Event Bridge Routing Specification
category: architecture
topic: event-bridge-routing
purpose: Centralizes event dispatching across microservices with deduplication.
---

# Event Bridge Routing

High-throughput distributed event bus with guaranteed delivery semantics.

* Supports multi-tenant routing.
* Deduplicates event keys using 5-minute sliding bloom filters.
`,
    sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0'
  };

  const sampleDoc3 = {
    id: 'doc-3',
    category: 'concepts',
    topic: 'sqlite-wal-concurrency',
    file_path: 'concepts/sqlite-wal-concurrency.md',
    content: `SQLite Write-Ahead Logging allows simultaneous reader processes while a writer commits changes.

Readers do not block writers, and writers do not block readers.

### Key Benefits
- Lock contention reduction.
- Fast sequential journal writes.
`,
    sha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  };

  function runCli(args: string[]): { stdout: string; status: number } {
    try {
      const output = execFileSync('node', ['viking-vfs-mount.mjs', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, KB_CACHE_DB: TEST_DB_PATH },
        encoding: 'utf8'
      });
      return { stdout: output, status: 0 };
    } catch (err: any) {
      return { stdout: err.stdout || '', status: err.status || 1 };
    }
  }

  beforeAll(() => {
    const dbDir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (fs.existsSync(TEST_DB_PATH)) {
      try {
        fs.unlinkSync(TEST_DB_PATH);
      } catch {}
    }

    db = new DatabaseSync(TEST_DB_PATH);
    db.exec(`
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

    for (const doc of [sampleDoc1, sampleDoc2, sampleDoc3]) {
      const stmt = db.prepare(`
        INSERT INTO kb_documents (id, category, topic, file_path, content, sha256)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(doc.id, doc.category, doc.topic, doc.file_path, doc.content, doc.sha256);
    }
  });

  afterAll(() => {
    try {
      db.close();
    } catch {}
    if (fs.existsSync(TEST_DB_PATH)) {
      try {
        fs.unlinkSync(TEST_DB_PATH);
      } catch {}
    }
  });

  describe('CLI Command Interface & Tiered Extraction', () => {
    test('ls command lists all indexed context references with L0 abstracts', () => {
      const { stdout, status } = runCli(['ls']);
      expect(status).toBe(0);
      expect(stdout).toContain('viking://research/mobile-websocket-heartbeats');
      expect(stdout).toContain('viking://architecture/event-bridge-routing');
      expect(stdout).toContain('viking://concepts/sqlite-wal-concurrency');
      expect(stdout).toContain('[L0 ABSTRACT]');
    });

    test('read command resolves L0 Abstract tier from frontmatter summary', () => {
      const { stdout, status } = runCli(['read', 'viking://research/mobile-websocket-heartbeats', 'L0']);
      expect(status).toBe(0);
      expect(stdout).toContain('[L0 ABSTRACT]');
      expect(stdout).toContain('Implements adaptive ping-pong timers');
    });

    test('read command resolves L0 Abstract tier from frontmatter purpose fallback', () => {
      const { stdout, status } = runCli(['read', 'viking://architecture/event-bridge-routing', 'L0']);
      expect(status).toBe(0);
      expect(stdout).toContain('[L0 ABSTRACT] Purpose: Centralizes event dispatching');
    });

    test('read command resolves L0 Abstract tier falling back to first sentence for plain docs', () => {
      const { stdout, status } = runCli(['read', 'viking://concepts/sqlite-wal-concurrency', 'L0']);
      expect(status).toBe(0);
      expect(stdout).toContain('[L0 ABSTRACT]');
      expect(stdout).toContain('SQLite Write-Ahead Logging allows simultaneous reader processes');
    });

    test('read command resolves L1 Overview extracting structure and AST signatures while stripping implementation bodies', () => {
      const { stdout, status } = runCli(['read', 'viking://research/mobile-websocket-heartbeats', 'L1']);
      expect(status).toBe(0);
      expect(stdout).toContain('# Mobile WebSocket Heartbeats');
      expect(stdout).toContain('## Architectural Objectives');
      expect(stdout).toContain('## Interface Specifications');
      expect(stdout).toContain('* Maintain sub-second reconnection latency.');
      expect(stdout).toContain('1. Exponential backoff retry with jitter.');

      // Interface and method signatures preserved
      expect(stdout).toContain('export interface HeartbeatConfig');
      expect(stdout).toContain('export class HeartbeatManager');
      expect(stdout).toContain('constructor(private readonly config: HeartbeatConfig)');
      expect(stdout).toContain('public async startHeartbeat(): Promise<void>');
      expect(stdout).toContain('public async reconnect(): Promise<void>');
      expect(stdout).toContain('public stopHeartbeat(): void');

      // Internal execution loops stripped
      expect(stdout).not.toContain('const rawBuffer = Buffer.alloc');
      expect(stdout).not.toContain('Heartbeat loop payload');
      expect(stdout).not.toContain('initiating reconnect');
    });

    test('read command resolves L2 Detail with bit-for-bit full original content', () => {
      const { stdout, status } = runCli(['read', 'viking://research/mobile-websocket-heartbeats', 'L2']);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe(sampleDoc1.content.trim());
    });

    test('search command performs FTS5 BM25 search', () => {
      const { stdout, status } = runCli(['search', 'heartbeats']);
      expect(status).toBe(0);
      expect(stdout).toContain('viking://research/mobile-websocket-heartbeats');
    });
  });

  describe('Token Savings & Compression Benchmark', () => {
    test('measures and asserts significant token reduction on L0 and L1 versus L2', () => {
      const l2Res = runCli(['read', 'viking://research/mobile-websocket-heartbeats', 'L2']);
      const l1Res = runCli(['read', 'viking://research/mobile-websocket-heartbeats', 'L1']);
      const l0Res = runCli(['read', 'viking://research/mobile-websocket-heartbeats', 'L0']);

      const l2Content = l2Res.stdout;
      const l1Content = l1Res.stdout;
      const l0Content = l0Res.stdout;

      const l2Tokens = Math.ceil(l2Content.length / 4);
      const l1Tokens = Math.ceil(l1Content.length / 4);
      const l0Tokens = Math.ceil(l0Content.length / 4);

      const l1SavingsPct = ((l2Tokens - l1Tokens) / l2Tokens) * 100;
      const l0SavingsPct = ((l2Tokens - l0Tokens) / l2Tokens) * 100;

      console.log('\n=== Token Compression Benchmark Results ===');
      console.log(`L2 (Full Detail): ~${l2Tokens} tokens (${l2Content.length} bytes)`);
      console.log(`L1 (Overview):    ~${l1Tokens} tokens (${l1Content.length} bytes) -> ${l1SavingsPct.toFixed(1)}% reduction`);
      console.log(`L0 (Abstract):    ~${l0Tokens} tokens (${l0Content.length} bytes) -> ${l0SavingsPct.toFixed(1)}% reduction`);

      // Verify benchmark constraints
      expect(l1SavingsPct).toBeGreaterThanOrEqual(40);
      expect(l0SavingsPct).toBeGreaterThanOrEqual(80);
    });
  });

  describe('Stdio MCP Server JSON-RPC Protocol', () => {
    let serverProcess: ChildProcess;
    let rl: readline.Interface;
    let requestId = 1;

    function sendRpc(msg: any): Promise<any> {
      return new Promise((resolve) => {
        const id = msg.id ?? ++requestId;
        msg.id = id;

        const onLine = (line: string) => {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              rl.removeListener('line', onLine);
              resolve(parsed);
            }
          } catch {}
        };

        rl.on('line', onLine);
        serverProcess.stdin?.write(JSON.stringify(msg) + '\n');
      });
    }

    beforeAll((done) => {
      serverProcess = spawn('node', ['viking-vfs-mount.mjs', '--mcp'], {
        cwd: process.cwd(),
        env: { ...process.env, KB_CACHE_DB: TEST_DB_PATH }
      });

      rl = readline.createInterface({
        input: serverProcess.stdout!,
        terminal: false
      });

      setTimeout(done, 500);
    });

    afterAll(() => {
      rl.close();
      serverProcess.kill();
    });

    test('handles initialize handshake', async () => {
      const res = await sendRpc({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {}
      });

      expect(res.result).toBeDefined();
      expect(res.result.protocolVersion).toBe('2024-11-05');
      expect(res.result.serverInfo.name).toBe('viking-vfs-mount');
    });

    test('lists available tools under tools/list', async () => {
      const res = await sendRpc({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {}
      });

      expect(res.result.tools).toBeDefined();
      const toolNames = res.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('vfs_list_dir');
      expect(toolNames).toContain('vfs_read_file');
      expect(toolNames).toContain('vfs_search');
    });

    test('executes vfs_list_dir tool call returning L0 abstracts', async () => {
      const res = await sendRpc({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'vfs_list_dir',
          arguments: {}
        }
      });

      expect(res.result.content).toBeDefined();
      const docs = JSON.parse(res.result.content[0].text);
      expect(docs.length).toBe(3);
      expect(docs[0].abstract).toContain('[L0 ABSTRACT]');
    });

    test('executes vfs_read_file tool call for L1 overview tier', async () => {
      const res = await sendRpc({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'vfs_read_file',
          arguments: {
            uri: 'viking://research/mobile-websocket-heartbeats',
            tier: 'L1'
          }
        }
      });

      expect(res.result.content).toBeDefined();
      const text = res.result.content[0].text;
      expect(text).toContain('# Mobile WebSocket Heartbeats');
      expect(text).toContain('export class HeartbeatManager');
      expect(text).not.toContain('Heartbeat loop payload');
    });

    test('executes vfs_search tool call', async () => {
      const res = await sendRpc({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'vfs_search',
          arguments: {
            query: 'heartbeats',
            limit: 2
          }
        }
      });

      expect(res.result.content).toBeDefined();
      const results = JSON.parse(res.result.content[0].text);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].uri).toContain('mobile-websocket-heartbeats');
    });
  });
});
