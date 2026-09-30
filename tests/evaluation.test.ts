import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, id } from '../packages/core/src/store.js';
import { seed } from '../packages/connectors/src/adapters.js';
import { demoActor } from '../packages/core/src/services.js';
import { Runtime } from '../packages/workflows/src/runtime.js';
import { BASE_CASES, generateCases } from '../packages/evals/src/cases.js';
import { makeReport, executeReport, readiness, rerun, decideSandbox } from '../packages/evals/src/harness.js';
import { ConfigSchema } from '../packages/core/src/types.js';

test('independent case labels, seeded meaningful variations, actual smoke failures and empty readiness',async()=>{
  assert.equal(BASE_CASES.length,64);assert.equal(new Set(BASE_CASES.map(c=>c.family)).size,64);assert.equal(generateCases('full',42).length,640);assert.deepEqual(generateCases('full',42),generateCases('full',42));assert.notDeepEqual(generateCases('full',42),generateCases('full',7));
  const dir=mkdtempSync(join(tmpdir(),'fieldkit-eval-')),s=new Store(dir);seed(s,'acme');
  try{assert.equal(readiness(s,'acme').status,'NOT READY');assert.throws(()=>ConfigSchema.parse({...s.config('acme'),unsupported:true}));
    const report=await executeReport(s,makeReport(s,'acme','smoke',42));assert.equal(report.status,'complete');assert.equal(report.metrics.taskSuccess.numerator,8);assert.equal(report.metrics.taskSuccess.denominator,9);assert.equal(report.metrics.safety.numerator,9);assert.equal(report.results.filter(c=>!c.passed)[0].family,'heldout-reversal');
    const traces=s.reports<{trace:{run:{threadId:string};workflow:{history:unknown[]}}}>('acme','eval-trace');assert.equal(new Set(traces.map(t=>t.trace.run.threadId)).size,9);assert.ok(traces.every(t=>t.trace.workflow.history.length>0));assert.equal(s.runs('acme').length,0);assert.equal(s.list('acme','receipt').length,0);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('sandbox approval uses a new decision and never changes the original ledger',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fieldkit-sandbox-')),r=new Runtime(new Store(dir));seed(r.store,'acme');
  try{const original=r.start(demoActor('acme'),{text:'Refund annual $8000 duplicate',requestKey:id(),channel:'api'});await r.drain();const copy=await rerun(r.store,r.store.run('acme',original.id));assert.equal(copy.trace.run.stage,'WAITING_FOR_APPROVAL');await assert.rejects(decideSandbox(r.store,demoActor('acme'),copy.trace.run.id,'approve'),/authorized/);const done=await decideSandbox(r.store,demoActor('acme',true),copy.trace.run.id,'approve');assert.equal(done.trace.run.stage,'COMPLETED');assert.equal(done.trace.run.receipt?.amountMinor,800000);assert.equal(r.store.list('acme','receipt').length,0);assert.equal(r.store.run('acme',original.id).stage,'WAITING_FOR_APPROVAL');}finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});
