import { createClaudeCodeRunner, ClaudeCliExec } from '../../src/extraction/claudeCodeRunner';

const source = { id: 'SRC-001', type: 'text', title: 'Beats 7.3-7.4', origin: 'x', url: 'x', added_at: 't', actor: 'ACTOR-001' };

function envelope(result: string, isError = false): string {
  return JSON.stringify({ type: 'result', is_error: isError, result });
}

describe('createClaudeCodeRunner', () => {
  it('parses a valid envelope into facts with assigned id/source_id', () => {
    const exec: ClaudeCliExec = () => ({
      stdout: envelope(
        JSON.stringify({
          facts: [
            { text: 'Sorensen owned a Cuban estate.', confidence: 0.8, categories: ['history', 'geopolitics'] },
            { text: 'Castro took Havana in 1959.', confidence: 0.95, categories: ['history'] },
          ],
          summary: 'Two facts about the Cuban estate and 1959 expropriation.',
        })
      ),
      status: 0,
    });
    const runner = createClaudeCodeRunner(exec);
    const result = runner.run(source, 'raw text here');

    expect(result.facts).toHaveLength(2);
    expect(result.facts[0]).toEqual({
      id: 'FCT-001',
      text: 'Sorensen owned a Cuban estate.',
      source_id: 'SRC-001',
      confidence: 0.8,
      categories: ['history', 'geopolitics'],
    });
    expect(result.facts[1].id).toBe('FCT-002');
    expect(result.summary).toBe('Two facts about the Cuban estate and 1959 expropriation.');
  });

  it('strips a markdown code fence around the result JSON', () => {
    const raw = JSON.stringify({ facts: [{ text: 'Fenced fact.', confidence: 0.7, categories: [] }], summary: 'Fenced summary.' });
    const exec: ClaudeCliExec = () => ({
      stdout: envelope('```json\n' + raw + '\n```'),
      status: 0,
    });
    const runner = createClaudeCodeRunner(exec);
    const result = runner.run(source, 'raw text');

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].text).toBe('Fenced fact.');
    expect(result.summary).toBe('Fenced summary.');
  });

  it('argv is fixed/short (no embedded prompt), full prompt+title+text go via stdin', () => {
    let capturedArgs: string[] = [];
    let capturedInput = '';
    const exec: ClaudeCliExec = (args, input) => {
      capturedArgs = args;
      capturedInput = input;
      return { stdout: envelope(JSON.stringify({ facts: [], summary: 'empty' })), status: 0 };
    };
    const runner = createClaudeCodeRunner(exec);
    runner.run(source, 'the raw source text');

    expect(capturedArgs).toEqual(['--print', '--output-format', 'json', '--model', 'sonnet']);
    expect(capturedInput).toContain('---SOURCE---');
    expect(capturedInput).toContain('Source title: Beats 7.3-7.4');
    expect(capturedInput).toContain('the raw source text');
  });

  it('throws on non-zero exit status', () => {
    const exec: ClaudeCliExec = () => ({ stdout: '', status: 1 });
    const runner = createClaudeCodeRunner(exec);
    expect(() => runner.run(source, 'raw text')).toThrow(/status 1/);
  });

  it('throws when the envelope is not valid JSON', () => {
    const exec: ClaudeCliExec = () => ({ stdout: 'not json', status: 0 });
    const runner = createClaudeCodeRunner(exec);
    expect(() => runner.run(source, 'raw text')).toThrow(/not valid JSON/);
  });

  it('throws when is_error is true', () => {
    const exec: ClaudeCliExec = () => ({ stdout: envelope('quota exceeded', true), status: 0 });
    const runner = createClaudeCodeRunner(exec);
    expect(() => runner.run(source, 'raw text')).toThrow(/quota exceeded/);
  });

  it('throws when result is not valid JSON', () => {
    const exec: ClaudeCliExec = () => ({ stdout: envelope('not json facts'), status: 0 });
    const runner = createClaudeCodeRunner(exec);
    expect(() => runner.run(source, 'raw text')).toThrow(/result was not valid JSON/);
  });

  it('throws when a fact has a category outside the fixed vocabulary', () => {
    const exec: ClaudeCliExec = () => ({
      stdout: envelope(
        JSON.stringify({
          facts: [{ text: 'x', confidence: 0.5, categories: ['not-a-real-category'] }],
          summary: 'x',
        })
      ),
      status: 0,
    });
    const runner = createClaudeCodeRunner(exec);
    expect(() => runner.run(source, 'raw text')).toThrow(/invalid facts/);
  });
});
