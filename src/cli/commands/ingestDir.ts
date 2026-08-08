import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { hashFile } from '../../core/contentHash';
import { visionPool, claudePool } from '../../core/concurrency';
import * as manifestStore from '../../core/manifestStore';
import * as failedStore from '../../core/failedStore';
import { classifyImage, ImageKind } from '../../ingestion/imageExtract/classify';
import { ImageAnalyzer } from '../../ingestion/imageExtract/imageAnalyzer';
import { convertFileToText } from '../../ingestion/fileConvert';
import { addSource, SourceEntry } from '../../core/sourceIngest';
import { writeRawEnvelope, RawSourceEnvelope } from '../../core/rawSource';
import { ExtractionRunner } from '../../extraction/types';
import { stubRunner } from '../../extraction/stubRunner';
import { claudeCodeRunner } from '../../extraction/claudeCodeRunner';
import { resolveActor } from '../../registry/actorRegistry';
import { readTopicMeta } from '../../core/topicNode';
import { regenerateExtractJson } from '../../core/regenerateExtractJson';
import { appendOcrTiming } from '../../core/ocrTimingLog';
import { checkFfmpegDeps, checkWhisperDeps } from '../../core/videoDeps';
import { probeVideo } from '../../core/videoProbe';
import {
  extractFrames,
  MIDPOINT_THRESHOLD_MS,
  FPS_THRESHOLD_MS,
  MAX_SELECT_FRAMES,
} from '../../ingestion/videoExtract/extractFrames';
import { analyzeFrames, FrameAnalysis } from '../../ingestion/videoExtract/analyzeFrames';
import { extractAudio } from '../../ingestion/videoExtract/extractAudio';
import { transcribeAudio } from '../../ingestion/videoExtract/transcribe';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv']);

