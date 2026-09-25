import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkRequest } from '../../src/work-request/contract.js';
import { resolveHostWorkRequest } from '../../src/work-request/host.js';
import { trackerTargetFromRun } from '../../src/delivery/tracker-target.js';
const capturedAt = '2026-09-25T10:00:00.000Z';
const candidate = {runId:'run-one'};
function run(workRequest) {
  return {runId:candidate.runId,workRequest,featurePlan:{workRequestDigest:workRequest.digest}};
}
function direct(kind='jira', url='https://tracker.example.test/browse/DEMO-1') {
  return createWorkRequest({source:{kind,ref:'DEMO-1',url,revision:'1'},title:'Task',description:'Build it.',acceptanceCriteria:['Works.'],contextRefs:[],capturedAt});
}
function host() {
  const provider={id:'tracker',kind:'jira',mode:'read-only',transport:'harness-mcp',capabilities:['issues-read'],tools:['get_issue']};
  const observation = id => ({schemaVersion:1,providerId:'tracker',projectId:'demo',tool:'get_issue',resourceId:id,sourceUrl:`https://tracker.example.test/browse/${id}`,revision:'1',capturedAt,content:{title:`Task ${id}`,description:'Build it.',acceptanceCriteria:['Works.']}});
  return resolveHostWorkRequest({config:{project:{id:'demo'},providers:{providers:[provider]}},bundle:{schemaVersion:1,projectId:'demo',host:{projectId:'demo',providers:[{id:'tracker',authenticated:true,tools:['get_issue']}]},request:{providerId:'tracker',resourceId:'DEMO-1'},observations:[observation('DEMO-2'),observation('DEMO-1')]},capturedAt});
}
test('derives direct tracker target only from the digest-bound run',()=>{
  for(const [kind,url] of [['jira','https://tracker.example.test/browse/DEMO-1'],['linear','https://linear.app/team/issue/DEMO-1/title']]) {
    const request=direct(kind,url);
    assert.deepEqual(trackerTargetFromRun(run(request),candidate),{kind,issueKey:'DEMO-1',issueUrl:url,requestDigest:request.digest});
  }
  const value=run(direct());
  for(const change of [r=>r.runId='other',r=>r.featurePlan.workRequestDigest='a'.repeat(64),r=>r.workRequest={...r.workRequest,title:'tampered'}]) {
    const copy=structuredClone(value);change(copy);assert.throws(()=>trackerTargetFromRun(copy,candidate),{code:'ERR_DELIVERY_TRACKER_TARGET'});
  }
});
test('selects the bound primary host tracker, never an arbitrary linked issue',()=>{
  const request=host();
  assert.equal(trackerTargetFromRun(run(request),candidate).issueKey,'DEMO-1');
  const copy=structuredClone(request);delete copy.schemaVersion;delete copy.digest;
  copy.context.sources.reverse();
  assert.throws(()=>trackerTargetFromRun(run({...copy,schemaVersion:1,digest:request.digest}),candidate),{code:'ERR_DELIVERY_TRACKER_TARGET'});
});
test('rejects local requests, absent URLs, and mismatched issue URL identities',()=>{
  const local=createWorkRequest({source:{kind:'inline',ref:'inline'},title:'Task',description:'Build it.',acceptanceCriteria:['Works.'],contextRefs:[],capturedAt});
  assert.throws(()=>trackerTargetFromRun(run(local),candidate),{code:'ERR_DELIVERY_TRACKER_TARGET'});
  assert.throws(()=>trackerTargetFromRun(run(direct('jira','https://tracker.example.test/browse/DEMO-2')),candidate),{code:'ERR_DELIVERY_TRACKER_TARGET'});
  const input=structuredClone(direct());delete input.schemaVersion;delete input.digest;delete input.source.url;
  assert.throws(()=>trackerTargetFromRun(run(createWorkRequest(input)),candidate),{code:'ERR_DELIVERY_TRACKER_TARGET'});
});

test('rejects digest-valid host requests whose normalized content does not match the primary source',()=>{
  const input=structuredClone(host());delete input.schemaVersion;delete input.digest;
  input.title='A different task';
  const request=createWorkRequest(input);
  assert.throws(()=>trackerTargetFromRun(run(request),candidate),{code:'ERR_DELIVERY_TRACKER_TARGET'});
});
