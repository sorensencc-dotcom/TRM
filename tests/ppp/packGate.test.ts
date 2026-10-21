import { executePppPackReplacement, PackReplacementRequest } from '../../src/ppp/packGate';

describe('PPP Texas - Pack Gate and Replace Invariants', () => {
  const dummyReplacePackFamilyAtomic = async function replacePackFamilyAtomic(params: any) {
    return { replaced: true, notebookId: params.notebookId };
  };

  const dummyStandaloneDeleteScript = async function standaloneDeleteThenUpload(params: any) {
    return { replaced: true, notebookId: params.notebookId };
  };

  it('rejects replacement when Chris sign-off has not been granted', async () => {
    const request: PackReplacementRequest = {
      notebookId: 'nb-ppp-facts-123',
      packFiles: ['_kb-sync-staging/trm-ppp/facts.nlm_pack.md'],
      stagingDir: '_kb-sync-staging/trm-ppp',
      signoffApproved: false,
    };

    await expect(
      executePppPackReplacement(request, dummyReplacePackFamilyAtomic)
    ).rejects.toThrow(/PACK-REPLACE-GATE ERROR: Pack staging and replacement is locked/);
  });

  it('rejects replacement when staging folder is outside trm-ppp', async () => {
    const request: PackReplacementRequest = {
      notebookId: 'nb-ppp-facts-123',
      packFiles: ['_kb-sync-staging/trm/facts.nlm_pack.md'],
      stagingDir: '_kb-sync-staging/trm',
      signoffApproved: true,
    };

    await expect(
      executePppPackReplacement(request, dummyReplacePackFamilyAtomic)
    ).rejects.toThrow(/PPP packs must be staged strictly in "_kb-sync-staging\/trm-ppp\/"/);
  });

  it('rejects standalone delete-then-upload scripts and enforces replacePackFamilyAtomic', async () => {
    const request: PackReplacementRequest = {
      notebookId: 'nb-ppp-facts-123',
      packFiles: ['_kb-sync-staging/trm-ppp/facts.nlm_pack.md'],
      stagingDir: '_kb-sync-staging/trm-ppp',
      signoffApproved: true,
    };

    await expect(
      executePppPackReplacement(request, dummyStandaloneDeleteScript)
    ).rejects.toThrow(/Must use replacePackFamilyAtomic to prevent notebook wipeouts/);
  });

  it('succeeds when sign-off is granted, staging is trm-ppp, and replacePackFamilyAtomic is used', async () => {
    const request: PackReplacementRequest = {
      notebookId: 'nb-ppp-facts-123',
      packFiles: ['_kb-sync-staging/trm-ppp/facts.nlm_pack.md'],
      stagingDir: '_kb-sync-staging/trm-ppp',
      signoffApproved: true,
    };

    const result = await executePppPackReplacement(request, dummyReplacePackFamilyAtomic);
    expect(result.success).toBe(true);
    expect(result.notebookId).toBe('nb-ppp-facts-123');
  });
});
