import { SourceEntry } from '../../core/sourceIngest';
import { addSource } from '../../core/sourceIngest';
import { resolveActor } from '../../registry/actorRegistry';

export function runIngest(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; type: string; title: string; origin: string; url: string; dryRun?: boolean }
): SourceEntry | null {
  const actor = resolveActor(root, cliArgs.actor);
  if (cliArgs.dryRun) return null;
  return addSource(root, topicPath, actor, { type: cliArgs.type, title: cliArgs.title, origin: cliArgs.origin, url: cliArgs.url });
}
