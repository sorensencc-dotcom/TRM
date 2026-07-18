import { spawnSync } from 'node:child_process';
import { ExtractionRunner } from './types';
import { Fact } from '../scoring/types';
import { SourceEntry } from '../core/sourceIngest';
import { validateAgainstSchema } from '../schemas/validator';
import { buildExtractPrompt } from './prompts/extractFacts';

export interface ClaudeCliExec {
  (args: string[], input: string): { stdout: string; status: number | null };
}

const CLAUDE_BIN = process.platform === 'win32' ? 'claude.cmd' : 'claude';

function defaultExec(args: string[], input: string): { stdout: string; status: number | null } {
  const result = spawnSync(CLAUDE_BIN, args, { input, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', status: result.status };
}

interface RawExtractedFact {
  text: string;
  confidence: number;
  categories: string[];
}

interface RawExtractResult {
  facts?: RawExtractedFact[];
  summary?: string;
}

interface ClaudeCliEnvelope {
  result?: string;
  is_error?: boolean;
}

export function createClaudeCodeRunner(exec: ClaudeCliExec = defaultExec): ExtractionRunner {
  return {
    run(source: SourceEntry, rawText: string): { facts: Fact[]; summary: string } {
      const prompt = buildExtractPrompt(source.title);
      const { stdout, status } = exec(['-p', prompt, '--output-format', 'json', '--model', 'sonnet'], rawText);

      if (status !== 0) {
        throw new Error(`claude CLI exited with status ${status}`);
      }

      let envelope: ClaudeCliEnvelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        throw new Error(`claude CLI output was not valid JSON: ${stdout.slice(0, 200)}`);
      }

      if (envelope.is_error) {
        throw new Error(`claude CLI reported an error: ${envelope.result}`);
      }

      if (typeof envelope.result !== 'string') {
        throw new Error('claude CLI envelope had no "result" string field');
      }

      let parsed: RawExtractResult;
      try {
        parsed = JSON.parse(envelope.result);
      } catch {
        throw new Error(`claude CLI result was not valid JSON: ${envelope.result.slice(0, 200)}`);
      }

      if (!Array.isArray(parsed.facts)) {
        throw new Error('claude CLI result had no "facts" array');
      }
      if (typeof parsed.summary !== 'string') {
        throw new Error('claude CLI result had no "summary" string');
      }

      const facts: Fact[] = parsed.facts.map((f, i) => ({
        id: `FCT-${String(i + 1).padStart(3, '0')}`,
        text: f.text,
        source_id: source.id,
        confidence: f.confidence,
        categories: f.categories,
      }));

      const validation = validateAgainstSchema('extract', { facts });
      if (!validation.valid) {
        throw new Error(`claudeCodeRunner produced invalid facts: ${validation.errors.join('; ')}`);
      }

      return { facts, summary: parsed.summary };
    },
  };
}

export const claudeCodeRunner = createClaudeCodeRunner();
