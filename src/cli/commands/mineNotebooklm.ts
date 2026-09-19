import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { queryNotebook } from '../../notebooklm/nlmCli';
import { readRegistry, findNotebook, flushMinedState, upsertResearchQueueEntry } from '../../notebooklm/registry';
import { writeFileAtomic } from '../../core/atomicWrite';
import { slugifyTitle } from '../../notebooklm/stagingName';
import { loadConfig } from '../../core/config';

export interface MiningQuestion {
  id: string;
  text: string;
}

const URGENCY_PATTERNS = [/needs verification/i, /recommend investigating/i, /no source found/i];

export function isUrgentAnswer(answer: string): boolean {
  return URGENCY_PATTERNS.some((p) => p.test(answer));
}

export function loadMiningQuestions(): MiningQuestion[] {
  const configPath = path.resolve(__dirname, '../../../config/mining-questions.json');
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { questions: MiningQuestion[] };
  return parsed.questions;
}

export function answerKey(notebookId: string, questionId: string, answer: string): string {
  const answerHash = crypto.createHash('sha256').update(answer, 'utf-8').digest('hex');
  return `${notebookId}:${questionId}:${answerHash}`;
}

function docPathFor(root: string, notebookSlug: string): string {
  return path.join('trm', 'research-gaps', `${notebookSlug}.md`);
}

function upsertDocRow(root: string, relativeDocPath: string, question: MiningQuestion, answer: string, notebookTitle: string, key: string): void {
  const absPath = path.join(root, relativeDocPath);
  const exists = fs.existsSync(absPath);
  const header = '| Question | Answer excerpt | Notebook | First-seen date | Entry key |\n|---|---|---|---|---|\n';
  const excerpt = answer.length > 200 ? `${answer.slice(0, 200)}...` : answer;
  const newRow = `| ${question.text} | ${excerpt.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${notebookTitle} | ${new Date().toISOString().slice(0, 10)} | ${key} |`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  if (!exists) {
    writeFileAtomic(absPath, `# Research Gaps: ${notebookTitle}\n\n${header}${newRow}\n`);
    return;
  }

  const existingContent = fs.readFileSync(absPath, 'utf-8');
  const lines = existingContent.split(/\r?\n/);

  // Match existing row for this specific question
  const questionPrefix = `| ${question.text} |`;
  const existingIdx = lines.findIndex((l) => l.startsWith(questionPrefix));

  if (existingIdx !== -1) {
    lines[existingIdx] = newRow;
  } else {
    // Append to table
    lines.push(newRow);
  }

  const cleaned = lines.filter((l, idx) => idx < lines.length - 1 || l.trim().length > 0).join('\n').trimEnd() + '\n';
  writeFileAtomic(absPath, cleaned);
}

function appendTodoIfUrgent(root: string, answer: string, question: MiningQuestion, key: string): void {
  if (!isUrgentAnswer(answer)) return;

  const todosPath = path.join(root, 'TODOS.md');
  const content = fs.existsSync(todosPath) ? fs.readFileSync(todosPath, 'utf-8') : '# TODOS\n\n## Open\n\n## Completed\n';
  if (content.includes(key) || content.includes(question.text)) return; // idempotent across Open + Completed

  const line = `- [ ] ${question.text} -- ${answer.slice(0, 150)} (${key})\n`;
  const openMarker = '## Open\n';
  const idx = content.indexOf(openMarker);
  const updated =
    idx === -1
      ? `${content}\n## Open\n${line}`
      : `${content.slice(0, idx + openMarker.length)}${line}${content.slice(idx + openMarker.length)}`;
  writeFileAtomic(todosPath, updated);
}

export function appendStalledTodo(root: string, questionText: string, gapKey: string): void {
  const todosPath = path.join(root, 'TODOS.md');
  const content = fs.existsSync(todosPath) ? fs.readFileSync(todosPath, 'utf-8') : '# TODOS\n\n## Open\n\n## Completed\n';
  if (content.includes(gapKey)) return;

  const line = `- [ ] [STALLED] ${questionText} -- research dispatched repeatedly, gap still unresolved (${gapKey})\n`;
  const openMarker = '## Open\n';
  const idx = content.indexOf(openMarker);
  const updated =
    idx === -1
      ? `${content}\n## Open\n${line}`
      : `${content.slice(0, idx + openMarker.length)}${line}${content.slice(idx + openMarker.length)}`;
  writeFileAtomic(todosPath, updated);
}

export interface AtomicGapItem {
  id: string;
  title: string;
  text: string;
  key: string;
}

