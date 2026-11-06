import {
  runUniversalChatArchival,
  archiveNotebook,
  SweepOptions,
  ArchivalResult,
} from '../../notebooklm/chatArchiver';
import { listNotebooks } from '../../notebooklm/nlmCli';

export interface CliArchiveChatsOptions {
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  date?: string;
  concurrency?: number;
  kbVaultRoot?: string;
  localVaultRoot?: string;
}

export async function runArchiveChats(
  root: string,
  notebookId?: string,
  options: CliArchiveChatsOptions = {}
): Promise<{ success: boolean; results: ArchivalResult[]; message: string }> {
  const sweepOptions: SweepOptions = {
    date: options.date,
    dryRun: options.dryRun,
    force: options.force,
    concurrency: options.concurrency || 2,
    kbVaultRoot: options.kbVaultRoot,
    localVaultRoot: options.localVaultRoot,
  };

  if (notebookId) {
    const listRes = listNotebooks();
    if (!listRes.ok) {
      return {
        success: false,
        results: [],
        message: `Failed to retrieve notebook metadata: ${listRes.error}`,
      };
    }
    const found = (listRes.data || []).find((nb) => nb.id === notebookId);
    if (!found) {
      return {
        success: false,
        results: [],
        message: `Notebook ID ${notebookId} not found in Google NotebookLM account.`,
      };
    }

    const result = archiveNotebook(found, sweepOptions);
    return {
      success: !result.error,
      results: [result],
      message: result.error
        ? `Error archiving notebook ${found.title}: ${result.error}`
        : result.skipped
        ? `Notebook ${found.title} skipped: ${result.skipReason}`
        : `Successfully processed ${found.title} (${result.totalTurns} turns, noteCreated: ${result.noteCreated})`,
    };
  }

  if (options.all) {
    const { results, totalProcessed, totalTurns } = await runUniversalChatArchival(sweepOptions);
    const errors = results.filter((r) => r.error);
    const totalNotebooks = results.length;
    // Single-notebook isolation: isolated RPC timeouts/errors do not fail the universal sweep
    // as long as at least some notebooks succeeded or not all notebooks failed.
    const isCatastrophicFailure = totalNotebooks > 0 && errors.length === totalNotebooks;
    const success = !isCatastrophicFailure;

    return {
      success,
      results,
      message: errors.length > 0
        ? `Universal sweep complete with isolated errors: ${totalProcessed} notebook(s) processed, ${totalTurns} total turn(s) ingested, ${errors.length} isolated error(s) tolerated.`
        : `Universal sweep complete: ${totalProcessed} notebook(s) processed, ${totalTurns} total turn(s) ingested, 0 errors.`,
    };
  }

  return {
    success: false,
    results: [],
    message: 'Must specify a notebook ID or provide --all flag to execute universal sweep.',
  };
}
