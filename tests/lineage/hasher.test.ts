import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendOperation, readLineage, validateChain } from '../../src/lineage/hasher';

describe('lineage hasher', () => {
  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.mkdirSync(path.join(root, 'topics', 'cuba', 'lineage'), { recursive: true });
    return root;
  }

  it('appends a first operation and chains from GENESIS', () => {
    const root = makeRoot();
    const op = appendOperation(
      root,
      'cuba',
      { op: 'INGEST', actor: 'ACTOR-001', timestamp: '2026-07-17T16:50:00', source_id: 'SRC-001' },
      { source_id: 'SRC-001' }
    );
    expect(op.id).toBe('OP-0001');
    const lineage = readLineage(root, 'cuba');
    expect(lineage.operations).toHaveLength(1);
    expect(lineage.hash).toBe(op.hash);
  });

  it('chains a second operation from the first hash', () => {
    const root = makeRoot();
    appendOperation(root, 'cuba', { op: 'INGEST', actor: 'ACTOR-001', timestamp: 't1', source_id: 'SRC-001' }, { source_id: 'SRC-001' });
    const op2 = appendOperation(root, 'cuba', { op: 'EXTRACT', actor: 'ACTOR-001', timestamp: 't2', extract_id: 'FCT-001' }, { extract_id: 'FCT-001' });
    expect(op2.id).toBe('OP-0002');
    const lineage = readLineage(root, 'cuba');
    expect(lineage.operations).toHaveLength(2);
    expect(lineage.hash).toBe(op2.hash);
    expect(op2.hash).not.toBe(lineage.operations[0].hash);
  });

  it('validates an intact chain', () => {
    const root = makeRoot();
    appendOperation(root, 'cuba', { op: 'INGEST', actor: 'ACTOR-001', timestamp: 't1', source_id: 'SRC-001' }, { source_id: 'SRC-001' });
    appendOperation(root, 'cuba', { op: 'EXTRACT', actor: 'ACTOR-001', timestamp: 't2', extract_id: 'FCT-001' }, { extract_id: 'FCT-001' });
    expect(validateChain(root, 'cuba')).toEqual({ valid: true });
  });

  it('detects a tampered chain', () => {
    const root = makeRoot();
    appendOperation(root, 'cuba', { op: 'INGEST', actor: 'ACTOR-001', timestamp: 't1', source_id: 'SRC-001' }, { source_id: 'SRC-001' });
    const lineagePath = path.join(root, 'topics', 'cuba', 'lineage', 'lineage.json');
    const lineage = JSON.parse(fs.readFileSync(lineagePath, 'utf-8'));
    lineage.operations[0].hash = 'tampered';
    fs.writeFileSync(lineagePath, JSON.stringify(lineage, null, 2));
    const result = validateChain(root, 'cuba');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/OP-0001/);
  });
});
