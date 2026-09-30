import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'fieldkit-compat-'));
try {
  const run = (mode: string) => {
    const p = spawnSync(process.execPath, ['--import', 'tsx', 'tests/compat-worker.ts', join(dir, 'checkpoints.sqlite'), mode], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  const paused = run('start');
  assert.equal(paused.result.__interrupt__[0].value.reference, 'immutable-proposal-1');
  assert.deepEqual(paused.snapshot.next, ['approval']);
  const resumed = run('resume');
  assert.equal(resumed.result.answer, 'approved');
  assert.deepEqual(resumed.snapshot.next, []);
  console.log('PASS: real LangGraph + SQLite interrupt persisted; fresh process resumed the same thread.');
} finally { rmSync(dir, { recursive: true, force: true }); }
