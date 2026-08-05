import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTopicRoutingConfig, classifyPath, normalize } from '../../src/core/topicRouting';

function writeConfig(dir: string, contents: unknown): string {
  const file = path.join(dir, 'topic-routing.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe('topicRouting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-topicrouting-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('normalize', () => {
    it('lowercases, collapses separators to spaces, and collapses whitespace', () => {
      expect(normalize('Documents/Michigan_Flight-Museum  Scans')).toBe('documents michigan flight museum scans');
    });
  });

  describe('loadTopicRoutingConfig validation', () => {
    it('loads a valid config', () => {
      const file = writeConfig(dir, { 'willow-run': ['willow run'] });
      expect(loadTopicRoutingConfig(file)).toEqual({ 'willow-run': ['willow run'] });
    });

    it('throws if the top level is not an object', () => {
      const file = writeConfig(dir, ['not', 'an', 'object']);
      expect(() => loadTopicRoutingConfig(file)).toThrow(/object/i);
    });

    it('throws on a topic slug that fails ^[a-z0-9-]+$', () => {
      const file = writeConfig(dir, { 'Willow Run': ['willow run'] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/slug/i);
    });

    it('throws on a path-traversal topic slug', () => {
      const file = writeConfig(dir, { '../evil': ['x'] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/slug/i);
    });

    it('throws on an empty keyword array', () => {
      const file = writeConfig(dir, { cuba: [] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/keyword/i);
    });

    it('throws on an empty-string keyword', () => {
      const file = writeConfig(dir, { cuba: [''] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/keyword/i);
    });

    it('throws on keywords colliding across topics only after normalization', () => {
      const file = writeConfig(dir, {
        'michigan-flight-museum': ['michigan-flight-museum'],
        'other-topic': ['Michigan Flight Museum'],
      });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/collide|duplicate/i);
    });

    it('throws a clear error for a missing config file', () => {
      expect(() => loadTopicRoutingConfig(path.join(dir, 'nope.json'))).toThrow(/nope\.json/);
    });

    it('throws a clear error for malformed JSON', () => {
      const file = path.join(dir, 'bad.json');
      fs.writeFileSync(file, '{ not json');
      expect(() => loadTopicRoutingConfig(file)).toThrow();
    });
  });

  describe('classifyPath', () => {
    const config = {
      helene: ['helene'],
      'helene-i': ['helene i', 'helene 1'],
      'michigan-flight-museum': ['michigan flight museum', 'mfm'],
      cuba: ['cuba'],
    };

    it('matches a single unambiguous keyword', () => {
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Cuba Trip/photo1.jpg'), config);
      expect(result).toEqual({ topic: 'cuba', matchedKeyword: 'cuba' });
      expect(ambiguous).toBe(false);
    });

    it('returns no match (not ambiguous) when nothing matches', () => {
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Downloads/random.pdf'), config);
      expect(result).toBeNull();
      expect(ambiguous).toBe(false);
    });

    it('resolves helene vs helene-i by longest-keyword precedence', () => {
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Helene I photos/scan.jpg'), config);
      expect(result).toEqual({ topic: 'helene-i', matchedKeyword: 'helene i' });
      expect(ambiguous).toBe(false);
    });

    it('does not treat multiple same-topic keyword matches as ambiguous', () => {
      const multiKeywordConfig = { 'willys-overland': ['willys', 'jeep'] };
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Willys Jeep Ads/ad1.jpg'), multiKeywordConfig);
      expect(result).toEqual({ topic: 'willys-overland', matchedKeyword: expect.any(String) });
      expect(ambiguous).toBe(false);
    });

    it('flags a genuine cross-topic tie as ambiguous with no result', () => {
      const tieConfig = { 'topic-a': ['shared term'], 'topic-b': ['shared term'] };
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Shared Term/file.jpg'), tieConfig);
      expect(result).toBeNull();
      expect(ambiguous).toBe(true);
    });

    it('does not match a keyword as a substring of an unrelated word', () => {
      const { result } = classifyPath(normalize('intake/dump/Incubator Reports/file.pdf'), config);
      expect(result).toBeNull(); // "cuba" must not match inside "incubator"
    });
  });
});
