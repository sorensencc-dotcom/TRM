import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashFile } from '../../core/contentHash';
import { visionPool } from '../../core/concurrency';
import {
  IntakeEntry,
  IntakeType,
  openIntakeManifest,
} from '../../core/intakeManifest';
import { classifyImageDetailed } from '../../ingestion/imageExtract/classify';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);

export interface TriageIntakeOptions {
  dir?: string; // relative to root, e.g. "intake/mfm"; omit to scan all of intake/
}

export interface TriageIntakeSummary {
  totalFiles: number;
  processedCount: number;
  skippedCount: number;
  dupCount: number;
  failedCount: number;
  /** Directory entries that could not be stat'ed (broken symlink, permissions) and were skipped. */
  walkErrorCount: number;
  /**
   * Images that fell back to the aspect-ratio heuristic even though
   * CIC_INGESTION_URL was set -- i.e. the vision path was attempted and
   * degraded (service down, or running in mock mode). A non-zero value means
   * the run's image classification is less trustworthy than it looks.
   */
  visionFallbackCount: number;
  byType: Record<string, number>;
}

interface WalkResult {
  files: string[];
  errorCount: number;
}

function walkFiles(dir: string): WalkResult {
  const out: string[] = [];
  let errorCount = 0;

  function walk(current: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch (err) {
      errorCount++;
      console.error(`[triage-intake] cannot read directory ${current}: ${(err as Error).message}`);
      return;
    }
    for (const name of names) {
      const full = path.join(current, name);
      let stat: fs.Stats;
      try {
        // lstat, not stat: a broken symlink throws on stat and would kill the
        // whole run. Symlinks are skipped outright rather than followed, which
        // also removes any symlink-cycle risk.
        stat = fs.lstatSync(full);
      } catch (err) {
        errorCount++;
        console.error(`[triage-intake] skipping unreadable entry ${full}: ${(err as Error).message}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        errorCount++;
        console.error(`[triage-intake] skipping symlink ${full}`);
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) out.push(full);
    }
  }

  if (!fs.existsSync(dir)) return { files: [], errorCount: 0 };
  walk(dir);
  return { files: out, errorCount };
}

function batchFor(root: string, filePath: string): string {
  const intakeDir = path.join(root, 'intake');
  const rel = path.relative(intakeDir, filePath);
  return rel.split(path.sep)[0];
}

function resolveWalkDir(root: string, dir?: string): string {
  const intakeRoot = path.resolve(root, 'intake');
  const walkDir = path.resolve(root, dir ?? 'intake');
  const rel = path.relative(intakeRoot, walkDir);
  // Must be intakeRoot itself or strictly inside it.
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error(
      `--dir must resolve to a path under ${intakeRoot} (got ${walkDir}). ` +
        'Use a path like "intake/benson-ford".'
    );
  }
  return walkDir;
}

export async function runTriageIntake(
  root: string,
  opts: TriageIntakeOptions
): Promise<TriageIntakeSummary> {
  const walkDir = resolveWalkDir(root, opts.dir);
  const { files, errorCount } = walkFiles(walkDir);
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const visionConfigured = Boolean(process.env.CIC_INGESTION_URL);

  const summary: TriageIntakeSummary = {
    totalFiles: files.length,
    processedCount: 0,
    skippedCount: 0,
    dupCount: 0,
    failedCount: 0,
    walkErrorCount: errorCount,
    visionFallbackCount: 0,
    byType: {},
  };

  // Hashes encountered so far *in this run*. Needed to tell "already fully
  // processed by a previous run" (resume -> skip) apart from "a second file
  // with the same content, seen in this run" (dup). isIntakeDone alone cannot
  // distinguish them, which is why dups previously counted as skips and never
  // got isDup: true.
  const seenThisRun = new Set<string>();

  const manifest = openIntakeManifest(root);
  const classifications = new Map<string, ReturnType<typeof classifyImageDetailed>>();
  let pendingWrites = 0;
  const checkpoint = () => {
    pendingWrites++;
    if (pendingWrites >= 100) {
      manifest.flush();
      pendingWrites = 0;
    }
  };

  const hashResults = await Promise.all(files.map(async (filePath) => {
    try {
      return { filePath, hash: await hashFile(filePath) };
    } catch (err) {
      console.error(`[triage-intake] hash failed for ${filePath}: ${(err as Error).message}`);
      summary.failedCount++;
      return { filePath, hash: null };
    }
  }));

  const processFile = async (filePath: string, hash: string): Promise<void> => {
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    const batch = batchFor(root, filePath);
    const ext = path.extname(filePath).toLowerCase();

    const existing = manifest.findByHash(hash);

    if (seenThisRun.has(hash) && existing && existing.status === 'done') {
      // Genuine exact duplicate: same content, different path. Reuse the
      // earlier classification, never re-call vision.
      const entry: IntakeEntry = {
        ...existing,
        sourcePath: rel,
        batch,
        isDup: true,
        status: 'done',
        classifiedAt: new Date().toISOString(),
      };
      manifest.write(entry);
      checkpoint();
      summary.dupCount++;
      summary.byType[entry.classifiedType] = (summary.byType[entry.classifiedType] ?? 0) + 1;
      return;
    }

    // Resume: this hash was completed by an earlier run. Only 'done' short-
    // circuits -- a 'failed' entry falls through and is fully reprocessed, so a
    // transient failure is retried instead of being frozen as done forever.
    if (manifest.isDone(hash)) {
      seenThisRun.add(hash);
      summary.skippedCount++;
      return;
    }

    seenThisRun.add(hash);

    const sizeBytes = fs.statSync(filePath).size;
    const baseEntry = {
      hash,
      sourcePath: rel,
      batch,
      ext,
      sizeBytes,
      isDup: false,
      classifiedAt: new Date().toISOString(),
    };

    if (TEXT_EXTENSIONS.has(ext)) {
      manifest.write({
        ...baseEntry,
        kind: 'text',
        classifiedType: 'text',
        status: 'done',
      });
      checkpoint();
      summary.processedCount++;
      summary.byType.text = (summary.byType.text ?? 0) + 1;
      return;
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        let classification = classifications.get(hash);
        if (!classification) {
          classification = visionPool(() => classifyImageDetailed(filePath));
          classifications.set(hash, classification);
        }
        const result = await classification;
        const completed = manifest.findByHash(hash);
        if (completed && completed.status === 'done' && completed.sourcePath !== rel) {
          manifest.write({ ...completed, sourcePath: rel, batch, isDup: true, classifiedAt: new Date().toISOString() });
          checkpoint();
          summary.dupCount++;
          summary.byType[completed.classifiedType] = (summary.byType[completed.classifiedType] ?? 0) + 1;
          return;
        }
        if (visionConfigured && result.source === 'aspect-ratio') {
          summary.visionFallbackCount++;
        }
        // confidence === 0 on the aspect-ratio path means dimensions were
        // unparseable (HEIC etc.) and 'photo' was only a default -- record that
        // as 'unsure' rather than asserting exhibit-photo, so document photos
        // are not silently routed away from the OCR pipeline.
        const unknownDimensions = result.source === 'aspect-ratio' && result.confidence === 0;
        const classifiedType: IntakeType = unknownDimensions
          ? 'unsure'
          : result.kind === 'text-doc'
            ? 'doc-photo'
            : 'exhibit-photo';
        manifest.write({
          ...baseEntry,
          kind: 'image',
          classifiedType,
          confidence: result.confidence,
          status: 'done',
        });
        checkpoint();
        summary.processedCount++;
        summary.byType[classifiedType] = (summary.byType[classifiedType] ?? 0) + 1;
      } catch (err) {
        manifest.write({
          ...baseEntry,
          kind: 'image',
          classifiedType: 'unsure',
          status: 'failed',
          error: (err as Error).message,
        });
        checkpoint();
        summary.failedCount++;
      }
      return;
    }

    manifest.write({
      ...baseEntry,
      kind: 'unknown',
      classifiedType: 'unsure',
      status: 'failed',
      error: 'unsupported extension',
    });
    checkpoint();
    summary.failedCount++;
  };

  // Hash/dedup decisions remain ordered; classification itself is safely
  // parallel because workers only mutate the in-memory manifest session.
  // Hash results preserve walk order, so the first path for a hash remains
  // canonical even though image classification below runs concurrently.
  await Promise.all(hashResults.map(({ filePath, hash }) => hash ? processFile(filePath, hash) : Promise.resolve()));
  manifest.flush();

  return summary;
}
