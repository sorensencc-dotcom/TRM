import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateRawToJson } from '../../scripts/migrate-raw-to-json';

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-vault-'));
  const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Fact one.\nFact two.');
  return root;
}

describe('migrateRawToJson', () => {
  it('converts a .txt raw file into a text envelope .json and removes the .txt', () => {
    const root = makeVault();
    const result = migrateRawToJson(root);

    const jsonPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json');
    const txtPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.txt');
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(txtPath)).toBe(false);

    const envelope = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(envelope.sourceId).toBe('SRC-001');
    expect(envelope.kind).toBe('text');
    expect(envelope.text).toBe('Fact one.\nFact two.');
    expect(typeof envelope.capturedAt).toBe('string');

    expect(result.migrated).toEqual([jsonPath]);
    expect(result.skipped).toEqual([]);
  });

  it('is idempotent: running twice does not error and migrates nothing the second time', () => {
    const root = makeVault();
    migrateRawToJson(root);
    const second = migrateRawToJson(root);
    expect(second.migrated).toEqual([]);
  });

  it('skips a .txt file that already has a corresponding .json (does not overwrite)', () => {
    const root = makeVault();
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.writeFileSync(path.join(rawDir, 'SRC-002.txt'), 'Other text.');
    fs.writeFileSync(path.join(rawDir, 'SRC-002.json'), JSON.stringify({ sourceId: 'SRC-002', kind: 'text', capturedAt: 'x', text: 'preexisting' }));

    const result = migrateRawToJson(root);

    const preserved = JSON.parse(fs.readFileSync(path.join(rawDir, 'SRC-002.json'), 'utf-8'));
    expect(preserved.text).toBe('preexisting');
    expect(result.skipped).toContain(path.join(rawDir, 'SRC-002.txt'));
  });

  it('finds raw dirs at any topic depth', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-vault-'));
    const rawDir = path.join(root, 'topics', 'charlie', 'cuba', 'havana', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Deep text.');

    const result = migrateRawToJson(root);

    expect(result.migrated).toHaveLength(1);
    expect(fs.existsSync(path.join(rawDir, 'SRC-001.json'))).toBe(true);
  });
});
