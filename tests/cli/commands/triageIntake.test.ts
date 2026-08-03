import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// fs.lstatSync is a getter-only export, so jest.spyOn / direct assignment both
// fail. Mock the module once and route through a switchable failure path so a
// single test can simulate an unstattable directory entry.
let mockLstatFailPath: string | null = null;
// Real symlinks need elevation/developer mode on Windows (EPERM here), so the
// symlink-skipping behaviour is exercised through a forced lstat result.
let mockSymlinkPath: string | null = null;
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    lstatSync: (p: unknown, ...rest: unknown[]) => {
      if (mockLstatFailPath !== null && String(p) === mockLstatFailPath) {
        throw new Error('EACCES: simulated unstattable entry');
      }
      if (mockSymlinkPath !== null && String(p) === mockSymlinkPath) {
        const real = actual.lstatSync(p, ...rest);
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
          isSymbolicLink: () => true,
          isFile: () => false,
          isDirectory: () => false,
        });
      }
      return actual.lstatSync(p, ...rest);
    },
  };
});

import { runTriageIntake } from '../../../src/cli/commands/triageIntake';
import { readIntakeManifest } from '../../../src/core/intakeManifest';
import * as classifyModule from '../../../src/ingestion/imageExtract/classify';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-triage-'));
  return root;
}

