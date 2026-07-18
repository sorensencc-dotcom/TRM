import { TopicMeta } from '../../core/types';
import { createNode } from '../../core/topicNode';
import { resolveActor } from '../../registry/actorRegistry';

export function runCreate(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; description?: string; tags?: string[] }
): TopicMeta {
  const actor = resolveActor(root, cliArgs.actor);
  return createNode(root, topicPath, actor, { description: cliArgs.description, tags: cliArgs.tags });
}
