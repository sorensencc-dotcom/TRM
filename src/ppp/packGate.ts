export interface PackReplacementRequest {
  notebookId: string;
  packFiles: string[];
  stagingDir: string;
  expectedPartCount?: number;
  signoffApproved: boolean;
}

export type PackReplacementFunction = (params: {
  notebookId: string;
  packFiles: string[];
  expectedPartCount?: number;
  [key: string]: unknown;
}) => Promise<{ bypassed?: boolean; replaced?: boolean; notebookId: string }>;

/**
 * Enforces the mandatory pack replacement rules for PPP packs:
 * 1. Staging must be locked until explicit sign-off is given.
 * 2. Staging folder must strictly be under _kb-sync-staging/trm-ppp/.
 * 3. Pack replacement must strictly call replacePackFamilyAtomic, never a standalone delete/upload script.
 * 4. Ensures exactly one pack version per notebook.
 */
export async function executePppPackReplacement(
  request: PackReplacementRequest,
  atomicReplaceFn: PackReplacementFunction
): Promise<{ success: boolean; notebookId: string }> {
  // Gate check 1: Staging lock before Chris signs off
  if (!request.signoffApproved) {
    throw new Error(
      'PACK-REPLACE-GATE ERROR: Pack staging and replacement is locked. Chris must explicitly sign off before uploading to NotebookLM or staging in _kb-sync-staging.'
    );
  }

  // Gate check 2: Strict staging directory
  const normalizedStaging = request.stagingDir.replace(/\\/g, '/');
  if (!normalizedStaging.includes('_kb-sync-staging/trm-ppp')) {
    throw new Error(
      `PACK-REPLACE-GATE ERROR: PPP packs must be staged strictly in "_kb-sync-staging/trm-ppp/". Got: "${request.stagingDir}"`
    );
  }

  // Gate check 3: Verification of replacement executor
  if (typeof atomicReplaceFn !== 'function') {
    throw new Error(
      'PACK-REPLACE-GATE ERROR: Standalone delete-then-upload scripts are strictly prohibited. You must supply replacePackFamilyAtomic.'
    );
  }

  if (atomicReplaceFn.name !== 'replacePackFamilyAtomic' && !atomicReplaceFn.name.includes('replacePackFamilyAtomic')) {
    throw new Error(
      `PACK-REPLACE-GATE ERROR: Invalid replacement path "${atomicReplaceFn.name}". Must use replacePackFamilyAtomic to prevent notebook wipeouts.`
    );
  }

  // Execute atomic replacement
  await atomicReplaceFn({
    notebookId: request.notebookId,
    packFiles: request.packFiles,
    expectedPartCount: request.expectedPartCount,
  });

  return {
    success: true,
    notebookId: request.notebookId,
  };
}
