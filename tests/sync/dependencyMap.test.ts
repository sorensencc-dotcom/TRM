import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDependencyMap } from '../../src/sync/dependencyMap';

function writeFixture(dir: string, content: unknown): string {
  const file = path.join(dir, 'map.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('loadDependencyMap', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-depmap-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a valid envelope', () => {
    const file = writeFixture(dir, {
      matchSchemaVersion: 1,
      items: [{ id: 'V-5.3', beat: '5.3', claim: 'The subject visited San Diego.' }],
    });
    const map = loadDependencyMap(file);
    expect(map.matchSchemaVersion).toBe(1);
    expect(map.items).toHaveLength(1);
  });

  it('throws when matchSchemaVersion is missing', () => {
    const file = writeFixture(dir, { items: [] });
    expect(() => loadDependencyMap(file)).toThrow(/matchSchemaVersion/);
  });

  it('throws when matchSchemaVersion is unsupported', () => {
    const file = writeFixture(dir, { matchSchemaVersion: 99, items: [] });
    expect(() => loadDependencyMap(file)).toThrow(/99/);
  });

  it('throws on a bare array (pre-migration shape)', () => {
    const file = writeFixture(dir, [{ id: 'V-1', beat: '1', claim: 'x' }]);
    expect(() => loadDependencyMap(file)).toThrow(/matchSchemaVersion/);
  });

  it('throws on a duplicate item id', () => {
    const file = writeFixture(dir, {
      matchSchemaVersion: 1,
      items: [
        { id: 'V-5.3', beat: '5.3', claim: 'a' },
        { id: 'V-5.3', beat: '5.4', claim: 'b' },
      ],
    });
    expect(() => loadDependencyMap(file)).toThrow(/duplicate/i);
  });

  it('throws on an item with empty claim', () => {
    const file = writeFixture(dir, {
      matchSchemaVersion: 1,
      items: [{ id: 'V-5.3', beat: '5.3', claim: '' }],
    });
    expect(() => loadDependencyMap(file)).toThrow(/claim/);
  });

  it('throws when categories is not a string array', () => {
    const file = writeFixture(dir, {
      matchSchemaVersion: 1,
      items: [{ id: 'V-5.3', beat: '5.3', claim: 'x', categories: [1, 2] }],
    });
    expect(() => loadDependencyMap(file)).toThrow(/categories/);
  });

  it('throws when the file does not exist', () => {
    expect(() => loadDependencyMap(path.join(dir, 'nonexistent.json'))).toThrow(/nonexistent\.json/);
  });
});
