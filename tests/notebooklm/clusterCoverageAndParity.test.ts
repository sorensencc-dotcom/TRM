import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRegistry } from '../../src/notebooklm/registry';
import { loadMiningQuestions } from '../../src/cli/commands/mineNotebooklm';
import { slugifyTitle } from '../../src/notebooklm/stagingName';

describe('Cluster Coverage & Parity Audit Suite', () => {
  const VAULT_REGISTRY_PATH = 'C:/Users/soren/trm-vault/notebooklm-registry.json';
  const DEV_REGISTRY_PATH = 'C:/dev/notebooklm-registry.json';
  const DRIVE_MIRROR_ROOT = 'G:/My Drive/notebooklm';

  const CANONICAL_21_CLUSTER: Record<string, { id: string; category: string }> = {
    // Domain 1: Historical Workstreams (CIC)
    'CIC - Willow Run & Aviation Engineering': { id: '6fd7c40b-df90-444b-9c7a-a64682925856', category: 'research' },
    'CIC - Ford Executive Dynamics & Politics': { id: '0caf6707-f8f2-4d2a-acd2-020acead55ba', category: 'research' },
    'CIC - Post-War': { id: '9c469910-a900-43a4-877c-a43c9f545b5f', category: 'research' },
    'CIC - Willys-Overland': { id: 'fd4ebe29-9440-4f4b-97cf-0184ffbe29a0', category: 'research' },
    'CIC - Cuban Seizures & Retired Assets': { id: 'c8360946-dbee-4a2c-b622-7f89b05695b0', category: 'research' },
    'CIC - Miami Estate & Florida Retirement': { id: '64949154-5892-4fa4-9ad0-e48b2bf5cc6c', category: 'research' },
    'CIC - Rouge, Model T & Moving Assembly Line': { id: '70be0df3-c58a-4711-b4d3-1e4b8726faf7', category: 'research' },
    'CIC-KB': { id: '679b8bab-2d87-42cb-a726-6dc54c83acc2', category: 'research' },
    'CIC - Daily Research': { id: '1b4861a3-931f-4632-8fc1-343a8dd37df8', category: 'research' },

    // Domain 2: Core Software Architecture & Dev
    'IronLedger Architecture': { id: '76e1932c-054a-4520-9e83-5e882dffc938', category: 'operational' },
    'Sigil Protocol & Federation': { id: '26eacb85-2c97-443d-9d81-3bd99cc98412', category: 'operational' },
    'Agent Harnesses & Local Execution (Graft, SAM, Herdr)': { id: '359b346c-6af7-4ba3-baef-b985c9e6e1af', category: 'operational' },
    'Rewrite Labs SSG/Redesign Platform': { id: '140119ae-3496-45c9-bf0c-71c955136afc', category: 'operational' },
    'Open Dev Issues (CI/CD Triage Buffer)': { id: 'cb0498ce-1ea5-4668-9f65-ac368753404e', category: 'operational' },

    // 7 Canonical KB Notebooks
    'KB - Governance': { id: 'b42534be-a208-437e-828e-dad645631c66', category: 'operational' },
    'KB - Modules': { id: '096b5b92-55d0-44b2-b074-3b3fef0a0d12', category: 'operational' },
    'KB - Skills': { id: '3ac216cc-3379-4c9f-8393-ab28a248cecc', category: 'operational' },
    'KB - Operations': { id: '1ab8f1a2-f066-4246-8489-75f223d5f9d2', category: 'operational' },
    'KB - Meta': { id: '30f80cc0-80f7-421a-a79b-c510d98aaf94', category: 'operational' },
    'KB - Targets': { id: '0cab9d12-0f0e-4cc0-9009-69ec809fce4a', category: 'operational' },
    'KB - Superpowers': { id: '95867d03-1175-4516-9b38-d95592b1a321', category: 'operational' },

    // Domain 3: Personal OS
    'Personal OS (Household, Utilities, Florida Logistics)': { id: '9724e682-c5ea-4693-8e21-caf8de68611e', category: 'operational' },
  };

  const OPERATIONAL_BUFFERS: Record<string, string> = {
    'Grok Bot Automation': '52332bef-552c-427a-afb5-8cc48e6f0079',
    'AI News and Tools': 'bec5a197-8256-4eba-af78-c4881cc28fdd',
    'Toolforge Ecosystem': '39a71593-eb5b-4605-a4a4-f212ae010da2',
  };

  describe('Registry Coverage & Partition Invariants', () => {
    it('vault registry contains 100% of canonical cluster notebooks', () => {
      expect(fs.existsSync(VAULT_REGISTRY_PATH)).toBe(true);
      const registry = JSON.parse(fs.readFileSync(VAULT_REGISTRY_PATH, 'utf-8'));
      const registeredIds = new Set(registry.notebooks.map((n: { notebook_id: string }) => n.notebook_id));

      for (const [title, meta] of Object.entries(CANONICAL_21_CLUSTER)) {
        expect(registeredIds.has(meta.id)).toBe(true);
      }
    });

    it('dev registry contains all 3 operational buffers', () => {
      expect(fs.existsSync(DEV_REGISTRY_PATH)).toBe(true);
      const registry = JSON.parse(fs.readFileSync(DEV_REGISTRY_PATH, 'utf-8'));
      const registeredIds = new Set(registry.notebooks.map((n: { notebook_id: string }) => n.notebook_id));

      for (const [name, id] of Object.entries(OPERATIONAL_BUFFERS)) {
        expect(registeredIds.has(id)).toBe(true);
      }
    });

    it('all 7 Canonical KB packs are explicitly categorized as operational', () => {
      const registry = JSON.parse(fs.readFileSync(VAULT_REGISTRY_PATH, 'utf-8'));
      const kbPacks = [
        'b42534be-a208-437e-828e-dad645631c66',
        '096b5b92-55d0-44b2-b074-3b3fef0a0d12',
        '3ac216cc-3379-4c9f-8393-ab28a248cecc',
        '1ab8f1a2-f066-4246-8489-75f223d5f9d2',
        '30f80cc0-80f7-421a-a79b-c510d98aaf94',
        '0cab9d12-0f0e-4cc0-9009-69ec809fce4a',
        '95867d03-1175-4516-9b38-d95592b1a321',
      ];

      for (const id of kbPacks) {
        const found = registry.notebooks.find((n: { notebook_id: string }) => n.notebook_id === id);
        expect(found).toBeDefined();
        expect(found.category).toBe('operational');
      }
    });
  });

  describe('Google Drive Mirror Directory Parity', () => {
    it('verifies mirror directories exist for all canonical and operational targets', () => {
      expect(fs.existsSync(DRIVE_MIRROR_ROOT)).toBe(true);

      const requiredSlugs = [
        'kb-governance',
        'kb-modules',
        'kb-skills',
        'kb-operations',
        'kb-meta',
        'kb-targets',
        'kb-superpowers',
        'open-dev-issues',
        'personal-os',
        'grok-bot-automation',
        'ai-news-and-tools',
        'toolforge-ecosystem',
        'rewrite-labs',
        'sigil',
        'ironledger',
        'agent-harness',
      ];

      for (const slug of requiredSlugs) {
        const targetDir = path.join(DRIVE_MIRROR_ROOT, slug);
        expect(fs.existsSync(targetDir)).toBe(true);
      }
    });
  });

  describe('Question Battery Separation & Entropy', () => {
    it('enforces 0% question overlap between operational and research batteries', () => {
      const researchQuestions = loadMiningQuestions(undefined, 'research');
      const operationalQuestions = loadMiningQuestions(undefined, 'operational');

      const researchTexts = new Set(researchQuestions.map((q) => q.text.trim().toLowerCase()));
      const operationalTexts = new Set(operationalQuestions.map((q) => q.text.trim().toLowerCase()));

      for (const q of operationalTexts) {
        expect(researchTexts.has(q)).toBe(false);
      }
    });

    it('operational battery targets blockers, validation gaps, tooling, and system ROI', () => {
      const operationalQuestions = loadMiningQuestions(undefined, 'operational');
      const ids = operationalQuestions.map((q) => q.id);

      expect(ids).toContain('unresolved-bottlenecks');
      expect(ids).toContain('unverified-assumptions');
      expect(ids).toContain('tooling-gaps');
      expect(ids).toContain('system-improvements');
    });
  });
});
