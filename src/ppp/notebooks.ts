export interface PppNotebookMetadata {
  id: string;
  title: string;
  url: string;
  topic: 'trm-ppp';
  stagingPath: string;
}

export const PPP_NOTEBOOKS: Record<'exclusions' | 'facts' | 'leads', PppNotebookMetadata> = {
  exclusions: {
    id: '0bc4535a-ddf2-4582-b0ad-a855145bb13c',
    title: 'PPP-TX Exclusions',
    url: 'https://notebooklm.google.com/notebook/0bc4535a-ddf2-4582-b0ad-a855145bb13c',
    topic: 'trm-ppp',
    stagingPath: '_kb-sync-staging/trm-ppp/exclusions.nlm_pack.md',
  },
  facts: {
    id: 'b09286d8-655a-471b-974c-db6ad610eb8f',
    title: 'PPP-TX Facts',
    url: 'https://notebooklm.google.com/notebook/b09286d8-655a-471b-974c-db6ad610eb8f',
    topic: 'trm-ppp',
    stagingPath: '_kb-sync-staging/trm-ppp/facts.nlm_pack.md',
  },
  leads: {
    id: 'a554d4d9-aba8-4375-9d2c-cd6833fd8e1e',
    title: 'PPP-TX Leads',
    url: 'https://notebooklm.google.com/notebook/a554d4d9-aba8-4375-9d2c-cd6833fd8e1e',
    topic: 'trm-ppp',
    stagingPath: '_kb-sync-staging/trm-ppp/leads.nlm_pack.md',
  },
};
