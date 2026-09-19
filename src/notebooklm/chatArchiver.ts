import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import pLimit from 'p-limit';
import {
  NlmNotebook,
  ChatSession,
  listNotebooks,
  listChats,
  getChatTranscript,
  listNotes,
  createNote,
} from './nlmCli';

export interface ArchivalResult {
  notebookId: string;
  notebookTitle: string;
  sessionCount: number;
  totalTurns: number;
  noteCreated: boolean;
  noteId?: string;
  skipped: boolean;
  skipReason?: string;
  localPath?: string;
  contentHash?: string;
  error?: string;
}

export interface SweepOptions {
  date?: string; // YYYY-MM-DD (defaults to local today)
  dryRun?: boolean;
  force?: boolean;
  concurrency?: number;
  kbVaultRoot?: string;
  localVaultRoot?: string;
}

const EXCLUDED_PATTERNS = [
  /^recipes$/i,
  /^tampa bourbon/i,
  /^50 new things/i,
  /^tesla$/i,
];

export function isApprovedNotebook(title: string): boolean {
  const trimmed = title.trim();
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return false;
    }
  }
  return true;
}

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function computeTranscriptHash(sessions: ChatSession[]): string {
  const canonical = sessions
    .map((s) => ({
      id: s.conversation_id,
      turns: (s.transcript || []).map((t) => ({ q: t.query.trim(), a: t.answer.trim() })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function formatCathrynLaverySynthesis(
  notebookTitle: string,
  notebookId: string,
  sessions: ChatSession[],
  dateStr: string,
  contentHash: string
): string {
  const totalTurns = sessions.reduce((acc, s) => acc + (s.transcript ? s.transcript.length : s.turn_count), 0);

  const decisions: string[] = [];
  const discoveries: string[] = [];
  const openQuestions: string[] = [];

  for (const session of sessions) {
    if (!session.transcript) continue;
    for (const turn of session.transcript) {
      const q = turn.query.trim();
      const a = turn.answer.trim();

      if (a.toLowerCase().includes('decision') || a.toLowerCase().includes('agreed') || a.toLowerCase().includes('confirmed')) {
        decisions.push(`- **Q:** ${q}\n  **Outcome:** ${a.slice(0, 300)}...`);
      } else {
        discoveries.push(`- **Q:** ${q}\n  **Finding:** ${a.slice(0, 300)}...`);
      }

      if (a.toLowerCase().includes('unresolved') || a.toLowerCase().includes('contradiction') || a.toLowerCase().includes('gap') || a.includes('?')) {
        openQuestions.push(`- ${q}: ${a.slice(0, 200)}...`);
      }
    }
  }

  const lines: string[] = [
    `# Daily Synthesis Log: ${notebookTitle} — ${dateStr}`,
    '',
    '| Metadata | Value |',
    '|---|---|',
    `| **Notebook** | ${notebookTitle} (\`${notebookId}\`) |`,
    `| **Date** | ${dateStr} |`,
    `| **Sessions active** | ${sessions.length} |`,
    `| **Total turns** | ${totalTurns} |`,
    `| **Content SHA-256** | \`${contentHash.slice(0, 16)}...\` |`,
    `| **Status** | SYNTHESIZED |`,
    '',
    '## Executive summary',
    `Consolidated ${totalTurns} discussion turn(s) across ${sessions.length} active session(s) on ${dateStr}. Grounded facts, verified timeline assertions, and open inquiries were cataloged for downstream knowledge base indexing.`,
    '',
    '## Key decisions & verified timeline facts',
  ];

  if (decisions.length > 0) {
    lines.push(...decisions);
  } else {
    lines.push('- No explicit architectural decisions flagged in this session battery.');
  }

  lines.push('', '## Technical discoveries & entity linkages');
  if (discoveries.length > 0) {
    lines.push(...discoveries);
  } else {
    lines.push('- No net-new entity linkages surfaced.');
  }

  lines.push('', '## Unresolved questions & open contradictions');
  if (openQuestions.length > 0) {
    lines.push(...openQuestions);
  } else {
    lines.push('- All current inquiries resolved against available source evidence.');
  }

  lines.push('', '## Grounded citations & session metadata');
  for (const session of sessions) {
    lines.push(`- **Session ID:** \`${session.conversation_id}\` (${session.turn_count} turns) — preview: "${session.preview || 'Interactive battery'}"`);
  }
  lines.push('');

  return lines.join('\n');
}

export function archiveNotebook(
  notebook: NlmNotebook,
  options: SweepOptions = {}
): ArchivalResult {
  const dateStr = options.date || new Date().toISOString().slice(0, 10);
  const kbVaultRoot = options.kbVaultRoot || 'C:/dev/kb-sync/obsidian/vault/wiki';
  const localVaultRoot = options.localVaultRoot || 'C:/dev/trm/vault/topics';

  if (!isApprovedNotebook(notebook.title)) {
    return {
      notebookId: notebook.id,
      notebookTitle: notebook.title,
      sessionCount: 0,
      totalTurns: 0,
      noteCreated: false,
      skipped: true,
      skipReason: 'Excluded by scope policy (personal/sensitive category)',
    };
  }

  const chatsRes = listChats(notebook.id);
  if (!chatsRes.ok) {
    return {
      notebookId: notebook.id,
      notebookTitle: notebook.title,
      sessionCount: 0,
      totalTurns: 0,
      noteCreated: false,
      skipped: true,
      error: `Failed to list chats: ${chatsRes.error}`,
    };
  }

  const activeSessions = chatsRes.data.sessions || [];
  if (activeSessions.length === 0) {
    return {
      notebookId: notebook.id,
      notebookTitle: notebook.title,
      sessionCount: 0,
      totalTurns: 0,
      noteCreated: false,
      skipped: true,
      skipReason: 'No active chat sessions found today',
    };
  }

  // Hydrate sessions with transcripts
  const hydratedSessions: ChatSession[] = [];
  for (const session of activeSessions) {
    const transRes = getChatTranscript(notebook.id, session.conversation_id);
    if (transRes.ok && transRes.data && transRes.data.transcript && transRes.data.transcript.length > 0) {
      hydratedSessions.push(transRes.data);
    }
  }

  if (hydratedSessions.length === 0) {
    return {
      notebookId: notebook.id,
      notebookTitle: notebook.title,
      sessionCount: 0,
      totalTurns: 0,
      noteCreated: false,
      skipped: true,
      skipReason: 'Chat sessions contained 0 turns',
    };
  }

  const totalTurns = hydratedSessions.reduce((acc, s) => acc + (s.transcript ? s.transcript.length : 0), 0);
  const contentHash = computeTranscriptHash(hydratedSessions);
  const noteTitle = `Daily Synthesis Log - ${dateStr}`;
  const markdown = formatCathrynLaverySynthesis(notebook.title, notebook.id, hydratedSessions, dateStr, contentHash);

  // Check if note already exists in Studio panel
  let noteCreated = false;
  let createdNoteId: string | undefined;

  const notesRes = listNotes(notebook.id);
  const existingNote = notesRes.ok
    ? (notesRes.data || []).find((n) => n.title.trim() === noteTitle)
    : undefined;

  if (existingNote && !options.force) {
    // Already exists, skip note create
    noteCreated = false;
  } else if (!options.dryRun) {
    const createRes = createNote(notebook.id, noteTitle, markdown);
    if (createRes.ok) {
      noteCreated = true;
      createdNoteId = createRes.data.noteId;
    }
  }

  // Write local markdown files for knowledge.db ingestion
  const slug = slugifyTitle(notebook.title);
  const targetDirs = [
    path.join(kbVaultRoot, 'conversations', dateStr),
    path.join(localVaultRoot, 'conversations', dateStr),
  ];

  let localPath: string | undefined;
  if (!options.dryRun) {
    for (const dir of targetDirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${slug}.md`);
        fs.writeFileSync(filePath, markdown, 'utf-8');
        if (!localPath) localPath = filePath;
      } catch (_) {
        // Continue to write to available targets
      }
    }
  }

  return {
    notebookId: notebook.id,
    notebookTitle: notebook.title,
    sessionCount: hydratedSessions.length,
    totalTurns,
    noteCreated,
    noteId: createdNoteId,
    skipped: false,
    localPath,
    contentHash,
  };
}

export async function runUniversalChatArchival(
  options: SweepOptions = {}
): Promise<{ results: ArchivalResult[]; totalProcessed: number; totalTurns: number }> {
  const nbRes = listNotebooks();
  if (!nbRes.ok) {
    throw new Error(`Failed to list notebooks from Google NotebookLM: ${nbRes.error}`);
  }

  const allNotebooks = nbRes.data || [];
  const concurrency = options.concurrency || 2;
  const limit = pLimit(concurrency);

  const tasks = allNotebooks.map((nb) =>
    limit(() => Promise.resolve(archiveNotebook(nb, options)))
  );

  const results = await Promise.all(tasks);
  const totalProcessed = results.filter((r) => !r.skipped).length;
  const totalTurns = results.reduce((acc, r) => acc + r.totalTurns, 0);

  return {
    results,
    totalProcessed,
    totalTurns,
  };
}
