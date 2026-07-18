import { Fact } from '../scoring/types';
import { SourceEntry } from '../core/sourceIngest';

export interface ExtractionRunner {
  run(source: SourceEntry, rawText: string): { facts: Fact[]; summary: string };
}
