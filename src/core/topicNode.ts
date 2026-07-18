import * as fs from 'node:fs';
import * as path from 'node:path';
import { TopicMeta } from './types';
import { nodeDir, parentPath, leafSlug, deriveNodeType, splitPath } from './paths';
import { appendOperation } from '../lineage/hasher';

function topicJsonPath(root: string, topicPath: string): string {
  return path.join(nodeDir(root, topicPath), 'topic.json');
}

export function readTopicMeta(root: string, topicPath: string): TopicMeta {
  return JSON.parse(fs.readFileSync(topicJsonPath(root, topicPath), 'utf-8'));
}

export function writeTopicMeta(root: string, meta: TopicMeta): void {
  const dir = nodeDir(root, meta.path);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['sources/raw', 'extracts', 'lineage', 'crosslinks']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(topicJsonPath(root, meta.path), JSON.stringify(meta, null, 2));
}

function ensureNode(root: string, topicPath: string, actor: string, opts?: { description?: string; tags?: string[] }): TopicMeta {
  const existingPath = topicJsonPath(root, topicPath);
  if (fs.existsSync(existingPath)) {
    return readTopicMeta(root, topicPath);
  }
  const now = new Date().toISOString();
  const meta: TopicMeta = {
    topic: leafSlug(topicPath),
    path: topicPath,
    parent: parentPath(topicPath),
    children: [],
    version: '1.0.0',
    created_at: now,
    updated_at: now,
    actors: [actor],
    description: opts?.description ?? '',
    tags: opts?.tags ?? [],
    status: 'container',
    node_type: deriveNodeType(topicPath),
  };
  writeTopicMeta(root, meta);
  appendOperation(
    root,
    topicPath,
    { op: 'CREATE', actor, timestamp: now, topic: meta.topic },
    { topic: meta.topic }
  );
  return meta;
}

export function createNode(root: string, topicPath: string, actor: string, opts?: { description?: string; tags?: string[] }): TopicMeta {
  const segments = splitPath(topicPath);
  let built = '';
  let leafMeta: TopicMeta | null = null;
  for (const segment of segments) {
    built = built ? `${built}/${segment}` : segment;
    const isLeaf = built === topicPath;
    const meta = ensureNode(root, built, actor, isLeaf ? opts : undefined);
    const parent = parentPath(built);
    if (parent) {
      const parentMeta = readTopicMeta(root, parent);
      if (!parentMeta.children.includes(leafSlug(built))) {
        parentMeta.children.push(leafSlug(built));
        parentMeta.updated_at = new Date().toISOString();
        writeTopicMeta(root, parentMeta);
      }
    }
    if (isLeaf) leafMeta = meta;
  }
  return leafMeta as TopicMeta;
}

export function markActive(root: string, topicPath: string, actor: string): void {
  const meta = readTopicMeta(root, topicPath);
  meta.status = 'active';
  meta.updated_at = new Date().toISOString();
  if (!meta.actors.includes(actor)) meta.actors.push(actor);
  writeTopicMeta(root, meta);
}
