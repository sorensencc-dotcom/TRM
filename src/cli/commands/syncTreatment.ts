import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { validateAgainstSchema } from '../../schemas/validator';
import { factKey } from '../../sync/factIdentity';
import { loadDependencyMap } from '../../sync/dependencyMap';
import { matchFact, MATCH_CONFIG_VERSION } from '../../sync/matching';
import { readCursor, writeCursor, diffNewFactKeys, Cursor } from '../../sync/cursorStore';
import { acquireLock, releaseLock, forceRecoverLock, LockConflictError, LockUnrecoverableError } from '../../sync/lock';
import { writeReport, ReportInput, TopicFactReport, SkippedTopic, CursorResetNote } from '../../sync/reportWriter';
import { Fact } from '../../scoring/types';

export interface SyncTreatmentOptions {
  vaultRoot: string;
  narrativeRoot: string;
  dependencyMapPath?: string;
  topic?: string;
  dryRun?: boolean;
  forceRecoverLock?: boolean;
}

export interface SyncTreatmentResult {
  reportPath: string;
  exitCode: 0 | 1 | 2;
  stderr: string[];
}

function discoverTopics(vaultRoot: string): string[] {
  const topicsDir = path.join(vaultRoot, 'topics', 'charlie');
  if (!fs.existsSync(topicsDir)) return [];
  return fs
    .readdirSync(topicsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

function extractPathFor(vaultRoot: string, topic: string): string {
  return path.join(vaultRoot, 'topics', 'charlie', topic, 'extracts', 'extract.json');
}

function cursorPathFor(vaultRoot: string, topic: string): string {
  return path.join(vaultRoot, 'topics', 'charlie', topic, '.sync-cursor.json');
}

interface TopicReadResult {
  facts: Fact[] | null;
  skipReason: string | null;
  mtime: string;
}

function readTopicExtract(vaultRoot: string, topic: string): TopicReadResult {
  const filePath = extractPathFor(vaultRoot, topic);
  if (!fs.existsSync(filePath)) {
    return { facts: null, skipReason: `missing ${path.relative(vaultRoot, filePath)}`, mtime: '' };
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const mtime = fs.statSync(filePath).mtime.toISOString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { facts: null, skipReason: `malformed extracts/extract.json: ${(err as Error).message}`, mtime };
  }
  const { valid, errors } = validateAgainstSchema('extract', parsed);
  if (!valid) {
    return { facts: null, skipReason: `malformed extracts/extract.json: ${errors.join('; ')}`, mtime };
  }
  return { facts: (parsed as { facts: Fact[] }).facts, skipReason: null, mtime };
}

function resolveDependencyMapPath(opts: SyncTreatmentOptions): string {
  return opts.dependencyMapPath ?? path.join(opts.narrativeRoot, 'treatment', 'CIC_SOURCING_DEPENDENCY_MAP_v1.json');
}

function resolveTreatmentDir(narrativeRoot: string): string {
  const treatmentDir = path.join(narrativeRoot, 'treatment');
  const realTreatmentDir = fs.realpathSync(treatmentDir);
  return realTreatmentDir;
}

export function runSyncTreatment(opts: SyncTreatmentOptions): SyncTreatmentResult {
  const stderr: string[] = [];
  const runId = crypto.randomUUID();
  const runAt = new Date().toISOString();
  const lockPath = path.join(opts.vaultRoot, '.sync-treatment.lock');

  if (opts.forceRecoverLock) {
    forceRecoverLock(lockPath);
  }

  try {
    acquireLock(lockPath, runId);
  } catch (err) {
    if (err instanceof LockConflictError || err instanceof LockUnrecoverableError) {
      throw err;
    }
    throw err;
  }

  try {
    const dependencyMap = loadDependencyMap(resolveDependencyMapPath(opts));
    const treatmentDir = resolveTreatmentDir(opts.narrativeRoot);

    const topics = opts.topic ? [opts.topic] : discoverTopics(opts.vaultRoot);
    const scope = opts.topic ?? 'all';

    const topicsProcessed: string[] = [];
    const topicsSkipped: SkippedTopic[] = [];
    const cursorResets: CursorResetNote[] = [];
    const vaultSnapshot: Record<string, string> = {};
    const newFacts: TopicFactReport[] = [];
    const cursorUpdates: { topic: string; cursorPath: string; cursor: Cursor }[] = [];
    let factKeyCollisions = 0;

    for (const topic of topics) {
      const { facts, skipReason, mtime } = readTopicExtract(opts.vaultRoot, topic);

      if (facts === null) {
        topicsSkipped.push({ topic, reason: skipReason! });
        continue;
      }

      const keyed = facts.map((f) => ({ fact: f, key: factKey(f) }));
      const seenKeys = new Map<string, Fact>();
      let collided = false;
      for (const { fact, key } of keyed) {
        const existing = seenKeys.get(key);
        if (existing) {
          stderr.push(`factKey collision in topic "${topic}": "${existing.id}" and "${fact.id}" share key ${key}`);
          collided = true;
          continue;
        }
        seenKeys.set(key, fact);
      }
      if (collided) {
        factKeyCollisions++;
        topicsSkipped.push({ topic, reason: `factKey collision — see stderr` });
        continue;
      }

      vaultSnapshot[topic] = mtime;
      const cursorPath = cursorPathFor(opts.vaultRoot, topic);
      const { cursor, wasReset, resetReason } = readCursor(cursorPath);
      if (wasReset && resetReason) {
        cursorResets.push({ topic, cursorPath, reason: resetReason });
        stderr.push(`cursor reset for topic "${topic}": ${resetReason}`);
      }

      const currentKeys = keyed.map((k) => k.key);
      const newKeys = new Set(diffNewFactKeys(cursor, currentKeys));

      for (const { fact, key } of keyed) {
        if (!newKeys.has(key)) continue;
        newFacts.push({
          topic,
          factKey: key,
          displayId: fact.id,
          sourceId: fact.source_id,
          factConfidence: fact.confidence,
          text: fact.text,
          matches: matchFact(fact, dependencyMap),
        });
      }

      const keysUnchanged =
        currentKeys.length === cursor.lastSyncedFactKeys.length &&
        new Set(currentKeys).size === new Set(cursor.lastSyncedFactKeys).size &&
        currentKeys.every((k) => new Set(cursor.lastSyncedFactKeys).has(k));

      if (!keysUnchanged) {
        cursorUpdates.push({
          topic,
          cursorPath,
          cursor: {
            cursorVersion: cursor.cursorVersion,
            lastSyncedFactKeys: currentKeys,
            lastRunAt: runAt,
            factCountAtLastSuccessfulSync: currentKeys.length,
          },
        });
      }
      topicsProcessed.push(topic);
    }

    const reportInput: ReportInput = {
      scope,
      runId,
      runAt,
      vaultSnapshot,
      matchVersion: dependencyMap.matchSchemaVersion,
      matchConfigVersion: MATCH_CONFIG_VERSION,
      cursorVersion: 1,
      dryRun: Boolean(opts.dryRun),
      factKeyCollisions,
      topicsProcessed,
      topicsSkipped,
      cursorResets,
      newFacts,
    };

    const reportPath = writeReport(treatmentDir, reportInput);

    let cursorWriteFailed = false;
    if (!opts.dryRun) {
      for (const update of cursorUpdates) {
        try {
          writeCursor(update.cursorPath, update.cursor);
        } catch (err) {
          cursorWriteFailed = true;
          stderr.push(`cursor write failed for topic "${update.topic}" (report already written at "${reportPath}"): ${(err as Error).message}`);
        }
      }
    }

    const exitCode: 0 | 1 | 2 = topicsSkipped.length > 0 || cursorWriteFailed ? 2 : 0;

    return { reportPath, exitCode, stderr };
  } finally {
    releaseLock(lockPath);
  }
}
