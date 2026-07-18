import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNode } from '../../src/core/topicNode';
import { addSource } from '../../src/core/sourceIngest';

describe('addSource', () => {
  it('appends a source and updates lineage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    createNode(root, 'cuba', 'ACTOR-001');
    const entry = addSource(root, 'cuba', 'ACTOR-001', { type: 'pdf', title: 'Overview', origin: 'LOC', url: 'https://example.com' });
    expect(entry.id).toBe('SRC-001');
    const metadataPath = path.join(root, 'topics', 'cuba', 'sources', 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    expect(metadata.sources).toHaveLength(1);
  });

  it('numbers sources sequentially per node', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    createNode(root, 'cuba', 'ACTOR-001');
    addSource(root, 'cuba', 'ACTOR-001', { type: 'pdf', title: 'A', origin: 'x', url: 'x' });
    const second = addSource(root, 'cuba', 'ACTOR-001', { type: 'pdf', title: 'B', origin: 'x', url: 'x' });
    expect(second.id).toBe('SRC-002');
  });
});
