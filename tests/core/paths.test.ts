import * as path from 'node:path';
import { validateSlug, splitPath, deriveNodeType, parentPath, leafSlug, nodeDir } from '../../src/core/paths';

describe('paths', () => {
  it('validates slugs', () => {
    expect(() => validateSlug('cuba')).not.toThrow();
    expect(() => validateSlug('cuba-industry')).not.toThrow();
    expect(() => validateSlug('Cuba Industry')).toThrow();
    expect(() => validateSlug('')).toThrow();
  });

  it('splits paths', () => {
    expect(splitPath('cuba/industry/automotive')).toEqual(['cuba', 'industry', 'automotive']);
  });

  it('derives node type by depth', () => {
    expect(deriveNodeType('cuba')).toBe('project');
    expect(deriveNodeType('cuba/industry')).toBe('topic');
    expect(deriveNodeType('cuba/industry/automotive')).toBe('subtopic');
    expect(deriveNodeType('cuba/industry/automotive/parts')).toBe('subtopic');
  });

  it('computes parent path', () => {
    expect(parentPath('cuba')).toBeNull();
    expect(parentPath('cuba/industry')).toBe('cuba');
    expect(parentPath('cuba/industry/automotive')).toBe('cuba/industry');
  });

  it('extracts leaf slug', () => {
    expect(leafSlug('cuba/industry/automotive')).toBe('automotive');
    expect(leafSlug('cuba')).toBe('cuba');
  });

  it('resolves node directory under root', () => {
    expect(nodeDir('/root', 'cuba/industry')).toBe(path.join('/root', 'topics', 'cuba', 'industry'));
  });
});
