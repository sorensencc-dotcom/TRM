import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runCrosslink } from '../../src/cli/commands/crosslink';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

describe('runCrosslink', () => {
  it('writes related_topics.json with a computed or given strength', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001', tags: ['history', 'industry'] });
    runCreate(root, 'willys', { actor: 'ACTOR-001', tags: ['industry'] });
    runCrosslink(root, 'cuba', { actor: 'ACTOR-001', relatedTopic: 'willys', relationship: 'industrial context overlap' });
    const related = JSON.parse(fs.readFileSync(path.join(root, 'topics', 'cuba', 'crosslinks', 'related_topics.json'), 'utf-8'));
    expect(related.related[0]).toMatchObject({ topic: 'willys', relationship: 'industrial context overlap' });
    expect(related.related[0].strength).toBeCloseTo(1 / 2);
  });

  it('writes treatment.json as a promotion pointer', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runCrosslink(root, 'cuba', {
      actor: 'ACTOR-001',
      treatmentSections: ['01_charlie'],
      promotionReason: 'High relevance',
    });
    const treatment = JSON.parse(fs.readFileSync(path.join(root, 'topics', 'cuba', 'crosslinks', 'treatment.json'), 'utf-8'));
    expect(treatment.treatment_sections).toEqual(['01_charlie']);
  });

  it('writes a tags-only CROSSLINK lineage op when no relatedTopic/treatmentSections given', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runCrosslink(root, 'cuba', { actor: 'ACTOR-001', tags: ['trm-feedback-report:v1'] });

    const lineage = JSON.parse(fs.readFileSync(path.join(root, 'topics', 'cuba', 'lineage', 'lineage.json'), 'utf-8'));
    const lastOp = lineage.operations[lineage.operations.length - 1];
    expect(lastOp.op).toBe('CROSSLINK');
    expect(lastOp.tags).toEqual(['trm-feedback-report:v1']);
  });

  it('attaches tags alongside a relatedTopic CROSSLINK op', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runCreate(root, 'willys', { actor: 'ACTOR-001' });
    runCrosslink(root, 'cuba', { actor: 'ACTOR-001', relatedTopic: 'willys', tags: ['trm-feedback-report:v1'] });

    const lineage = JSON.parse(fs.readFileSync(path.join(root, 'topics', 'cuba', 'lineage', 'lineage.json'), 'utf-8'));
    const lastOp = lineage.operations[lineage.operations.length - 1];
    expect(lastOp.tags).toEqual(['trm-feedback-report:v1']);
  });
});
