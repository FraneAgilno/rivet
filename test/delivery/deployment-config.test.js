import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig } from '../../src/config/load.js';
import { validateProjectConfiguration } from '../../src/config/validate.js';
const root = fileURLToPath(new URL('../fixtures/config/valid', import.meta.url));
const deployment = {providerId:'git-ci-main',workflow:'rivet-deploy.yml',environment:'staging',productionEnvironment:false};
test('project deployment configuration is optional and accepts an explicit scoped workflow target', async()=> {
  const config=structuredClone(await loadProjectConfig(root));
  assert.equal(validateProjectConfiguration(config),true);
  config.project.deployment=deployment;
  assert.equal(validateProjectConfiguration(config),true);
});
test('deployment configuration rejects unsafe filenames, unknown providers and missing explicit environment classification', async()=> {
  for (const patch of [{workflow:'../deploy.yml'},{workflow:'deploy.yml?x'},{providerId:'missing'},{environment:'staging\nproduction'},{productionEnvironment:undefined},{command:'arbitrary'}]) {
    const config=structuredClone(await loadProjectConfig(root));
    config.project.deployment={...deployment,...patch};
    if(patch.productionEnvironment===undefined && Object.hasOwn(patch,'productionEnvironment')) delete config.project.deployment.productionEnvironment;
    assert.throws(()=>validateProjectConfiguration(config));
  }
});
