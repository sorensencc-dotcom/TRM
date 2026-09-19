import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isApprovedNotebook,
  slugifyTitle,
  computeTranscriptHash,
  formatCathrynLaverySynthesis,
  archiveNotebook,
  runUniversalChatArchival,
} from './chatArchiver';
import * as nlmCli from './nlmCli';

jest.mock('./nlmCli');
const mockNlmCli = nlmCli as jest.Mocked<typeof nlmCli>;

describe('chatArchiver', () => {
  const tmpDir = path.join(__dirname, '__test_tmp__');

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('isApprovedNotebook', () => {
    it('approves technical, operational, and research notebooks', () => {
      expect(isApprovedNotebook('CIC - Willow Run & Aviation Engineering')).toBe(true);
      expect(isApprovedNotebook('KB - Operations')).toBe(true);
      expect(isApprovedNotebook('AI-Ideas')).toBe(true);
      expect(isApprovedNotebook('Sigil Protocol & Federation')).toBe(true);
    });

    it('rejects sensitive/personal notebooks', () => {
      expect(isApprovedNotebook('Recipes')).toBe(false);
      expect(isApprovedNotebook('Tampa Bourbon Hunting')).toBe(false);
      expect(isApprovedNotebook('50 New Things Your iPhone Can Do in iOS 27')).toBe(false);
    });
  });

  describe('slugifyTitle', () => {
    it('generates clean URL/file slugs', () => {
      expect(slugifyTitle('CIC - Willow Run & Aviation Engineering')).toBe('cic-willow-run-aviation-engineering');
      expect(slugifyTitle('KB - Operations')).toBe('kb-operations');
    });
  });

  describe('computeTranscriptHash', () => {
    it('computes deterministic SHA-256 hash across turns', () => {
      const sessions: nlmCli.ChatSession[] = [
        {
          conversation_id: 'conv-1',
          turn_count: 1,
          transcript: [{ turn: 1, query: 'What is X?', answer: 'X is Y.' }],
        },
      ];
      const hash1 = computeTranscriptHash(sessions);
      const hash2 = computeTranscriptHash(sessions);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe('formatCathrynLaverySynthesis', () => {
    it('renders structured markdown with Cathryn Lavery rubric', () => {
      const sessions: nlmCli.ChatSession[] = [
        {
          conversation_id: 'conv-1',
          turn_count: 2,
          preview: 'Discussion about architecture',
          transcript: [
            { turn: 1, query: 'What is the decision on database caching?', answer: 'We agreed and confirmed SQLite FTS5 for knowledge.db.' },
            { turn: 2, query: 'Are there unresolved questions?', answer: 'Is the webhook latency gap unresolved?' },
          ],
        },
      ];

      const md = formatCathrynLaverySynthesis('KB - Operations', 'nb-1', sessions, '2026-09-19', 'abc123hash');

      expect(md).toContain('# Daily Synthesis Log: KB - Operations — 2026-09-19');
      expect(md).toContain('## Executive summary');
      expect(md).toContain('## Key decisions & verified timeline facts');
      expect(md).toContain('SQLite FTS5 for knowledge.db');
      expect(md).toContain('## Unresolved questions & open contradictions');
      expect(md).toContain('webhook latency gap');
      expect(md).toContain('## Grounded citations & session metadata');
    });
  });

  describe('archiveNotebook', () => {
    it('skips excluded notebooks', () => {
      const result = archiveNotebook(
        { id: 'nb-recipes', title: 'Recipes' },
        { kbVaultRoot: tmpDir, localVaultRoot: tmpDir }
      );
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('Excluded by scope policy');
    });

    it('skips notebooks with 0 active chat sessions', () => {
      mockNlmCli.listChats.mockReturnValue({
        ok: true,
        data: { notebook_id: 'nb-1', sessions: [] },
      });

      const result = archiveNotebook(
        { id: 'nb-1', title: 'KB - Operations' },
        { kbVaultRoot: tmpDir, localVaultRoot: tmpDir }
      );
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('No active chat sessions');
    });

    it('archives active sessions, pins note, and writes markdown', () => {
      mockNlmCli.listChats.mockReturnValue({
        ok: true,
        data: {
          notebook_id: 'nb-1',
          sessions: [{ conversation_id: 'conv-1', turn_count: 1 }],
        },
      });

      mockNlmCli.getChatTranscript.mockReturnValue({
        ok: true,
        data: {
          conversation_id: 'conv-1',
          turn_count: 1,
          transcript: [{ turn: 1, query: 'How does KB Operations work?', answer: 'It manages telemetry and runbooks.' }],
        },
      });

      mockNlmCli.listNotes.mockReturnValue({
        ok: true,
        data: [],
      });

      mockNlmCli.createNote.mockReturnValue({
        ok: true,
        data: { noteId: 'note-123' },
      });

      const result = archiveNotebook(
        { id: 'nb-1', title: 'KB - Operations' },
        { kbVaultRoot: tmpDir, localVaultRoot: tmpDir, date: '2026-09-19' }
      );

      expect(result.skipped).toBe(false);
      expect(result.totalTurns).toBe(1);
      expect(result.noteCreated).toBe(true);
      expect(result.noteId).toBe('note-123');

      expect(mockNlmCli.createNote).toHaveBeenCalledWith(
        'nb-1',
        'Daily Synthesis Log - 2026-09-19',
        expect.stringContaining('# Daily Synthesis Log: KB - Operations — 2026-09-19')
      );

      const writtenFile = path.join(tmpDir, 'conversations', '2026-09-19', 'kb-operations.md');
      expect(fs.existsSync(writtenFile)).toBe(true);
    });

    it('idempotently skips note creation when note already exists', () => {
      mockNlmCli.listChats.mockReturnValue({
        ok: true,
        data: {
          notebook_id: 'nb-1',
          sessions: [{ conversation_id: 'conv-1', turn_count: 1 }],
        },
      });

      mockNlmCli.getChatTranscript.mockReturnValue({
        ok: true,
        data: {
          conversation_id: 'conv-1',
          turn_count: 1,
          transcript: [{ turn: 1, query: 'Q', answer: 'A' }],
        },
      });

      mockNlmCli.listNotes.mockReturnValue({
        ok: true,
        data: [{ id: 'existing-note-id', title: 'Daily Synthesis Log - 2026-09-19', content: '...' }],
      });

      const result = archiveNotebook(
        { id: 'nb-1', title: 'KB - Operations' },
        { kbVaultRoot: tmpDir, localVaultRoot: tmpDir, date: '2026-09-19' }
      );

      expect(result.skipped).toBe(false);
      expect(result.noteCreated).toBe(false);
      expect(mockNlmCli.createNote).not.toHaveBeenCalled();
    });
  });

  describe('runUniversalChatArchival', () => {
    it('sweeps all notebooks and returns aggregated metrics', async () => {
      mockNlmCli.listNotebooks.mockReturnValue({
        ok: true,
        data: [
          { id: 'nb-1', title: 'KB - Operations' },
          { id: 'nb-2', title: 'Recipes' },
        ],
      });

      mockNlmCli.listChats.mockReturnValue({
        ok: true,
        data: { notebook_id: 'nb-1', sessions: [] },
      });

      const sweep = await runUniversalChatArchival({
        kbVaultRoot: tmpDir,
        localVaultRoot: tmpDir,
      });

      expect(sweep.results).toHaveLength(2);
      expect(sweep.totalProcessed).toBe(0); // both skipped (1 by filter, 1 with 0 sessions)
    });
  });
});
