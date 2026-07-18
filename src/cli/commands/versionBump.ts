import { readTopicMeta, writeTopicMeta } from '../../core/topicNode';
import { resolveActor } from '../../registry/actorRegistry';
import { appendOperation } from '../../lineage/hasher';

export function runVersionBump(
  root: string,
  topicPath: string,
  bump: 'major' | 'minor' | 'patch',
  cliArgs: { actor?: string }
): string {
  const actor = resolveActor(root, cliArgs.actor);
  const meta = readTopicMeta(root, topicPath);
  const [major, minor, patch] = meta.version.split('.').map(Number);
  const next =
    bump === 'major' ? `${major + 1}.0.0` :
    bump === 'minor' ? `${major}.${minor + 1}.0` :
    `${major}.${minor}.${patch + 1}`;
  meta.version = next;
  meta.updated_at = new Date().toISOString();
  writeTopicMeta(root, meta);
  appendOperation(root, topicPath, { op: 'VERSION_BUMP', actor, timestamp: meta.updated_at, version: next }, { version: next });
  return next;
}
