import { runSyntheticResearchBridge } from '../../src/protocol/syntheticBridge';

describe('runSyntheticResearchBridge', () => {
  it('dispatches, validates, and opens approval for a valid result', () => {
    const events: string[] = [];
    const text = 'The event occurred in Detroit in 1912.';
    const result = runSyntheticResearchBridge({
      task: { schema: 'research.task.v1', task_id: 'TASK-1', run_id: 'RUN-1', kind: 'research.compare', inputs: {}, output_contract: 'research.result.v1', approval_required: true },
      dispatch: () => { events.push('dispatch'); },
      query: () => { events.push('query'); return { schema: 'research.result.v1', task_id: 'TASK-1', run_id: 'RUN-1', status: 'completed', producer: { engine: 'TorqueQuery', provider: 'synthetic', model: 'test', prompt_version: 'v1' }, payload: { target_claim_ids: ['C-1'], findings: [{ source_id: 'SRC-1', source_revision: 'sha256:6d58a0c5c4b8e5f5c6b8b3c0f55c4d2d3b1de20b1af4e0e4a5be7c0b1e2d6a4c', source_span: { start: 0, end: 10, span_hash: 'sha256:bad' }, confidence: 0.8, rationale: 'test', type: 'contradiction' }] } } as any; },
      resolveSource: () => ({ sourceId: 'SRC-1', revision: 'sha256:6d58a0c5c4b8e5f5c6b8b3c0f55c4d2d3b1de20b1af4e0e4a5be7c0b1e2d6a4c', text }),
      requestApproval: () => { events.push('approval'); },
    });
    expect(result.valid).toBe(false);
    expect(events).toEqual(['dispatch', 'query']);
  });
  it('requests approval after a valid TRM result', () => {
    let approvals = 0;
    const result = runSyntheticResearchBridge({
      task: { schema: 'research.task.v1', task_id: 'TASK-2', run_id: 'RUN-2', kind: 'research.compare', inputs: {}, output_contract: 'research.result.v1', approval_required: true },
      dispatch: () => {},
      query: () => ({ schema: 'research.result.v1', task_id: 'TASK-2', run_id: 'RUN-2', status: 'completed', producer: { engine: 'TorqueQuery', provider: 'synthetic', model: 'test', prompt_version: 'v1' }, payload: { target_claim_ids: ['C-1'], findings: [{ source_id: 'SRC-1', source_revision: 'sha256:89def4be8a18e17fbd1467d4510bbb690b1d5051c4e29e3d67d9dc85cfbb06b6', source_span: { start: 0, end: 10, span_hash: 'sha256:d905237bace5134d25cbcab47d382bdd6eaa0beb8a46722a1036925b66c482ef' }, confidence: 0.8, rationale: 'test', type: 'contradiction' }] } }),
      resolveSource: () => ({ sourceId: 'SRC-1', revision: 'sha256:89def4be8a18e17fbd1467d4510bbb690b1d5051c4e29e3d67d9dc85cfbb06b6', text: 'The event occurred in Detroit in 1912.' }),
      requestApproval: () => { approvals++; },
    });
    expect(result.valid).toBe(true);
    expect(result.approvalRequested).toBe(true);
    expect(approvals).toBe(1);
  });
});