export function extractAtomicGaps(
  notebookId: string,
  questionId: string,
  rawAnswer: string
): AtomicGapItem[] {
  const lines = rawAnswer.split(/\r?\n/);
  const items: AtomicGapItem[] = [];

  let currentItemLines: string[] = [];

  function flushCurrent() {
    if (currentItemLines.length === 0) return;
    const text = currentItemLines.join('\n').trim();
    currentItemLines = [];
    if (text.length < 15) return;

    const normalizedHeader = text.replace(/^[#\d.\s:-]+/, '').trim().toLowerCase();
    if (/^(?:open\s+contradictions?|unresolved\s+contradictions?|under-?sourced(?:\s+claims|\s+assertions)?|adjacent\s+topics?|adjacent\s+research\s+leads?|follow-?up(?:\s+research|\s+tracks?)?)$/i.test(normalizedHeader)) {
      return;
    }

    const boldMatch = text.match(/^\*\*([^*]+)\*\*:?\s*(.*)$/s);
    let title = '';
    if (boldMatch) {
      title = boldMatch[1].trim();
    } else {
      const fullBlock = text.replace(/\r?\n/g, ' ').trim();
      const parts = fullBlock.split(/(?<=[.?!])\s+/);
      const firstSentence = (parts.length > 0 && parts[0].trim().length > 0) ? parts[0].trim() : fullBlock.slice(0, 50);
      title = firstSentence.length > 50 ? `${firstSentence.slice(0, 47)}...` : firstSentence;
    }

    const fullBlock = text.replace(/\r?\n/g, ' ').trim();
    const itemHash = crypto.createHash('sha256').update(fullBlock, 'utf-8').digest('hex');
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'gap';
    const key = `${notebookId}:${questionId}:${itemHash}`;

    items.push({
      id: slug,
      title,
      text: fullBlock,
      key,
    });
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const isListItem = /^(?:[-*+]|\d+[.)])\s+/.test(trimmed);
    const isHeader = /^#{1,6}\s+/.test(trimmed);

    if (isListItem || isHeader) {
      flushCurrent();
      const cleanedLine = trimmed.replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, '').trim();
      currentItemLines.push(cleanedLine);
    } else if (trimmed.length > 0) {
      if (currentItemLines.length > 0) {
        currentItemLines.push(trimmed);
      }
    } else {
      flushCurrent();
    }
  }
  flushCurrent();

  if (items.length === 0 && rawAnswer.trim().length >= 10) {
    const fullBlock = rawAnswer.replace(/\r?\n/g, ' ').trim();
    const itemHash = crypto.createHash('sha256').update(fullBlock, 'utf-8').digest('hex');
    const parts = fullBlock.split(/(?<=[.?!])\s+/);
    const firstSentence = (parts.length > 0 && parts[0].trim().length > 0) ? parts[0].trim() : fullBlock.slice(0, 50);
    const title = firstSentence.length > 50 ? `${firstSentence.slice(0, 47)}...` : firstSentence;
    items.push({
      id: questionId,
      title,
      text: fullBlock,
      key: `${notebookId}:${questionId}:${itemHash}`,
    });
  }

  return items;
}