function writeIntakeFile(root: string, batch: string, name: string, contents: string | Buffer): string {
  const dir = path.join(root, 'intake', batch);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('runTriageIntake', () => {
  afterEach(() => jest.restoreAllMocks());

  it('classifies a text file as classifiedType "text" with no vision call', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'old-chats', 'export1.md', '# chat export\nsome text');
    const classifySpy = jest.spyOn(classifyModule, 'classifyImageDetailed');

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entries = Object.values(manifest.entries);

    expect(entries).toHaveLength(1);
    expect(entries[0].classifiedType).toBe('text');
    expect(entries[0].batch).toBe('old-chats');
    expect(classifySpy).not.toHaveBeenCalled();
    expect(summary.totalFiles).toBe(1);
  });

  it('classifies an image file via classifyImage, mapping photo -> exhibit-photo', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'mfm', 'photo1.png', pngBytes);
    jest
      .spyOn(classifyModule, 'classifyImageDetailed')
      .mockResolvedValueOnce({ kind: 'photo', source: 'vision', confidence: 0.9 });

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.classifiedType).toBe('exhibit-photo');
    expect(entry.kind).toBe('image');
    expect(entry.confidence).toBe(0.9);
  });

  it('maps text-doc classification to doc-photo', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'benson-ford', 'scan1.png', pngBytes);
    jest
      .spyOn(classifyModule, 'classifyImageDetailed')
      .mockResolvedValueOnce({ kind: 'text-doc', source: 'vision', confidence: 0.8 });

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    expect(Object.values(manifest.entries)[0].classifiedType).toBe('doc-photo');
  });

  it('marks a second identical file as a dup without calling classifyImage again', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'mfm', 'photo1.png', pngBytes);
    writeIntakeFile(root, 'mfm', 'photo1-copy.png', pngBytes); // identical bytes
    const classifySpy = jest
      .spyOn(classifyModule, 'classifyImageDetailed')
      .mockResolvedValue({ kind: 'photo', source: 'vision', confidence: 0.9 });

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entries = Object.values(manifest.entries);
    const hash = Object.keys(manifest.entries)[0];

    expect(entries).toHaveLength(1); // same hash -> same manifest key
    expect(classifySpy).toHaveBeenCalledTimes(1);
    expect(manifest.entries[hash].isDup).toBe(true);
    expect(summary.dupCount).toBe(1);
    expect(summary.processedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
  });

  it('still reports the second copy as a dup (not a skip) on a rerun', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'mfm', 'photo1.png', pngBytes);
    writeIntakeFile(root, 'mfm', 'photo1-copy.png', pngBytes);
    jest
      .spyOn(classifyModule, 'classifyImageDetailed')
      .mockResolvedValue({ kind: 'photo', source: 'vision', confidence: 0.9 });

    await runTriageIntake(root, {});
    const summary2 = await runTriageIntake(root, {});

    expect(summary2.skippedCount).toBe(1);
    expect(summary2.dupCount).toBe(1);
  });

  it('marks an unreadable/unsupported extension as failed and continues', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'misc', 'weird.xyz', 'unsupported');

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.status).toBe('failed');
    expect(entry.error).toMatch(/unsupported extension/i);
    expect(entry.kind).toBe('unknown');
    expect(summary.failedCount).toBe(1);
  });

  it('reprocesses a failed entry on the next run instead of flipping it to done', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'misc', 'weird.xyz', 'unsupported');

    const summary1 = await runTriageIntake(root, {});
    expect(summary1.failedCount).toBe(1);

    const summary2 = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.status).toBe('failed'); // NOT flipped to done
    expect(entry.isDup).toBe(false);
    expect(entry.error).toMatch(/unsupported extension/i);
    expect(summary2.failedCount).toBe(1); // reprocessed
    expect(summary2.skippedCount).toBe(0);
    expect(summary2.dupCount).toBe(0);
  });

  it('resumes: a second run skips files already marked done', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'old-chats', 'export1.md', 'text content');

    await runTriageIntake(root, {});
    const classifySpy = jest.spyOn(classifyModule, 'classifyImageDetailed');
    const summary2 = await runTriageIntake(root, {});

    expect(summary2.skippedCount).toBe(1);
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('--dir scopes the walk to a single batch folder', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'mfm', 'a.md', 'text a');
    writeIntakeFile(root, 'benson-ford', 'b.md', 'text b');

    const summary = await runTriageIntake(root, { dir: 'intake/mfm' });
    expect(summary.totalFiles).toBe(1);
  });

  it('rejects a --dir that escapes the intake root', async () => {
    const root = makeRoot();
    await expect(runTriageIntake(root, { dir: '../../somewhere' })).rejects.toThrow(/under/i);
  });

  it('writes classifiedType "unsure" when dimensions are unparseable and vision is unavailable', async () => {
    const root = makeRoot();
    const originalEnv = process.env.CIC_INGESTION_URL;
    delete process.env.CIC_INGESTION_URL;
    try {
      // A .heic file with bytes readDimensions cannot measure (not PNG/JPEG).
      writeIntakeFile(root, 'mfm', 'iphone-doc.heic', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));

      const summary = await runTriageIntake(root, {});
      const entry = Object.values(readIntakeManifest(root).entries)[0];

      expect(entry.classifiedType).toBe('unsure'); // not exhibit-photo
      expect(entry.confidence).toBe(0);
      expect(summary.visionFallbackCount).toBe(0); // vision was never configured
    } finally {
      if (originalEnv === undefined) delete process.env.CIC_INGESTION_URL;
      else process.env.CIC_INGESTION_URL = originalEnv;
    }
  });

  it('counts an aspect-ratio result as a vision fallback when CIC_INGESTION_URL is set', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'mfm', 'photo1.png', pngBytes);
    const originalEnv = process.env.CIC_INGESTION_URL;
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    try {
      jest
        .spyOn(classifyModule, 'classifyImageDetailed')
        .mockResolvedValueOnce({ kind: 'photo', source: 'aspect-ratio' });

      const summary = await runTriageIntake(root, {});
      expect(summary.visionFallbackCount).toBe(1);
    } finally {
      if (originalEnv === undefined) delete process.env.CIC_INGESTION_URL;
      else process.env.CIC_INGESTION_URL = originalEnv;
    }
  });

  it('completes the run when one directory entry cannot be stat-ed', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'mfm', 'a.md', 'text a');
    const bad = writeIntakeFile(root, 'mfm', 'broken.md', 'will fail lstat');

    mockLstatFailPath = bad;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const summary = await runTriageIntake(root, {});

      expect(summary.walkErrorCount).toBe(1);
      expect(summary.totalFiles).toBe(1);
      expect(summary.processedCount).toBe(1); // the good file still got processed
    } finally {
      mockLstatFailPath = null;
    }
  });

  it('skips symlinked entries rather than following them', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'mfm', 'a.md', 'text a');
    const linkPath = writeIntakeFile(root, 'mfm', 'link.md', 'stand-in for a symlink');
    mockSymlinkPath = linkPath;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const summary = await runTriageIntake(root, {});

      expect(summary.totalFiles).toBe(1); // symlink not walked
      expect(summary.walkErrorCount).toBe(1);
      expect(summary.processedCount).toBe(1);
    } finally {
      mockSymlinkPath = null;
    }
  });
});
