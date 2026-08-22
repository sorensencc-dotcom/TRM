import { createHash } from 'node:crypto';
import { validateResearchResult, SourceRevision } from '../../src/protocol/researchResultValidator';

function source(text: string): SourceRevision {
  return {
    sourceId: 'SRC-101',
    revision: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    text,
  };
}

function result(text: string, start: number, end: number) {
  const span = text.slice(start, end);
  return {
    schema: 'research.result.v1',
    task_id: 'TASK-1',
    run_id: 'RUN-1',
    status: 'completed',
    producer: { engine: 'TorqueQuery', provider: 'notebooklm', model: 'test', prompt_version: 'v1' },
    payload: {
      target_claim_ids: ['C-014'],
      findings: [{
        type: 'contradiction',
        source_id: 'SRC-101',
        source_revision: source(text).revision,
        source_span: {
          start,
          end,
          span_hash: `sha256:${createHash('sha256').update(span, 'utf8').digest('hex')}`,
        },
        confidence: 0.88,
        rationale: 'Direct evidence.',
      }],
    },
    requires_approval: true,
  };
}

describe('validateResearchResult', () => {
  it('accepts a result whose citation matches the immutable source revision and span hash', () => {
    const text = 'The event occurred in Detroit in 1912.';
    const checked = validateResearchResult(result(text, 0, 34), () => source(text));
    expect(checked.valid).toBe(true);
    expect(checked.errors).toEqual([]);
  });

  it('rejects a citation with a stale source revision', () => {
    const text = 'The event occurred in Detroit in 1912.';
    const candidate = result(text, 0, 10);
    candidate.payload.findings[0].source_revision = 'sha256:stale';
    const checked = validateResearchResult(candidate, () => source(text));
    expect(checked.valid).toBe(false);
    expect(checked.errors).toContain('source revision does not match stored source');
  });

  it('rejects a citation whose span hash does not match stored text', () => {
    const text = 'The event occurred in Detroit in 1912.';
    const candidate = result(text, 0, 10);
    candidate.payload.findings[0].source_span.span_hash = 'sha256:wrong';
    const checked = validateResearchResult(candidate, () => source(text));
    expect(checked.valid).toBe(false);
    expect(checked.errors).toContain('source span hash does not match stored text');
  });

  it('rejects a citation outside source bounds', () => {
    const text = 'Short source.';
    const candidate = result(text, 0, 5);
    candidate.payload.findings[0].source_span.end = 999;
    const checked = validateResearchResult(candidate, () => source(text));
    expect(checked.valid).toBe(false);
    expect(checked.errors).toContain('source span is outside stored source bounds');
  });
  it('rejects null, primitive, and wrong-schema candidates', () => {
    expect(validateResearchResult(null, () => null).valid).toBe(false);
    expect(validateResearchResult('bad', () => null).valid).toBe(false);
    expect(validateResearchResult({ schema: 'research.result.v2' }, () => null).valid).toBe(false);
  });

  it('rejects missing or non-array findings', () => {
    const base = result('source text', 0, 6) as any;
    expect(validateResearchResult({ ...base, payload: {} }, () => null).errors).toContain('payload.findings must be an array');
    expect(validateResearchResult({ ...base, payload: { findings: {} } }, () => null).errors).toContain('payload.findings must be an array');
  });

  it('collects errors across multiple invalid findings', () => {
    const text = 'source text';
    const base = result(text, 0, 6) as any;
    base.payload.findings.push({ ...base.payload.findings[0], source_id: 'MISSING' });
    const checked = validateResearchResult(base, (id) => id === 'SRC-101' ? source(text) : null);
    expect(checked.valid).toBe(false);
    expect(checked.errors).toHaveLength(1);
    expect(checked.errors[0]).toContain('source not found');
  });

  it('accepts a zero-length span and rejects a negative start', () => {
    const text = 'source text';
    const empty = result(text, 2, 2) as any;
    expect(validateResearchResult(empty, () => source(text)).valid).toBe(true);
    const negative = result(text, 0, 2) as any;
    negative.payload.findings[0].source_span.start = -1;
    expect(validateResearchResult(negative, () => source(text)).errors).toContain('source span is outside stored source bounds');
  });

  it('accepts a failed result without requiring findings', () => {
    const failed = { schema: 'research.result.v1', status: 'failed', payload: { error: 'provider timeout' } };
    expect(validateResearchResult(failed, () => null)).toEqual({ valid: true, errors: [] });
  });
});
