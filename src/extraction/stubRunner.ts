import { ExtractionRunner } from './types';

export const stubRunner: ExtractionRunner = {
  run(source, rawText) {
    const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
    const facts = lines.map((text, i) => ({
      id: `FCT-${String(i + 1).padStart(3, '0')}`,
      text,
      source_id: source.id,
      confidence: 0.5,
      categories: [] as string[],
    }));
    return { facts, summary: `Extracted ${facts.length} fact(s) from ${source.title}.` };
  },
};
