import { createHash } from 'node:crypto';

export interface SourceRevision {
  sourceId: string;
  revision: string;
  text: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

export function validateResearchResult(
  candidate: unknown,
  resolveSource: (sourceId: string) => SourceRevision | null,
): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(candidate) || candidate.schema !== 'research.result.v1') {
    return { valid: false, errors: ['unsupported or malformed research result schema'] };
  }

  if (candidate.status === 'failed') return { valid: true, errors: [] };

  const findings = candidate.payload?.findings;
  if (!Array.isArray(findings)) return { valid: false, errors: ['payload.findings must be an array'] };

  for (const finding of findings) {
    const sourceId = finding?.source_id;
    const span = finding?.source_span;
    const stored = typeof sourceId === 'string' ? resolveSource(sourceId) : null;
    if (!stored) {
      errors.push(`source not found: ${String(sourceId)}`);
      continue;
    }
    if (finding.source_revision !== stored.revision) {
      errors.push('source revision does not match stored source');
      continue;
    }
    if (!isRecord(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end < span.start || span.end > stored.text.length) {
      errors.push('source span is outside stored source bounds');
      continue;
    }
    if (span.span_hash !== sha256(stored.text.slice(span.start, span.end))) {
      errors.push('source span hash does not match stored text');
    }
  }

  return { valid: errors.length === 0, errors };
}
