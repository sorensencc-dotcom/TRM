export interface TaskExecution {
  task_id: string;
  run_id: string;
  idempotency_key: string;
  execution_fingerprint: string;
}

export interface ReplayValidation {
  valid: boolean;
  replay: boolean;
  errors: string[];
}

export function validateTaskReplay(existing: TaskExecution, incoming: TaskExecution): ReplayValidation {
  if (existing.task_id !== incoming.task_id || existing.idempotency_key !== incoming.idempotency_key) {
    return { valid: false, replay: false, errors: ['task identity does not match existing execution'] };
  }
  if (existing.run_id === incoming.run_id) {
    if (existing.execution_fingerprint !== incoming.execution_fingerprint) {
      return { valid: false, replay: false, errors: ['execution inputs changed without a new run_id'] };
    }
    return { valid: true, replay: true, errors: [] };
  }
  return { valid: true, replay: false, errors: [] };
}