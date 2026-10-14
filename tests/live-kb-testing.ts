// Run separately from Jest: node -r ts-node/register tests/live-kb-testing.ts
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setupTestingSandbox, KB_TESTING_SANDBOX_UUID, KB_TESTING_FIXTURE_SOURCE_ID, readRegistry } from '../src/notebooklm/registry';
import { runMineNotebooklm, synthesizeDynamicQuestions, sleepSync } from '../src/cli/commands/mineNotebooklm';
import { listSources, listChats, getChatTranscript } from '../src/notebooklm/nlmCli';

if (process.env.NLM_LIVE_SANDBOX !== '1') {
  console.log('SKIP: set NLM_LIVE_SANDBOX=1 for real sandbox mining');
} else {
  const overrides = Object.keys(process.env).filter((key) => process.env[key] &&
    (/^(MOCK_|TEST_MOCK|NLM_CLI|NLM_BIN|NLM_COMMAND|TRM_NLM)/i.test(key) || key === 'NODE_OPTIONS'));
  assert.deepEqual(overrides, [], 'Live verification rejects inherited mock/CLI/module overrides');
  const root = path.resolve(process.env.TRM_KB_TESTING_ROOT || path.join(__dirname, '../node_modules/.cache', `kb-testing-live-${Date.now()}`));
  setupTestingSandbox(root);
  console.log(`Live sandbox evidence: ${root}`);
  const failures: string[] = [];
  const runs: unknown[] = [];
  const check = (name: string, action: () => void) => {
    try { action(); } catch (error) { failures.push(`${name}: ${(error as Error).message}`); }
  };
  const before = listSources(KB_TESTING_SANDBOX_UUID);
  assert.ok(before.ok, 'Live fixture listing must succeed');
  const questions = synthesizeDynamicQuestions({ notebook_id: KB_TESTING_SANDBOX_UUID, title: 'sandbox' });
  assert.equal(questions.length, 3);
  for (let run = 1; run <= 2; run++) {
    if (run > 1) sleepSync(3500);
    console.log(`[KB-TESTING] Starting battery ${run}/2`);
    const mined = runMineNotebooklm(root, KB_TESTING_SANDBOX_UUID, {});
    const evidence = JSON.parse(fs.readFileSync(path.join(root, 'kb-testing-evidence.json'), 'utf8'));
    check(`run ${run} completed battery`, () => assert.equal(evidence.length, 3));
    const chats = listChats(KB_TESTING_SANDBOX_UUID);
    const transcripts: unknown[] = [];
    for (let index = 0; index < evidence.length; index++) {
      const turn = evidence[index];
      check(`run ${run} ${turn.question.id}`, () => {
        assert.ok(turn.result.ok, JSON.stringify(turn.result));
        const data = turn.result.data;
        assert.equal(turn.question.id, questions[index].id);
        assert.ok(typeof data.answer === 'string' && data.answer.length > 60);
        if (index === 0) {
          assert.match(data.answer, /8765/);
          assert.match(data.answer, /WAL/i);
        } else if (index === 1) {
          assert.match(data.answer, /Ordenskapitlet/i);
          assert.match(data.answer, /(?:May\s+24,?\s+1930|24\s+May\s+1930)/i);
          assert.match(data.answer, /(?:July\s+27,?\s+1937|27\s+July\s+1937)/i);
          assert.match(data.answer, /Knight/i);
          assert.match(data.answer, /Commander/i);
          for (const gap of ['01', '27', '45']) assert.match(data.answer, new RegExp(`GAP[- ]?${gap}`));
        } else {
          assert.match(data.answer, /380\s*KiB/i);
          assert.match(data.answer, /389,?120\s*bytes/i);
          assert.match(data.answer, /3\.5[ -]*(?:second|s\b)/i);
        }
        assert.deepEqual(data.sources_used, [KB_TESTING_FIXTURE_SOURCE_ID]);
        const citedSources = Object.values(data.citations || {});
        assert.ok(citedSources.length > 0 && citedSources.every((id) => id === KB_TESTING_FIXTURE_SOURCE_ID), 'every structured citation must identify fixture');
        assert.ok(data.references?.length > 0 && data.references.every((ref: { source_id: string }) => ref.source_id === KB_TESTING_FIXTURE_SOURCE_ID), 'every structured reference must identify fixture');
        assert.ok(typeof data.conversation_id === 'string' && data.conversation_id.length > 0);
        if (index > 0) assert.ok(Date.parse(turn.queried_at) - Date.parse(evidence[index - 1].queried_at) >= 3500, 'live pacing below 3.5 seconds');
      });
      if (turn.result.ok && turn.result.data.conversation_id) {
        const transcript = getChatTranscript(KB_TESTING_SANDBOX_UUID, turn.result.data.conversation_id);
        transcripts.push(transcript);
        check(`run ${run} ${turn.question.id} remote visibility`, () => {
          assert.ok(chats.ok, 'chats list failed');
          assert.ok(chats.data.sessions.some((session) => session.conversation_id === turn.result.data.conversation_id), 'session missing from remote chat list');
          assert.ok(transcript.ok, 'chat transcript lookup failed');
          assert.ok(transcript.data.transcript?.some((item) => item.query === turn.question.text && item.answer === turn.result.data.answer), 'remote transcript does not contain recorded question and answer');
        });
      }
    }
    check(`run ${run} isolated repeat effects`, () => {
      const doc = fs.readFileSync(path.join(root, mined.docPath), 'utf8');
      assert.equal(doc.split('\n').filter((line) => line.startsWith('| For Entity')).length, 3);
      assert.ok(!fs.existsSync(path.join(root, 'TODOS.md')));
      assert.deepEqual(readRegistry(root).notebooks[0].research_queue, {});
    });
    runs.push({ run, mined, evidence, chats, transcripts });
    fs.writeFileSync(path.join(root, 'live-verification.json'), JSON.stringify({ root, runs, failures }, null, 2));
  }
  const after = listSources(KB_TESTING_SANDBOX_UUID);
  check('source list unchanged', () => {
    assert.ok(before.ok && after.ok);
    assert.deepEqual(after.data.map((source) => source.id).sort(), before.data.map((source) => source.id).sort());
  });
  fs.writeFileSync(path.join(root, 'live-verification.json'), JSON.stringify({ root, runs, before, after, failures }, null, 2));
  assert.deepEqual(failures, [], `Live acceptance failed; evidence retained in ${root}`);
  console.log('PASS: all three facts, citations, transcripts, pacing, and repeat-run isolation');
}
