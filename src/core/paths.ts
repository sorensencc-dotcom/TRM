import * as path from 'node:path';
import { NodeType } from './types';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid slug: "${slug}" (must be lowercase kebab-case)`);
  }
}

export function splitPath(topicPath: string): string[] {
  const segments = topicPath.split('/').filter(Boolean);
  segments.forEach(validateSlug);
  return segments;
}

export function deriveNodeType(topicPath: string): NodeType {
  const depth = splitPath(topicPath).length;
  if (depth <= 1) return 'project';
  if (depth === 2) return 'topic';
  return 'subtopic';
}

export function parentPath(topicPath: string): string | null {
  const segments = splitPath(topicPath);
  if (segments.length <= 1) return null;
  return segments.slice(0, -1).join('/');
}

export function leafSlug(topicPath: string): string {
  const segments = splitPath(topicPath);
  return segments[segments.length - 1];
}

export function nodeDir(root: string, topicPath: string): string {
  return path.join(root, 'topics', ...splitPath(topicPath));
}
