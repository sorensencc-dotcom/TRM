import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../core/config';

export const ACTOR_ID_RE = /^ACTOR-\d{3,}$/;

function validateActorId(actorId: string): void {
  if (!ACTOR_ID_RE.test(actorId)) {
    throw new Error(`invalid actor id "${actorId}", expected format ACTOR-NNN`);
  }
}

export function resolveActor(root: string, cliActor?: string): string {
  const config = loadConfig(root);
  let actorId: string;
  if (config.actor_source === 'cli-only') {
    if (!cliActor) {
      throw new Error('actor_source is "cli-only" — pass --actor explicitly');
    }
    actorId = cliActor;
  } else {
    actorId = cliActor ?? process.env.TRM_ACTOR ?? '';
    if (!actorId) {
      throw new Error('TRM_ACTOR env var not set (actor_source is "env")');
    }
  }
  validateActorId(actorId);
  registerActor(root, actorId);
  return actorId;
}

export function registerActor(root: string, actorId: string): void {
  validateActorId(actorId);
  const registryDir = path.join(root, 'registry');
  const registryPath = path.join(registryDir, 'actors.json');
  fs.mkdirSync(registryDir, { recursive: true });
  const registry: { actors: { actor_id: string }[] } = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
    : { actors: [] };
  if (!registry.actors.some((a) => a.actor_id === actorId)) {
    registry.actors.push({ actor_id: actorId });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  }
}
