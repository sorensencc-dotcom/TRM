import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNode, readTopicMeta, markActive } from '../../src/core/topicNode';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
}

describe('topicNode', () => {
  it('creates a single-segment node as a project', () => {
    const root = makeRoot();
    const meta = createNode(root, 'cuba', 'ACTOR-001', { description: 'Cuba research' });
    expect(meta.node_type).toBe('project');
    expect(meta.status).toBe('container');
    expect(meta.parent).toBeNull();
    expect(meta.children).toEqual([]);
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'topic.json'))).toBe(true);
  });

  it('creates intermediate container nodes and links parent/children', () => {
    const root = makeRoot();
    createNode(root, 'cuba/industry/automotive', 'ACTOR-001');
    const project = readTopicMeta(root, 'cuba');
    const topic = readTopicMeta(root, 'cuba/industry');
    const subtopic = readTopicMeta(root, 'cuba/industry/automotive');

    expect(project.node_type).toBe('project');
    expect(project.children).toEqual(['industry']);
    expect(topic.node_type).toBe('topic');
    expect(topic.parent).toBe('cuba');
    expect(topic.children).toEqual(['automotive']);
    expect(subtopic.node_type).toBe('subtopic');
    expect(subtopic.parent).toBe('cuba/industry');
  });

  it('does not duplicate an existing child when re-creating a descendant', () => {
    const root = makeRoot();
    createNode(root, 'cuba/industry', 'ACTOR-001');
    createNode(root, 'cuba/industry/automotive', 'ACTOR-001');
    const project = readTopicMeta(root, 'cuba');
    expect(project.children).toEqual(['industry']);
  });

  it('marks a node active', () => {
    const root = makeRoot();
    createNode(root, 'cuba', 'ACTOR-001');
    markActive(root, 'cuba', 'ACTOR-001');
    expect(readTopicMeta(root, 'cuba').status).toBe('active');
  });
});
