import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    const classifySpy = jest.spyOn(classifyModule, 'classifyImage');

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
    jest.spyOn(classifyModule, 'classifyImage').mockResolvedValueOnce('photo');

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.classifiedType).toBe('exhibit-photo');
    expect(entry.kind).toBe('image');
  });

  it('maps text-doc classification to doc-photo', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'benson-ford', 'scan1.png', pngBytes);
    jest.spyOn(classifyModule, 'classifyImage').mockResolvedValueOnce('text-doc');

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    expect(Object.values(manifest.entries)[0].classifiedType).toBe('doc-photo');
  });

  it('marks a second identical file as a dup without calling classifyImage again', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'mfm', 'photo1.png', pngBytes);
    writeIntakeFile(root, 'mfm', 'photo1-copy.png', pngBytes); // identical bytes
    const classifySpy = jest.spyOn(classifyModule, 'classifyImage').mockResolvedValue('photo');

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entries = Object.values(manifest.entries);

    expect(entries).toHaveLength(1); // same hash -> same manifest key
    expect(classifySpy).toHaveBeenCalledTimes(1);
  });

  it('marks an unreadable/unsupported extension as failed and continues', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'misc', 'weird.xyz', 'unsupported');

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.status).toBe('failed');
    expect(entry.error).toMatch(/unsupported extension/i);
    expect(summary.failedCount).toBe(1);
  });

  it('resumes: a second run skips files already marked done', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'old-chats', 'export1.md', 'text content');

    await runTriageIntake(root, {});
    const classifySpy = jest.spyOn(classifyModule, 'classifyImage');
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
});
