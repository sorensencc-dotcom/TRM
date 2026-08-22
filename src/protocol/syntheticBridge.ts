import { SourceRevision, validateResearchResult, ValidationResult } from './researchResultValidator';

export interface SyntheticBridgeOptions {
  task: unknown;
  dispatch: () => void;
  query: () => unknown;
  resolveSource: (sourceId: string) => SourceRevision | null;
  requestApproval: () => void;
}

export interface SyntheticBridgeResult extends ValidationResult {
  dispatched: boolean;
  approvalRequested: boolean;
}

export function runSyntheticResearchBridge(options: SyntheticBridgeOptions): SyntheticBridgeResult {
  options.dispatch();
  const candidate = options.query();
  const validation = validateResearchResult(candidate, options.resolveSource);
  if (!validation.valid) return { ...validation, dispatched: true, approvalRequested: false };
  options.requestApproval();
  return { ...validation, dispatched: true, approvalRequested: true };
}