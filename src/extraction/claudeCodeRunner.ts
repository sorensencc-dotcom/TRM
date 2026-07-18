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
  // On Windows, spawnSync can't exec a .cmd wrapper directly (EINVAL) and shell:true
  // mangles args containing spaces/quotes/& (broken concatenation-only escaping, not
  // real quoting). Route through cmd.exe /c with an args array instead. This is safe
  // here specifically because `args` is always the fixed, short, single-token flag
  // list below -- the multi-line prompt+source content goes entirely through `input`
  // (stdin), which is never touched by cmd.exe's command-line parsing.
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', CLAUDE_BIN, ...args], { input, encoding: 'utf-8' })
      : spawnSync(CLAUDE_BIN, args, { input, encoding: 'utf-8' });
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

// The model sometimes wraps its JSON answer in a markdown code fence despite the
// prompt's "no prose outside the JSON" instruction. Strip a fence if present;
// otherwise return the text unchanged so a genuinely bare JSON result still parses.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

export function createClaudeCodeRunner(exec: ClaudeCliExec = defaultExec): ExtractionRunner {
  return {
    run(source: SourceEntry, rawText: string): { facts: Fact[]; summary: string } {
      const prompt = buildExtractPrompt();
      const stdinPayload = `${prompt}\n\n---SOURCE---\n\nSource title: ${source.title}\n\n${rawText}`;
      const { stdout, status } = exec(['--print', '--output-format', 'json', '--model', 'sonnet'], stdinPayload);

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
        parsed = JSON.parse(stripCodeFence(envelope.result));
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
