import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as manifestStore from '../../../src/core/manifestStore';
import { deriveAutoKeywords } from '../../../src/ingestion/videoExtract/autoKeywords';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-autokeywords-'));
}

describe('deriveAutoKeywords', () => {
  it('unions Fact.categories across every done manifest entry for the topic', () => {
    const root = makeRoot();
    manifestStore.markDone(root, 'topic1', 'hash-a', '/a.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-a', {
      facts: [{ id: 'FCT-1', text: 't', source_id: 'SRC-1', confidence: 0.9, categories: ['car', 'accident'] }],
      summary: '',
    });
    manifestStore.markDone(root, 'topic1', 'hash-b', '/b.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-b', {
      facts: [
        { id: 'FCT-2', text: 't', source_id: 'SRC-2', confidence: 0.9, categories: ['accident', 'interview'] },
      ],
      summary: '',
    });

    expect(new Set(deriveAutoKeywords(root, 'topic1'))).toEqual(new Set(['car', 'accident', 'interview']));
  });

  it('excludes entries that are not status: done', () => {
    const root = makeRoot();
    manifestStore.markFailed(root, 'topic1', 'hash-c', '/c.mp4', 'boom');
    manifestStore.writeExtract(root, 'topic1', 'hash-c', {
      facts: [{ id: 'FCT-3', text: 't', source_id: 'SRC-3', confidence: 0.9, categories: ['should-not-appear'] }],
      summary: '',
    });

    expect(deriveAutoKeywords(root, 'topic1')).toEqual([]);
  });

  it('drops empty-string category entries', () => {
    const root = makeRoot();
    manifestStore.markDone(root, 'topic1', 'hash-d', '/d.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-d', {
      facts: [{ id: 'FCT-4', text: 't', source_id: 'SRC-4', confidence: 0.9, categories: ['valid', ''] }],
      summary: '',
    });

    expect(deriveAutoKeywords(root, 'topic1')).toEqual(['valid']);
  });

  it('returns an empty array when the topic has no done entries at all', () => {
    const root = makeRoot();
    expect(deriveAutoKeywords(root, 'topic1')).toEqual([]);
  });

  it('filters out closed-taxonomy categories and warns when nothing usable remains', () => {
    const root = makeRoot();
    manifestStore.markDone(root, 'topic1', 'hash-e', '/e.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-e', {
      facts: [
        { id: 'FCT-5', text: 't', source_id: 'SRC-5', confidence: 0.9, categories: ['biography', 'history'] },
      ],
      summary: '',
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    expect(deriveAutoKeywords(root, 'topic1')).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('closed-taxonomy'));
    consoleSpy.mockRestore();
  });

  it('keeps non-taxonomy categories and drops only taxonomy ones from a mixed set, without warning', () => {
    const root = makeRoot();
    manifestStore.markDone(root, 'topic1', 'hash-f', '/f.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-f', {
      facts: [
        { id: 'FCT-6', text: 't', source_id: 'SRC-6', confidence: 0.9, categories: ['biography', 'car'] },
      ],
      summary: '',
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    expect(deriveAutoKeywords(root, 'topic1')).toEqual(['car']);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
