import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { queryNotebook } from '../../notebooklm/nlmCli';
import { readRegistry, findNotebook, flushMinedState } from '../../notebooklm/registry';
import { writeFileAtomic } from '../../core/atomicWrite';
import { slugifyTitle } from '../../notebooklm/stagingName';

export interface MiningQuestion {
  id: string;
  text: string;
}

const URGENCY_PATTERNS = [/needs verification/i, /recommend investigating/i, /no source found/i];

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
  const isUrgent = URGENCY_PATTERNS.some((p) => p.test(answer));
  if (!isUrgent) return;

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

function appendResearchGapsMatrix(root: string, question: MiningQuestion, answer: string, notebookTitle: string, key: string): void {
  const candidatePaths = [
    path.join(root, 'trm-research-gaps.md'),
    path.resolve(root, '..', 'dev', 'kb-sync', 'trm-research-gaps.md'),
    path.resolve('C:\\dev\\kb-sync\\trm-research-gaps.md'),
  ];
  const gapsPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!gapsPath) return;

  const content = fs.readFileSync(gapsPath, 'utf-8');
  const gapTarget = `**${notebookTitle} (${question.id})**`;
  if (content.includes(key) || content.includes(gapTarget) || content.includes(answer.slice(0, 50))) return;

  const excerpt = answer.replace(/\r?\n/g, ' ').slice(0, 150).trim();
  const line = `- [ ] ${gapTarget}: ${excerpt}\n`;

  const marker = '## Active Research Gaps\n';
  const idx = content.indexOf(marker);
  const updated =
    idx === -1
      ? `${content}\n\n## Active Research Gaps\n\n${line}`
      : `${content.slice(0, idx + marker.length)}\n${line}${content.slice(idx + marker.length)}`;
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
    if (process.platform === 'win32') {
      spawnSync('cmd.exe', ['/d', '/s', '/c', nlmBin, 'source', 'add', notebookId, '--file', absPath, '--title', title, '--wait'], {
        encoding: 'utf-8',
      });
    } else {
      spawnSync(nlmBin, ['source', 'add', notebookId, '--file', absPath, '--title', title, '--wait'], {
        encoding: 'utf-8',
      });
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