function appendResearchGapsMatrix(root: string, question: MiningQuestion, answer: string, notebookTitle: string, key: string): void {
  const candidatePaths = [
    path.join(root, 'trm-research-gaps.md'),
    path.resolve(root, '..', 'dev', 'kb-sync', 'trm-research-gaps.md'),
    path.resolve('C:\\dev\\kb-sync\\trm-research-gaps.md'),
  ];
  const gapsPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!gapsPath) return;

  const content = fs.readFileSync(gapsPath, 'utf-8');
  const notebookId = key.includes(':') ? key.split(':')[0] : key;
  const items = extractAtomicGaps(notebookId, question.id, answer);

  const linesToAdd: string[] = [];
  for (const item of items) {
    const gapTag = `**${notebookTitle} (${question.id} - ${item.title})**`;
    const itemSnippet = item.text.slice(0, 80).replace(/[[\]()#*]/g, '').trim();
    if (content.includes(gapTag) || (itemSnippet.length > 30 && content.includes(itemSnippet))) {
      continue;
    }
    const excerpt = item.text.replace(/\r?\n/g, ' ').slice(0, 180).trim();
    linesToAdd.push(`- [ ] ${gapTag}: ${excerpt}\n`);
  }

  if (linesToAdd.length === 0) return;

  const marker = '## Active Research Gaps\n';
  const idx = content.indexOf(marker);
  const block = linesToAdd.join('');
  const updated =
    idx === -1
      ? `${content}\n\n## Active Research Gaps\n\n${block}`
      : `${content.slice(0, idx + marker.length)}\n${block}${content.slice(idx + marker.length)}`;
  writeFileAtomic(gapsPath, updated);
}

function triggerGapTriage(root: string): void {
  const candidateScripts = [
    path.join(root, 'scripts', 'trm-triage.mjs'),
    path.resolve(root, '..', 'dev', 'kb-sync', 'scripts', 'trm-triage.mjs'),
    path.resolve('C:\\dev\\kb-sync\\scripts\\trm-triage.mjs'),
  ];
  const scriptPath = candidateScripts.find((p) => fs.existsSync(p));
  if (!scriptPath) return;

  try {
    spawnSync(process.execPath, [scriptPath], {
      cwd: path.dirname(path.dirname(scriptPath)),
      stdio: 'ignore',
    });
  } catch {
    // Fail-soft: triage error must not break mining run
  }
}

function uploadResearchGapsSource(root: string, notebookId: string, relativeDocPath: string): void {
  const absPath = path.join(root, relativeDocPath);
  if (!fs.existsSync(absPath)) return;

  try {
    const title = 'TRM Research Gaps & Synthesis';
    const nlmBin = 'nlm';
    const baseName = path.basename(absPath).toLowerCase();

    // Query existing sources in target notebook to find previous versions of this gaps source
    let existingSources: Array<{ id: string; title?: string; name?: string }> = [];
    try {
      const listProc = process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', nlmBin, 'source', 'list', notebookId, '--json'], { encoding: 'utf-8' })
        : spawnSync(nlmBin, ['source', 'list', notebookId, '--json'], { encoding: 'utf-8' });

      if (listProc.status === 0 && listProc.stdout) {
        const parsed = JSON.parse(listProc.stdout);
        existingSources = Array.isArray(parsed) ? parsed : (parsed.sources || []);
      }
    } catch {
      // Fail-soft: continue if listing fails
    }

    const staleSources = existingSources.filter((s) => {
      const sTitle = (s.title || s.name || '').toLowerCase().trim();
      return sTitle === title.toLowerCase() || sTitle === baseName;
    });

    // Add fresh source before deleting older versions. Preserve an existing
    // source when a transient upload failure occurs.
    const addProc = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', nlmBin, 'source', 'add', notebookId, '--file', absPath, '--title', title, '--wait'], {
        encoding: 'utf-8',
        })
      : spawnSync(nlmBin, ['source', 'add', notebookId, '--file', absPath, '--title', title, '--wait'], {
        encoding: 'utf-8',
      });

    // Purge stale previous versions
    if (addProc.status === 0 && staleSources.length > 0) {
      const ids = staleSources.map((s) => s.id);
      if (process.platform === 'win32') {
        spawnSync('cmd.exe', ['/d', '/s', '/c', nlmBin, 'source', 'delete', ...ids, '-y'], {
          encoding: 'utf-8',
        });
      } else {
        spawnSync(nlmBin, ['source', 'delete', ...ids, '-y'], {
          encoding: 'utf-8',
        });
      }
    }
  } catch {
    // Fail-soft: upload error must not fail mining run
  }
}

export function runMineNotebooklm(root: string, notebookId: string, _opts: { topic?: string }): { newEntries: number; docPath: string } {
  const registry = readRegistry(root);
  const entry = findNotebook(registry, notebookId);
  if (!entry) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }
  // loadConfig requires config.json to exist in the vault root (root) -- see
  // src/core/config.ts loadConfig; there is no fallback/default when it's missing.
  const config = loadConfig(root);

  const questions = loadMiningQuestions();
  const relativeDocPath = docPathFor(root, slugifyTitle(entry.title));
  const seenKeys = new Set(entry.last_mined_answer_keys);
  let newEntries = 0;
  let anySuccess = false;

  for (const question of questions) {
    const result = queryNotebook(notebookId, question.text);
    if (!result.ok) continue;
    anySuccess = true;

    const key = answerKey(notebookId, question.id, result.data);
    if (seenKeys.has(key)) continue;

    upsertDocRow(root, relativeDocPath, question, result.data, entry.title, key);
    appendTodoIfUrgent(root, result.data, question, key);
    appendResearchGapsMatrix(root, question, result.data, entry.title, key);
    if (isUrgentAnswer(result.data)) {
      upsertResearchQueueEntry(root, notebookId, question, key, config.dispatch_limits.default_mode);
    }
    seenKeys.add(key);
    newEntries++;
  }

  // Only persist registry state (and bump last_mined_at) when we actually
  // talked to the notebook successfully at least once this run. If every
  // queryNotebook call failed, leave the registry untouched so this
  // notebook is retried fully -- not silently marked as freshly mined --
  // next run.
  if (anySuccess) {
    flushMinedState(root, notebookId, Array.from(seenKeys), new Date().toISOString());
    if (newEntries > 0) {
      triggerGapTriage(root);
      uploadResearchGapsSource(root, notebookId, relativeDocPath);
    }
  }

  return { newEntries, docPath: relativeDocPath };
}

