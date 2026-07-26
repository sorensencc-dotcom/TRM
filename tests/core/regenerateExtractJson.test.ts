import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { markDone, markFailed, writeExtract } from '../../src/core/manifestStore';
import { regenerateExtractJson } from '../../src/core/regenerateExtractJson';
import { Fact } from '../../src/scoring/types';

describe('regenerateExtractJson', () => {
  let root: string;
  const topicPath = 'test-topic';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-regenerate-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('merges done payloads in manifest order, renumbers facts, and joins summaries', () => {
    const fact = (id: string, text: string, source_id: string): Fact => ({
      id,
      text,
      source_id,
      confidence: 0.9,
      categories: ['history'],
    });

    markDone(root, topicPath, 'hash-a', '/source/a');
    writeExtract(root, topicPath, 'hash-a', {
      facts: [fact('FCT-099', 'first', 'a'), fact('FCT-100', 'second', 'a')],
      summary: 'Summary A',
    });
    markFailed(root, topicPath, 'hash-failed', '/source/failed', 'boom');
    writeExtract(root, topicPath, 'hash-failed', {
      facts: [fact('FCT-001', 'must be skipped', 'failed')],
      summary: 'Must be skipped',
    });
    markDone(root, topicPath, 'hash-b', '/source/b');
    writeExtract(root, topicPath, 'hash-b', {
      facts: [fact('FCT-001', 'third', 'b')],
      summary: 'Summary B',
    });

    regenerateExtractJson(root, topicPath);

    const extractsDir = path.join(root, 'topics', topicPath, 'extracts');
    expect(JSON.parse(fs.readFileSync(path.join(extractsDir, 'extract.json'), 'utf8'))).toEqual({
      facts: [
        fact('FCT-001', 'first', 'a'),
        fact('FCT-002', 'second', 'a'),
        fact('FCT-003', 'third', 'b'),
      ],
    });
    expect(fs.readFileSync(path.join(extractsDir, 'summary.md'), 'utf8')).toBe('Summary A\n\nSummary B');
  });
});