// Timestamp derivation reuses extractFrames.ts's own strategy boundaries
// (imported, not re-declared -- a local copy would silently drift if those
// change). extractFrames() returns only file paths, not timestamps, so this
// derives an approximate timestamp per returned frame based on which strategy
// produced it. These are provenance/debugging approximations (CONTEXT.md #12),
// not frame-accurate timestamps -- do not attempt to reverse-engineer ffmpeg's
// exact selected times.
function computeFrameTimestamps(durationMs: number, frameCount: number): number[] {
  if (durationMs < MIDPOINT_THRESHOLD_MS) {
    // Midpoint strategy nominally yields exactly one frame, but build the
    // array from the actual frameCount rather than hardcoding length 1 --
    // guards against a length mismatch feeding analyzeFrames() if
    // extractFrames() ever returns 0 or 2+ frames for a sub-10s clip.
    const midpointMs = durationMs / 2;
    return Array.from({ length: frameCount }, () => midpointMs);
  }
  const stepMs =
    durationMs < FPS_THRESHOLD_MS ? 10000 : durationMs / MAX_SELECT_FRAMES;
  return Array.from({ length: frameCount }, (_, i) => i * stepMs);
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface IngestDirOptions {
  actor?: string;
  type?: string;
  title?: string;
  origin?: string;
  url?: string;
  dir?: string;
  kind?: ImageKind;
  force?: boolean;
  retryFailed?: boolean;
  stub?: boolean;
}

export interface IngestDirSummary {
  totalFiles: number;
  totalProcessed: number;
  successCount: number;
  duplicateCount: number;
  failureCount: number;
}

export async function runIngestDir(
  root: string,
  targetPath: string,
  cliArgs: IngestDirOptions = {},
  runnerOverride?: ExtractionRunner
): Promise<IngestDirSummary> {
  const actor = resolveActor(root, cliArgs.actor);
  const runner = runnerOverride ?? (cliArgs.stub ? stubRunner : claudeCodeRunner);
  const storeLock = pLimit(1);

  let targetTopicPath = targetPath;
  let dirToWalk = cliArgs.dir ?? targetPath;

  // Determine topicPath vs directory path
  try {
    readTopicMeta(root, targetPath);
    targetTopicPath = targetPath;
  } catch {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      targetTopicPath = path.basename(targetPath);
      dirToWalk = targetPath;
    }
  }

  interface FileWorkItem {
    filePath: string;
    expectedHash?: string;
  }

  let workItems: FileWorkItem[] = [];

  if (cliArgs.retryFailed) {
    const failedEntries = failedStore.readFailed(root, targetTopicPath);
    workItems = failedEntries.map((e) => ({
      filePath: e.sourcePath,
      expectedHash: e.hash,
    }));
  } else {
    if (!fs.existsSync(dirToWalk) || !fs.statSync(dirToWalk).isDirectory()) {
      throw new Error(`Directory does not exist: ${dirToWalk}`);
    }
    const entries = fs.readdirSync(dirToWalk);
    for (const name of entries) {
      const fullPath = path.join(dirToWalk, name);
      if (fs.statSync(fullPath).isFile()) {
        workItems.push({ filePath: fullPath });
      }
    }
  }

  const totalFiles = workItems.length;
  let duplicateCount = 0;
  let successCount = 0;
  let failureCount = 0;

  // Check for ffmpeg/ffprobe if batch contains video files
  const hasVideoFiles = workItems.some((item) =>
    VIDEO_EXTENSIONS.has(path.extname(item.filePath).toLowerCase())
  );
  if (hasVideoFiles) {
    await checkFfmpegDeps();
  }

  const cicIngestionUrl = process.env.CIC_INGESTION_URL || 'http://localhost:3000';
  // Real Vision DOCUMENT_TEXT_DETECTION under concurrent load has been observed
  // taking 60s+ per call (archive-photo batches) -- 5000ms was tuned for the
  // mock path and starved every real-OCR call under the pool's concurrency.
  const analyzer = new ImageAnalyzer(cicIngestionUrl, 90000, 2);

  // Bounds the whole per-file pipeline (hash + read + classify + addSource),
  // not just the vision/claude calls -- without this, "thousands of files"
  // means thousands of concurrent full-file reads in memory at once, which is
  // the exact resource-exhaustion problem this phase exists to prevent.
  // Deliberately separate from visionPool/claudePool: this bounds I/O-level
  // fan-out, those bound the external-service call rate.
  const ioLimit = pLimit(Number(process.env.TRM_IO_CONCURRENCY) || 8);

  await Promise.all(
    workItems.map((item) => ioLimit(async () => {
      const { filePath } = item;
      let hash = item.expectedHash;
      if (!hash) {
        try {
          hash = await hashFile(filePath);
        } catch (err) {
          console.error(`[ingest-dir] Failed to hash file ${filePath}: ${(err as Error).message}`);
          failureCount++;
          return;
        }
      }

      // Dedup check (bypassed by --force)
      if (!cliArgs.force && manifestStore.isDone(root, targetTopicPath, hash)) {
        console.error(`[ingest-dir] Skipping duplicate: ${path.basename(filePath)} (${hash.slice(0, 8)})`);
        duplicateCount++;
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const isImage = IMAGE_EXTENSIONS.has(ext);
      const isVideo = VIDEO_EXTENSIONS.has(ext);

      try {
        if (isVideo) {
          const { durationMs, hasAudioStream } = await probeVideo(filePath);

          // One temp dir per video, shared by both concurrent branches (the
          // extracted WAV and the sampled frame files), removed once both
          // resolve. Deliberately a single dir, not one per branch.
          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trm-video-'));
          let transcript: string;
          let frameAnalyses: FrameAnalysis[];
          try {
            [transcript, frameAnalyses] = await Promise.all([
              hasAudioStream
                ? (async () => {
                    await checkWhisperDeps();
                    // whisper.cpp cannot read an .mp4/.mov container -- extract
                    // audio stream 0 to a 16kHz mono WAV first (CONTEXT.md #5).
                    // Part of preparing the transcript, so it lives inside this
                    // branch and stays concurrent with frame sampling.
                    const audioPath = await extractAudio(filePath, tempDir);
                    return transcribeAudio(audioPath, durationMs);
                  })()
                : Promise.resolve(''),
              (async () => {
                const framePaths = await extractFrames(filePath, durationMs, tempDir);
                const timestampsMs = computeFrameTimestamps(durationMs, framePaths.length);
                return await analyzeFrames(framePaths, timestampsMs, analyzer);
              })(),
            ]);
          } finally {
            // Swallow cleanup errors (e.g. Windows EPERM/EBUSY from an AV
            // scanner or file-handle timing) -- a cleanup hiccup must never
            // mask the real underlying error from extractAudio/transcribeAudio/
            // extractFrames/analyzeFrames, nor turn an otherwise-successful
            // video into a failureCount entry after the Vision API calls have
            // already been paid for. Mirrors the per-frame unlink().catch()
            // pattern in analyzeFrames.ts.
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
          }

          const composedText =
            transcript +
            '\n' +
            frameAnalyses
              .map(
                (f: FrameAnalysis) =>
                  `[frame @ ${formatTimestamp(f.timestampMs)}] labels: ${f.labels
                    .map((l) => l.description)
                    .join(', ')}`
              )
              .join('\n');

          const tempSource: SourceEntry = {
            id: 'SRC-TEMP',
            type: cliArgs.type ?? 'video',
            title: cliArgs.title ?? path.basename(filePath),
            origin: cliArgs.origin ?? 'local',
            url: cliArgs.url || `local:${path.basename(filePath)}`,
            added_at: new Date().toISOString(),
            actor,
          };

          const { facts, summary } = await claudePool(() =>
            Promise.resolve(runner.run(tempSource, composedText))
          );

          await storeLock(async () => {
            const entry = addSource(root, targetTopicPath, actor, {
              type: cliArgs.type ?? 'video',
              title: cliArgs.title ?? path.basename(filePath),
              origin: cliArgs.origin ?? 'local',
              url: cliArgs.url || `local:${path.basename(filePath)}`,
              contentHash: hash,
            });

            const updatedFacts = facts.map((f) => ({ ...f, source_id: entry.id }));

            const envelope: RawSourceEnvelope = {
              sourceId: entry.id,
              kind: 'video',
              capturedAt: new Date().toISOString(),
              text: composedText,
              frames: frameAnalyses,
            };

            writeRawEnvelope(root, targetTopicPath, envelope);
            manifestStore.markDone(root, targetTopicPath, hash!, filePath);
            manifestStore.writeExtract(root, targetTopicPath, hash!, { facts: updatedFacts, summary });
            failedStore.clearFailure(root, targetTopicPath, hash!);
          });
        } else if (isImage) {
          const kind = await classifyImage(filePath, { kind: cliArgs.kind });

          if (kind === 'text-doc') {
            // text-doc: OCR -> extraction path
            const buffer = await fs.promises.readFile(filePath);

            // The OCR call itself is a Vision-API HTTP call, but running under claudePool
            // as it directly prepares input for the subsequent Claude extraction step.
            const ocrResult = await claudePool(() => analyzer.ocr(buffer));

            appendOcrTiming(root, {
              schema_version: 1,
              topic: targetTopicPath,
              file: path.basename(filePath),
              source_type: path.extname(filePath).toLowerCase().replace('.', '') || 'unknown',
              ms: ocrResult.metadata.latencyMs,
              retries: ocrResult.metadata.retries ?? 0,
              outcome: ocrResult.metadata.error ? 'failure' : 'success',
              ts: new Date().toISOString(),
            });

            if (ocrResult.metadata.error) {
              throw new Error(`OCR failed: ${ocrResult.metadata.error}`);
            }

            const tempSource: SourceEntry = {
              id: 'SRC-TEMP',
              type: cliArgs.type ?? 'image',
              title: cliArgs.title ?? path.basename(filePath),
              origin: cliArgs.origin ?? 'local',
              url: cliArgs.url || `local:${path.basename(filePath)}`,
              added_at: new Date().toISOString(),
              actor,
            };

            const { facts, summary } = await claudePool(() =>
              Promise.resolve(runner.run(tempSource, ocrResult.text))
            );

            await storeLock(async () => {
              const entry = addSource(root, targetTopicPath, actor, {
                type: cliArgs.type ?? 'image',
                title: cliArgs.title ?? path.basename(filePath),
                origin: cliArgs.origin ?? 'local',
                url: cliArgs.url || `local:${path.basename(filePath)}`,
                contentHash: hash,
              });

              const updatedFacts = facts.map((f) => ({ ...f, source_id: entry.id }));

              const envelope: RawSourceEnvelope = {
                sourceId: entry.id,
                kind: 'image',
                capturedAt: new Date().toISOString(),
                text: ocrResult.text,
                image: {
                  matches: [],
                  metadata: {
                    format: ocrResult.metadata.format,
                    size: ocrResult.metadata.size,
                    processedAt: ocrResult.metadata.processedAt,
                    visionApiUsed: true,
                  },
                  mock: false,
                  ocrText: ocrResult.text,
                },
                ocrText: ocrResult.text,
              };

              writeRawEnvelope(root, targetTopicPath, envelope);
              manifestStore.markDone(root, targetTopicPath, hash!, filePath);
              manifestStore.writeExtract(root, targetTopicPath, hash!, { facts: updatedFacts, summary });
              failedStore.clearFailure(root, targetTopicPath, hash!);
            });
          } else {
            // photo: reverse-image search path
            const buffer = await fs.promises.readFile(filePath);
            const analysisResult = await visionPool(() => analyzer.extract(buffer));

            if (analysisResult.metadata.error) {
              throw new Error(`Vision analysis failed: ${analysisResult.metadata.error}`);
            }

            await storeLock(async () => {
              const entry = addSource(root, targetTopicPath, actor, {
                type: cliArgs.type ?? 'image',
                title: cliArgs.title ?? path.basename(filePath),
                origin: cliArgs.origin ?? 'local',
                url: cliArgs.url || `local:${path.basename(filePath)}`,
                contentHash: hash,
              });

              const envelope: RawSourceEnvelope = {
                sourceId: entry.id,
                kind: 'image',
                capturedAt: new Date().toISOString(),
                image: {
                  ...analysisResult,
                  mock: !analysisResult.metadata.visionApiUsed,
                },
              };

              writeRawEnvelope(root, targetTopicPath, envelope);
              manifestStore.markDone(root, targetTopicPath, hash!, filePath);
              manifestStore.writeExtract(root, targetTopicPath, hash!, { facts: [], summary: '' });
              failedStore.clearFailure(root, targetTopicPath, hash!);
            });
          }
        } else {
          // non-image: convertFileToText -> extraction
          const text = await convertFileToText(filePath);

          const tempSource: SourceEntry = {
            id: 'SRC-TEMP',
            type: cliArgs.type ?? 'document',
            title: cliArgs.title ?? path.basename(filePath),
            origin: cliArgs.origin ?? 'local',
            url: cliArgs.url || `local:${path.basename(filePath)}`,
            added_at: new Date().toISOString(),
            actor,
          };

          const { facts, summary } = await claudePool(() =>
            Promise.resolve(runner.run(tempSource, text))
          );

          await storeLock(async () => {
            const entry = addSource(root, targetTopicPath, actor, {
              type: cliArgs.type ?? 'document',
              title: cliArgs.title ?? path.basename(filePath),
              origin: cliArgs.origin ?? 'local',
              url: cliArgs.url || `local:${path.basename(filePath)}`,
              contentHash: hash,
            });

            const updatedFacts = facts.map((f) => ({ ...f, source_id: entry.id }));

            const envelope: RawSourceEnvelope = {
              sourceId: entry.id,
              kind: 'text',
              capturedAt: new Date().toISOString(),
              text,
            };

            writeRawEnvelope(root, targetTopicPath, envelope);
            manifestStore.markDone(root, targetTopicPath, hash!, filePath);
            manifestStore.writeExtract(root, targetTopicPath, hash!, { facts: updatedFacts, summary });
            failedStore.clearFailure(root, targetTopicPath, hash!);
          });
        }

        successCount++;
      } catch (err) {
        const errorMsg = (err as Error).message || String(err);
        console.error(`[ingest-dir] Error processing ${path.basename(filePath)}: ${errorMsg}`);

        await storeLock(async () => {
          manifestStore.markFailed(root, targetTopicPath, hash!, filePath, errorMsg);
          failedStore.appendFailure(root, targetTopicPath, hash!, filePath, errorMsg);
        });

        failureCount++;
      }
    }))
  );

  regenerateExtractJson(root, targetTopicPath);

  const totalProcessed = successCount + failureCount;
  console.log(
    `[ingest-dir] Batch complete: ${totalFiles} total files, ${successCount} succeeded, ${duplicateCount} duplicates skipped, ${failureCount} failed.`
  );

  return {
    totalFiles,
    totalProcessed,
    successCount,
    duplicateCount,
    failureCount,
  };
}
