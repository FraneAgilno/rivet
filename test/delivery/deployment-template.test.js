import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const template = new URL('../../templates/github-actions/rivet-deploy.yml', import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = 'a'.repeat(40);
const operation = 'b'.repeat(64);
const event = () => ({
  repo: { owner: 'example', repo: 'project' }, runId: 123,
  payload: { deployment: { id: 42, task: 'rivet-deploy', environment: 'staging', sha, ref: sha,
    payload: { rivetOperation: operation, workflow: 'rivet-deploy.yml' } } },
});

test('deployment template gates exact commit and mandatory project verification', async () => {
  const workflow = parse(await readFile(template, 'utf8'));
  assert.deepEqual(workflow.on, { deployment: {} });
  assert.equal(workflow['run-name'], 'rivet-deploy:${{ github.event.deployment.payload.rivetOperation }}');
  assert.deepEqual(workflow.permissions, {});
  const job = workflow.jobs.deploy;
  assert.equal(job.environment, 'staging');
  assert.match(job.if, /deployment.task == 'rivet-deploy'/);
  assert.match(job.if, /deployment.environment == 'staging'/);
  assert.match(job.if, /deployment.payload.workflow == 'rivet-deploy.yml'/);
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.match(job.concurrency.group, /staging/);
  assert.deepEqual(job.permissions, { contents: 'read', deployments: 'write' });
  const steps = job.steps;
  const validate = steps.find(step => step.id === 'validate');
  assert.equal(steps[0], validate);
  const check = new AsyncFunction('context', 'core', validate.with.script);
  const core = { setFailed(message) { throw new Error(message); } };
  await check(event(), core);
  for (const mutation of [
    d => { d.sha = 'main'; }, d => { d.ref = 'main'; }, d => { d.ref = 'c'.repeat(40); },
    d => { d.task = 'another'; }, d => { d.environment = 'production'; },
    d => { d.payload.rivetOperation = '$(bad)'; }, d => { d.payload.workflow = 'other.yml'; },
    d => { d.payload = null; },
  ]) {
    const context = event(); mutation(context.payload.deployment);
    await assert.rejects(check(context, core));
  }
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.deployment.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const node = steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(String(node.with['node-version']), '22');
  assert.deepEqual(steps.filter(step => step.run).map(step => step.run), ['npm ci', 'npm run deploy', 'npm run verify:deployment']);
  for (const step of steps) {
    assert.equal(step['continue-on-error'], undefined);
    if (step.with?.script) assert.doesNotMatch(step.with.script, /\$\{\{/);
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
  }
  const statuses = steps.filter(step => step.id?.startsWith('status-'));
  assert.deepEqual(statuses.map(step => step.id), ['status-start', 'status-success', 'status-failure']);
  assert.ok(steps.indexOf(statuses[1]) > steps.findIndex(step => step.run === 'npm run verify:deployment'));
  assert.equal(statuses[1].if, 'success()');
  assert.match(statuses[2].if, /failure\(\)/);
  assert.match(statuses[2].if, /steps.validate.outcome == 'success'/);
  const calls = [];
  const github = { rest: { repos: { createDeploymentStatus: async input => calls.push(input) } } };
  for (const step of statuses) await new AsyncFunction('context', 'github', step.with.script)(event(), github);
  assert.deepEqual(calls.map(call => call.state), ['in_progress', 'success', 'failure']);
  assert.equal(calls[1].auto_inactive, false);
  for (const call of calls) {
    assert.equal(call.deployment_id, 42);
    assert.equal(call.log_url, 'https://github.com/example/project/actions/runs/123');
  }
});
