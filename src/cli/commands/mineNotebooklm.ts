import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { queryNotebook } from '../../notebooklm/nlmCli';
import { readRegistry, findNotebook, registryPath } from '../../notebooklm/registry';
import { writeFileAtomic } from '../../core/atomicWrite';

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

function notebookSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function appendDocRow(root: string, relativeDocPath: string, question: MiningQuestion, answer: string, notebookTitle: string, key: string): void {
  const absPath = path.join(root, relativeDocPath);
  const exists = fs.existsSync(absPath);
  const header = '| Question | Answer excerpt | Notebook | First-seen date | Entry key |\n|---|---|---|---|---|\n';
  const excerpt = answer.length > 200 ? `${answer.slice(0, 200)}...` : answer;
  const row = `| ${question.text} | ${excerpt.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${notebookTitle} | ${new Date().toISOString().slice(0, 10)} | ${key} |\n`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const existing = exists ? fs.readFileSync(absPath, 'utf-8') : `# Research Gaps: ${notebookTitle}\n\n${header}`;
  writeFileAtomic(absPath, existing + row);
}

function appendTodoIfUrgent(root: string, answer: string, question: MiningQuestion, key: string): void {
  const isUrgent = URGENCY_PATTERNS.some((p) => p.test(answer));
  if (!isUrgent) return;

  const todosPath = path.join(root, 'TODOS.md');
  const content = fs.existsSync(todosPath) ? fs.readFileSync(todosPath, 'utf-8') : '# TODOS\n\n## Open\n\n## Completed\n';
  if (content.includes(key)) return; // idempotent across Open + Completed

  const line = `- [ ] ${question.text} -- ${answer.slice(0, 150)} (${key})\n`;
  const openMarker = '## Open\n';
  const idx = content.indexOf(openMarker);
  const updated =
    idx === -1
      ? `${content}\n## Open\n${line}`
      : `${content.slice(0, idx + openMarker.length)}${line}${content.slice(idx + openMarker.length)}`;
  writeFileAtomic(todosPath, updated);
}

export function runMineNotebooklm(root: string, notebookId: string, _opts: { topic?: string }): { newEntries: number; docPath: string } {
  const registry = readRegistry(root);
  const entry = findNotebook(registry, notebookId);
  if (!entry) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }

  const questions = loadMiningQuestions();
  const relativeDocPath = docPathFor(root, notebookSlug(entry.title));
  const seenKeys = new Set(entry.last_mined_answer_keys);
  let newEntries = 0;

  for (const question of questions) {
    const result = queryNotebook(notebookId, question.text);
    if (!result.ok) continue;

    const key = answerKey(notebookId, question.id, result.data);
    if (seenKeys.has(key)) continue;

    appendDocRow(root, relativeDocPath, question, result.data, entry.title, key);
    appendTodoIfUrgent(root, result.data, question, key);
    seenKeys.add(key);
    newEntries++;
  }

  entry.last_mined_answer_keys = Array.from(seenKeys);
  entry.last_mined_at = new Date().toISOString();
  writeFileAtomic(registryPath(root), JSON.stringify(registry, null, 2));

  return { newEntries, docPath: relativeDocPath };
}
