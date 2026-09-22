import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { main } from '../../src/cli/main.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { loadProjectConfig } from '../../src/config/load.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATE_ROOT = join(REPOSITORY_ROOT, 'templates', 'conference-planner');
const DIST_TEMPLATE_ROOT = join(REPOSITORY_ROOT, 'dist', 'v2', 'templates', 'conference-planner');
const PROJECT_NAME = 'agilno-conference-planner';
const execFile = promisify(execFileCallback);

async function loadDemoModule() {
  return import('../../src/commands/demo.js');
}

async function emptyTarget(prefix = 'agilno-demo-target-') {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function manifest(root, relativeRoot = '') {
  const results = [];
  const directory = join(root, relativeRoot);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    if (entry.isDirectory()) results.push(...await manifest(root, relativePath));
    else {
      const bytes = await readFile(join(root, relativePath));
      results.push([relativePath, createHash('sha256').update(bytes).digest('hex')]);
    }
  }
  return results;
}

async function cloneTemplate() {
  const packageRoot = await realpath(await mkdtemp(join(tmpdir(), 'agilno-demo-package-')));
  const templateRoot = join(packageRoot, 'templates', 'conference-planner');
  await mkdir(dirname(templateRoot), { recursive: true });
  await cp(TEMPLATE_ROOT, templateRoot, { recursive: true, preserveTimestamps: true });
  return { packageRoot, templateRoot };
}

async function writeFakeGit(gitWorktree) {
  const gitDirectory = join(gitWorktree, '.git');
  await mkdir(gitDirectory);
  await writeFile(join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(gitDirectory, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
}

function captureOutput() {
  const stdout = [];
  const stderr = [];
  return {
    output: createOutput({
      stdout: { write: value => stdout.push(String(value)) },
      stderr: { write: value => stderr.push(String(value)) },
    }),
    stdout,
    stderr,
  };
}

function secretMatches(source) {
  return /(?:gh[pousr]_|github_pat_|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|figma(?:Token|AccessToken)\s*[=:]\s*["'][^"']+)/i.test(source);
}

test('demo create produces an isolated, secret-free, schema-valid Next.js repository', async () => {
  const { createDemo } = await loadDemoModule();
  const target = await emptyTarget();

  const result = await createDemo({ target, name: PROJECT_NAME });

  assert.deepEqual(result, {
    target,
    name: PROJECT_NAME,
    gitInitialized: false,
    nextSteps: ['npm ci', 'npm run check'],
  });
  const required = [
    '.rivet/project.yaml',
    '.rivet/providers.yaml',
    '.rivet/orchestration.yaml',
    '.rivet/quality.yaml',
    'bitbucket-pipelines.yml',
    '.storybook/main.ts',
    '.storybook/preview.ts',
    'DESIGN.md',
    'design/design-system-manifest.json',
    'package.json',
    'package-lock.json',
    'playwright.config.ts',
    'src/app/api/agenda/route.ts',
    'src/app/api/agenda/route.test.ts',
    'src/app/agenda/page.tsx',
    'src/app/layout.tsx',
    'src/app/page.tsx',
    'src/components/Button/Button.stories.tsx',
    'src/components/Button/Button.test.tsx',
    'src/components/Button/Button.tsx',
    'src/components/Button/Button.module.css',
    'src/components/ConflictDialog/ConflictDialog.stories.tsx',
    'src/components/ConflictDialog/ConflictDialog.test.tsx',
    'src/components/ConflictDialog/ConflictDialog.tsx',
    'src/components/ConflictDialog/ConflictDialog.module.css',
    'src/components/SessionCard/SessionCard.stories.tsx',
    'src/components/SessionCard/SessionCard.test.tsx',
    'src/components/SessionCard/SessionCard.tsx',
    'src/components/SessionCard/SessionCard.module.css',
    'src/domain/conference.ts',
    'src/domain/agenda.test.ts',
    'src/domain/agenda.ts',
    'src/domain/sessions.ts',
    'src/features/agenda/ConferencePlanner.module.css',
    'src/features/agenda/ConferencePlanner.test.tsx',
    'src/features/agenda/ConferencePlanner.tsx',
    'src/server/agenda-cookie.test.ts',
    'src/server/agenda-cookie.ts',
    'src/styles/tokens.css',
    'tests/conference.test.ts',
    'tests/page.test.tsx',
    'tests/storybook/components.spec.ts',
    'tests/storybook/playwright.config.ts',
  ];
  const paths = new Set((await manifest(target)).map(([path]) => path));
  for (const path of required) assert.equal(paths.has(path), true, `missing ${path}`);
  assert.equal([...paths].some(path => path === '.github' || path.startsWith('.github/')), false);
  assert.equal(paths.has('.gitlab-ci.yml'), false);
  assert.equal(paths.has('design/figma-manifest.json'), false);
  assert.equal(paths.has('.git'), false);
  assert.equal(paths.has('node_modules'), false);

  const packageJson = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, PROJECT_NAME);
  assert.match(packageJson.dependencies.next, /^15\.\d+\.\d+$/);
  assert.match(packageJson.dependencies.react, /^19\.\d+\.\d+$/);
  assert.match(packageJson.dependencies['react-dom'], /^19\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies['@storybook/react-vite'] ?? '', /^8\.6\.\d+$/);
  assert.equal(packageJson.devDependencies['@storybook/addon-a11y'], '8.6.18');
  assert.equal(packageJson.devDependencies.vite, '6.4.3');
  assert.equal(packageJson.devDependencies.vitest, '3.2.7');
  assert.equal(packageJson.devDependencies['@storybook/nextjs'], undefined);
  assert.equal(packageJson.overrides.postcss, '8.5.24');
  assert.equal(packageJson.overrides.sharp, '0.35.0');
  assert.equal(packageJson.overrides.rollup, '4.59.0');
  assert.equal(packageJson.overrides.uuid, '11.1.1');
  assert.match(packageJson.scripts['build-storybook'], /--disable-telemetry/);
  for (const version of [...Object.values(packageJson.dependencies), ...Object.values(packageJson.devDependencies)]) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `dependency must be pinned: ${version}`);
  }
  for (const script of [
    'build',
    'check',
    'lint',
    'storybook',
    'storybook:build',
    'test',
    'test:e2e',
    'test:storybook',
    'test:unit',
    'typecheck',
  ]) {
    assert.equal(typeof packageJson.scripts[script], 'string', `missing script ${script}`);
  }

  const lock = JSON.parse(await readFile(join(target, 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, PROJECT_NAME);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].dependencies.next, packageJson.dependencies.next);
  assert.equal(lock.packages[''].dependencies.react, packageJson.dependencies.react);
  assert.equal(lock.packages[''].devDependencies.vite, packageJson.devDependencies.vite);
  assert.equal(lock.packages[''].devDependencies.vitest, packageJson.devDependencies.vitest);
  assert.equal(lock.packages['node_modules/postcss'].version, packageJson.overrides.postcss);
  assert.equal(lock.packages['node_modules/rollup'].version, packageJson.overrides.rollup);
  assert.equal(lock.packages['node_modules/sharp'].version, packageJson.overrides.sharp);
  assert.equal(lock.packages['node_modules/uuid'].version, packageJson.overrides.uuid);
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (path.startsWith('node_modules/') && metadata.link !== true) {
      assert.match(metadata.version ?? '', /^\d+\.\d+\.\d+/, `lock entry must have a version: ${path}`);
    }
  }

  const config = await loadProjectConfig(target);
  assert.equal(config.project.id, PROJECT_NAME);
  assert.equal(config.project.stack.framework, 'nextjs');
  assert.equal(config.orchestration.enabled, false);
  assert.equal(config.providers.providers.some(provider => provider.kind === 'figma'), false);

  const allText = (await Promise.all((await manifest(target)).map(async ([path]) => {
    const data = await readFile(join(target, path));
    return data.includes(0) ? '' : data.toString('utf8');
  }))).join('\n');
  assert.equal(secretMatches(allText), false);
  assert.doesNotMatch(allText, /__PROJECT_NAME__/);
  assert.doesNotMatch(allText, /ClientCompany|PrivateProduct/i);
  assert.doesNotMatch(allText, /FIGMA_|figma/i);
  assert.doesNotMatch(allText, /untitled\s*ui|@untitled-ui/i);
});

test('template documents compatibility and contains deterministic conference and cookie groundwork', async () => {
  const { createDemo } = await loadDemoModule();
  const target = await emptyTarget();
  await createDemo({ target, name: PROJECT_NAME });

  const readme = await readFile(join(target, 'README.md'), 'utf8');
  assert.match(readme, /Next\.js 15/i);
  assert.match(readme, /Amplify/i);
  assert.match(readme, /DEMO_SESSION_SECRET/);

  const domain = await readFile(join(target, 'src/domain/sessions.ts'), 'utf8');
  for (const field of ['id:', 'startsAt:', 'endsAt:', 'track:', 'speakers:', 'room:', 'capacity:']) {
    assert.match(domain, new RegExp(field));
  }
  assert.match(domain, /session-opening-keynote/);
  assert.match(domain, /2026-10-15T09:00:00\.000Z/);

  const cookie = await readFile(join(target, 'src/server/agenda-cookie.ts'), 'utf8');
  assert.match(cookie, /crypto\.subtle\.sign/);
  assert.match(cookie, /crypto\.subtle\.verify/);
  assert.match(cookie, /HMAC/);
  const route = await readFile(join(target, 'src/app/api/agenda/route.ts'), 'utf8');
  assert.match(route, /httpOnly:\s*true/);
  assert.match(route, /sameSite:\s*['"]lax['"]/);
  assert.match(route, /DEMO_SESSION_SECRET/);
  assert.doesNotMatch(route, /prisma|dynamodb|postgres|mysql|mongodb/i);

  const design = JSON.parse(await readFile(join(target, 'design/design-system-manifest.json'), 'utf8'));
  assert.deepEqual(design.source, {
    kind: 'original-custom',
    owner: 'Agilno',
    externalProvider: null,
  });
  assert.deepEqual(design.designMethod, {
    kind: 'impeccable-guided',
    systemDocument: 'DESIGN.md',
    implementationOwner: 'Agilno',
    externalRuntimeRequired: false,
  });
  assert.equal(design.semanticTokens.source, 'src/styles/tokens.css');
  assert.ok(design.semanticTokens.names.length >= 12);
  assert.ok(design.semanticTokens.names.every(token => /^--[a-z0-9-]+$/.test(token)));
  assert.deepEqual(design.components.map(component => component.name), [
    'Button',
    'SessionCard',
    'ConflictDialog',
  ]);
  assert.ok(design.components.every(component => (
    component.states.length > 0 && component.states.every(state => /^[a-z][a-z0-9-]*$/.test(state))
  )));
  assert.deepEqual(design.viewports, [
    { id: 'mobile', width: 320, height: 800 },
    { id: 'desktop', width: 1280, height: 800 },
  ]);
  assert.deepEqual(design.accessibility, {
    storybookAddon: '@storybook/addon-a11y',
    standards: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    interactionSuite: 'tests/storybook/components.spec.ts',
  });
  assert.deepEqual(design.visualBaseline, {
    status: 'pending-human-approval',
    snapshots: [],
  });
  assert.equal(Object.values(design).some(secretMatches), false);

  const designGuide = await readFile(join(target, 'DESIGN.md'), 'utf8');
  for (const heading of [
    '# Conference Planner Design System',
    '## Product mode',
    '## Design principles',
    '## Tokens',
    '## Component contracts',
    '## Accessibility and interaction',
    '## Responsive behavior',
    '## Design review workflow',
    '## Anti-patterns',
  ]) assert.match(designGuide, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(designGuide, /Impeccable-guided/i);
  assert.match(designGuide, /original Agilno/i);
  assert.match(designGuide, /audit.*polish.*typeset.*distill/is);
  assert.doesNotMatch(designGuide, /Figma|Untitled UI/i);

  const tokens = await readFile(join(target, 'src/styles/tokens.css'), 'utf8');
  assert.match(tokens, /--color-action-primary:/);
  assert.match(tokens, /--space-component-md:/);
  assert.match(tokens, /--radius-component:/);
  assert.match(tokens, /@media \(min-width: 48rem\)/);
  for (const component of ['Button', 'SessionCard', 'ConflictDialog']) {
    const source = await readFile(join(target, `src/components/${component}/${component}.tsx`), 'utf8');
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\brgba?\(/i, `${component} must not scatter raw color values`);
    const styles = await readFile(join(target, `src/components/${component}/${component}.module.css`), 'utf8');
    assert.match(styles, /var\(--[a-z0-9-]+\)/, `${component} must consume semantic CSS tokens`);
    assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(/i, `${component} must not scatter raw color values`);
  }

  const vitestConfig = await readFile(join(target, 'vitest.config.ts'), 'utf8');
  assert.match(vitestConfig, /resolve:/);
  assert.match(vitestConfig, /alias:/);
  assert.match(vitestConfig, /fileURLToPath\(new URL\(['"]\.\/src['"], import\.meta\.url\)\)/);
  assert.match(vitestConfig, /jsx:\s*['"]automatic['"]/);

  const storybookConfig = await readFile(join(target, '.storybook/main.ts'), 'utf8');
  assert.match(storybookConfig, /['"]@storybook\/addon-a11y['"]/, 'Storybook must execute a11y parameters');
  const storybookPreview = await readFile(join(target, '.storybook/preview.ts'), 'utf8');
  assert.match(
    storybookPreview,
    /a11y:\s*\{\s*manual:\s*true,\s*test:\s*['"]error['"]\s*\}/,
    'Playwright must be the sole automated axe owner while the addon remains available manually',
  );
});

test('demo generation is byte-for-byte deterministic for the same project name', async () => {
  const { createDemo } = await loadDemoModule();
  const first = await emptyTarget('agilno-demo-first-');
  const second = await emptyTarget('agilno-demo-second-');
  await createDemo({ target: first, name: PROJECT_NAME });
  await createDemo({ target: second, name: PROJECT_NAME });
  assert.deepEqual(await manifest(first), await manifest(second));
});

test('source and built conference templates remain byte-for-byte identical', async () => {
  assert.deepEqual(await manifest(TEMPLATE_ROOT), await manifest(DIST_TEMPLATE_ROOT));
});

test('generated template uses verification-only Bitbucket Pipelines and no competing CI', async () => {
  const { createDemo } = await loadDemoModule();
  const target = await emptyTarget();
  await createDemo({ target, name: PROJECT_NAME });

  for (const root of [TEMPLATE_ROOT, DIST_TEMPLATE_ROOT, target]) {
    const paths = new Set((await manifest(root)).map(([path]) => path));
    assert.equal(paths.has('bitbucket-pipelines.yml'), true, `${root} must contain Bitbucket Pipelines`);
    assert.equal([...paths].some(path => path === '.github' || path.startsWith('.github/')), false, `${root} must not contain .github`);
    assert.equal(paths.has('.gitlab-ci.yml'), false, `${root} must not contain GitLab CI`);
  }

  const pipeline = await readFile(join(target, 'bitbucket-pipelines.yml'), 'utf8');
  assert.match(pipeline, /^image: node:22\.18\.0-bookworm$/m);
  for (const command of [
    'npm ci',
    'npm audit --audit-level=high',
    'npm run check',
    'npx playwright install --with-deps chromium',
    'npm run test:storybook',
    'npm run test:e2e',
  ]) assert.equal(pipeline.includes(`- ${command}`), true, `missing pipeline command: ${command}`);
  assert.match(pipeline, /^\s{2}pull-requests:$/m);
  assert.match(pipeline, /^\s{2}branches:\n\s{4}main:$/m);
  assert.doesNotMatch(pipeline, /(?:deploy|git\s+push|curl|wget|scp|rsync|ssh|pipe:)/i);
});

test('uses an npm-packable transport name for the generated Git ignore file', async () => {
  const { createDemo } = await loadDemoModule();
  assert.equal((await lstat(join(TEMPLATE_ROOT, 'gitignore'))).isFile(), true);
  await assert.rejects(() => lstat(join(TEMPLATE_ROOT, '.gitignore')));
  const target = await emptyTarget();
  await createDemo({ target, name: PROJECT_NAME });
  assert.equal((await lstat(join(target, '.gitignore'))).isFile(), true);
  await assert.rejects(() => lstat(join(target, 'gitignore')));
});

test('requires an existing empty regular target and rejects hostile project identifiers', async t => {
  const { createDemo, DemoInputError } = await loadDemoModule();
  const cases = [
    '',
    '../escape',
    'Uppercase-Name',
    'conference planner',
    'conference\nplanner',
    'con',
    `a${'b'.repeat(64)}`,
    '__proto__',
  ];
  for (const name of cases) {
    await t.test(`name ${JSON.stringify(name)}`, async () => {
      const target = await emptyTarget();
      await assert.rejects(() => createDemo({ target, name }), DemoInputError);
      assert.deepEqual(await readdir(target), []);
    });
  }

  await t.test('non-empty target', async () => {
    const target = await emptyTarget();
    await writeFile(join(target, 'keep.txt'), 'keep');
    await assert.rejects(() => createDemo({ target, name: PROJECT_NAME }), /empty/i);
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'keep');
  });
  await t.test('symlink target', async () => {
    const target = await emptyTarget();
    const aliasRoot = await mkdtemp(join(tmpdir(), 'agilno-demo-alias-'));
    const alias = join(aliasRoot, 'target');
    await symlink(target, alias, 'dir');
    await assert.rejects(() => createDemo({ target: alias, name: PROJECT_NAME }), /regular directory|symbolic link/i);
    assert.deepEqual(await readdir(target), []);
  });
  await t.test('missing target', async () => {
    const parent = await emptyTarget();
    await assert.rejects(() => createDemo({ target: join(parent, 'missing'), name: PROJECT_NAME }), /existing empty/i);
  });
  await t.test('stable symlink ancestor is canonicalized before publication', async () => {
    const parent = await emptyTarget();
    const target = join(parent, 'target');
    await mkdir(target);
    const aliasRoot = await emptyTarget('agilno-demo-parent-alias-');
    const alias = join(aliasRoot, 'parent');
    await symlink(parent, alias, 'dir');
    const result = await createDemo({ target: join(alias, 'target'), name: PROJECT_NAME });
    assert.equal(result.target, await realpath(target));
    assert.equal((await readdir(target)).includes('package.json'), true);
  });
});

test('rejects symbolic links, hard links, Git metadata, and special entries in the template before mutation', async t => {
  const { createDemo } = await loadDemoModule();
  await t.test('symbolic link', async () => {
    const { packageRoot, templateRoot } = await cloneTemplate();
    await symlink('/private/irrelevant', join(templateRoot, 'unsafe-link'));
    const target = await emptyTarget();
    await assert.rejects(() => createDemo({ target, name: PROJECT_NAME }, { packageRoot }), /template.*unsupported|symbolic link/i);
    assert.deepEqual(await readdir(target), []);
  });
  await t.test('hard link', async () => {
    const { packageRoot, templateRoot } = await cloneTemplate();
    await link(join(templateRoot, 'README.md'), join(templateRoot, 'README-copy.md'));
    const target = await emptyTarget();
    await assert.rejects(() => createDemo({ target, name: PROJECT_NAME }, { packageRoot }), /template.*unsupported|hard link/i);
    assert.deepEqual(await readdir(target), []);
  });
  await t.test('special entry', async () => {
    const { packageRoot, templateRoot } = await cloneTemplate();
    await nodeFs.promises.mkdir(join(templateRoot, 'empty-directory'));
    const target = await emptyTarget();
    await assert.rejects(() => createDemo({ target, name: PROJECT_NAME }, { packageRoot }), /empty director|unsupported/i);
    assert.deepEqual(await readdir(target), []);
  });
  await t.test('Git metadata directory', async () => {
    const { packageRoot, templateRoot } = await cloneTemplate();
    await mkdir(join(templateRoot, '.git'));
    await writeFile(join(templateRoot, '.git', 'config'), '[remote "origin"]\nurl = https://example.invalid/repository\n');
    const target = await emptyTarget();
    await assert.rejects(
      () => createDemo({ target, name: PROJECT_NAME }, { packageRoot }),
      /template.*unsupported|Git metadata/i,
    );
    assert.deepEqual(await readdir(target), []);
  });
});

test('initializes Git only when explicitly requested and never invokes remote or cloud commands', async () => {
  const { createDemo } = await loadDemoModule();
  const originalCwd = process.cwd();
  const calls = [];
  const runGit = async (command, args, options) => {
    const stageStatus = typeof options.cwd === 'string' ? await lstat(options.cwd) : null;
    calls.push({ command, args, options, observedCwd: process.cwd(), stageStatus });
    if (typeof options.cwd === 'string') await writeFakeGit(options.cwd);
    return { code: 0, stdout: '', stderr: '' };
  };

  const plainTarget = await emptyTarget();
  await createDemo({ target: plainTarget, name: PROJECT_NAME }, { runGit });
  assert.deepEqual(calls, []);

  const gitTarget = await emptyTarget();
  const result = await createDemo({ target: gitTarget, name: PROJECT_NAME, gitInit: true }, {
    runGit,
    env: {
      PATH: process.env.PATH,
      GIT_DIR: 'inert-git-dir-canary',
      GIT_WORK_TREE: 'inert-git-work-tree-canary',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: 'inert-hooks-canary',
    },
  });
  assert.equal(result.gitInitialized, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'git');
  assert.ok(calls[0].args.includes('init'));
  assert.equal(calls[0].observedCwd, originalCwd);
  assert.notEqual(calls[0].options.cwd, gitTarget);
  assert.equal(calls[0].stageStatus?.isDirectory(), true);
  assert.equal((calls[0].stageStatus?.mode ?? 0) & 0o777, 0o700);
  assert.equal(calls[0].args.includes(gitTarget), false);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.GIT_CONFIG_NOSYSTEM, '1');
  for (const value of Object.values(calls[0].options.env)) {
    assert.doesNotMatch(value, /inert-(?:git|hooks)/);
  }
  assert.doesNotMatch(calls[0].args.join(' '), /remote|github|amplify|deploy|push/i);
  await assert.rejects(() => lstat(calls[0].options.cwd));
  assert.equal((await lstat(join(gitTarget, '.git'))).isDirectory(), true);
});

test('real Git initialization ignores ambient Git control variables and stays target-local', async () => {
  const target = await emptyTarget('agilno-demo-git-target-');
  const outsideGit = await emptyTarget('agilno-demo-ambient-git-');
  const moduleUrl = pathToFileURL(join(REPOSITORY_ROOT, 'src', 'commands', 'demo.js')).href;
  const script = [
    `import { createDemo } from ${JSON.stringify(moduleUrl)};`,
    `await createDemo({ target: ${JSON.stringify(target)}, name: ${JSON.stringify(PROJECT_NAME)}, gitInit: true });`,
  ].join('\n');

  await execFile(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, GIT_DIR: outsideGit },
    maxBuffer: 1024 * 1024,
  });

  assert.deepEqual(await readdir(outsideGit), []);
  const gitPath = join(target, '.git');
  assert.equal((await lstat(gitPath)).isDirectory(), true);
  assert.equal(await realpath(gitPath), gitPath);
  const { stdout } = await execFile('git', ['-C', target, 'remote']);
  assert.equal(stdout, '');
});

test('parallel Git initialization uses explicit cwd without changing process cwd', async () => {
  const { createDemo } = await loadDemoModule();
  const originalCwd = process.cwd();
  const first = await emptyTarget('agilno-demo-parallel-first-');
  const second = await emptyTarget('agilno-demo-parallel-second-');
  const calls = [];
  let releaseFirst;
  const firstMayFinish = new Promise(resolvePromise => { releaseFirst = resolvePromise; });
  const runGit = async (_command, _args, options) => {
    const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
    calls.push({ cwd, observedCwd: process.cwd() });
    await writeFakeGit(cwd);
    if (calls.length === 1) await firstMayFinish;
    else releaseFirst();
    return { code: 0 };
  };

  try {
    const results = await Promise.all([
      createDemo({ target: first, name: 'parallel-first', gitInit: true }, { runGit }),
      createDemo({ target: second, name: 'parallel-second', gitInit: true }, { runGit }),
    ]);
    assert.deepEqual(results.map(result => result.target).sort(), [first, second].sort());
    assert.equal(new Set(calls.map(call => call.cwd)).size, 2);
    assert.ok(calls.every(call => call.cwd !== first && call.cwd !== second));
    assert.ok(calls.every(call => call.observedCwd === originalCwd));
    assert.equal(process.cwd(), originalCwd);
    for (const call of calls) await assert.rejects(() => lstat(call.cwd));
  } finally {
    process.chdir(originalCwd);
  }
});

test('Git failure rollback preserves concurrent content and reports residue', async () => {
  const { createDemo } = await loadDemoModule();
  const target = await emptyTarget('agilno-demo-concurrent-content-');
  const canary = join(target, 'src', 'concurrent-user-canary.txt');
  await assert.rejects(
    () => createDemo({ target, name: PROJECT_NAME, gitInit: true }, {
      runGit: async (_command, _args, options) => {
        await writeFile(join(target, 'src', 'concurrent-user-canary.txt'), 'preserve-me');
        return { code: 1 };
      },
    }),
    error => error?.code === 'REPOSITORY_CONFLICT' && /concurrent|residue|changed/i.test(error.message),
  );
  assert.equal(await readFile(canary, 'utf8'), 'preserve-me');
  await assert.rejects(() => lstat(join(target, 'package.json')));
});

test('Git runs only in private staging and never follows a concurrent target .git link', async () => {
  const { createDemo } = await loadDemoModule();
  const target = await emptyTarget('agilno-demo-git-link-race-target-');
  const outside = await emptyTarget('agilno-demo-git-link-race-outside-');
  let gitCwd;

  await assert.rejects(
    () => createDemo({ target, name: PROJECT_NAME, gitInit: true }, {
      runGit: async (command, args, options) => {
        gitCwd = options.cwd;
        await symlink(outside, join(target, '.git'), 'dir');
        try {
          const result = await execFile(command, args, { cwd: options.cwd, env: options.env });
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          return { code: Number.isInteger(error?.code) ? error.code : 1 };
        }
      },
    }),
    error => error?.code === 'REPOSITORY_CONFLICT' && /concurrent|changed|residue/i.test(error.message),
  );

  assert.notEqual(gitCwd, target);
  assert.deepEqual(await readdir(outside), []);
  assert.equal((await lstat(join(target, '.git'))).isSymbolicLink(), true);
  await assert.rejects(() => lstat(gitCwd));
});

test('private Git staging cleanup preserves a concurrently replaced staging identity', async () => {
  const { createDemo } = await loadDemoModule();
  const target = await emptyTarget('agilno-demo-stage-replacement-target-');
  let gitCwd;
  let movedStage;
  await assert.rejects(
    () => createDemo({ target, name: PROJECT_NAME, gitInit: true }, {
      runGit: async (_command, _args, options) => {
        gitCwd = options.cwd;
        movedStage = `${gitCwd}-moved`;
        await nodeFs.promises.rename(gitCwd, movedStage);
        await mkdir(gitCwd);
        await writeFile(join(gitCwd, 'concurrent-canary.txt'), 'preserve-stage-replacement');
        return { code: 1 };
      },
    }),
    error => error?.code === 'REPOSITORY_CONFLICT',
  );
  assert.notEqual(gitCwd, target);
  assert.equal(await readFile(join(gitCwd, 'concurrent-canary.txt'), 'utf8'), 'preserve-stage-replacement');
  assert.equal((await lstat(movedStage)).isDirectory(), true);
});

test('code-zero Git completion rejects target mutations and preserves only changed or unowned residue', async t => {
  const { createDemo } = await loadDemoModule();

  await t.test('real Git with a changed generated package manifest', async () => {
    const target = await emptyTarget('agilno-demo-real-git-mutation-');
    const creation = createDemo({ target, name: PROJECT_NAME, gitInit: true });
    await writeFile(join(target, 'package.json'), '{"changed":"concurrently"}\n');
    await assert.rejects(
      () => creation,
      error => error?.code === 'REPOSITORY_CONFLICT' && /concurrent|changed|residue/i.test(error.message),
    );
    assert.equal(await readFile(join(target, 'package.json'), 'utf8'), '{"changed":"concurrently"}\n');
    await assert.rejects(() => lstat(join(target, 'package-lock.json')));
    await assert.rejects(() => lstat(join(target, '.git')));
  });

  await t.test('injected Git with an unexpected nested target file', async () => {
    const target = await emptyTarget('agilno-demo-injected-git-mutation-');
    const extra = join(target, 'src', 'concurrent-extra.txt');
    await assert.rejects(
      () => createDemo({ target, name: PROJECT_NAME, gitInit: true }, {
        runGit: async (_command, _args, options) => {
          await writeFakeGit(options.cwd);
          await writeFile(extra, 'preserve-extra');
          return { code: 0 };
        },
      }),
      error => error?.code === 'REPOSITORY_CONFLICT' && /concurrent|changed|residue/i.test(error.message),
    );
    assert.equal(await readFile(extra, 'utf8'), 'preserve-extra');
    await assert.rejects(() => lstat(join(target, 'package.json')));
    await assert.rejects(() => lstat(join(target, '.git')));
  });

  await t.test('injected Git with an unexpected top-level target file', async () => {
    const target = await emptyTarget('agilno-demo-injected-git-top-level-');
    const extra = join(target, 'concurrent-top-level.txt');
    await assert.rejects(
      () => createDemo({ target, name: PROJECT_NAME, gitInit: true }, {
        runGit: async (_command, _args, options) => {
          await writeFakeGit(options.cwd);
          await writeFile(extra, 'preserve-top-level');
          return { code: 0 };
        },
      }),
      error => error?.code === 'REPOSITORY_CONFLICT' && /concurrent|changed|residue/i.test(error.message),
    );
    assert.equal(await readFile(extra, 'utf8'), 'preserve-top-level');
    assert.deepEqual(await readdir(target), ['concurrent-top-level.txt']);
  });
});

test('Git result traps and unsafe metadata are sanitized without touching outside data', async t => {
  const { createDemo } = await loadDemoModule();
  await t.test('hostile result getter', async () => {
    const trapTarget = await emptyTarget('agilno-demo-git-result-trap-');
    const canary = 'inert-hostile-git-result-canary';
    await assert.rejects(
      () => createDemo({ target: trapTarget, name: PROJECT_NAME, gitInit: true }, {
        runGit: async () => new Proxy({}, {
          get(_target, key) {
            if (key === 'code') throw new Error(canary);
            return undefined;
          },
        }),
      }),
      error => error?.code === 'REPOSITORY_CONFLICT' && !String(error.message).includes(canary),
    );
  });

  await t.test('rejected Git call with safe target-local metadata', async () => {
    const rejectedTarget = await emptyTarget('agilno-demo-git-rejection-');
    const canary = 'inert-hostile-git-rejection-canary';
    await assert.rejects(
      () => createDemo({ target: rejectedTarget, name: PROJECT_NAME, gitInit: true }, {
        runGit: async (_command, _args, options) => {
          await writeFakeGit(options.cwd);
          throw new Error(canary);
        },
      }),
      error => error?.code === 'REPOSITORY_CONFLICT' && !String(error.message).includes(canary),
    );
    assert.deepEqual(await readdir(rejectedTarget), []);
  });

  await t.test('unsafe .git link', async () => {
    const linkTarget = await emptyTarget('agilno-demo-git-link-target-');
    const outside = await emptyTarget('agilno-demo-git-link-outside-');
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await assert.rejects(
      () => createDemo({ target: linkTarget, name: PROJECT_NAME, gitInit: true }, {
        runGit: async (_command, _args, options) => {
          await writeFakeGit(options.cwd);
          await symlink(outside, join(linkTarget, '.git'), 'dir');
          return { code: 0 };
        },
      }),
      error => error?.code === 'REPOSITORY_CONFLICT' && !String(error.message).includes(outside),
    );
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
    assert.equal((await lstat(join(linkTarget, '.git'))).isSymbolicLink(), true);
  });

  await t.test('staged Git metadata with a remote', async () => {
    const remoteTarget = await emptyTarget('agilno-demo-git-remote-target-');
    await assert.rejects(
      () => createDemo({ target: remoteTarget, name: PROJECT_NAME, gitInit: true }, {
        runGit: async (_command, _args, options) => {
          await mkdir(join(options.cwd, '.git'));
          await writeFile(join(options.cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
          await writeFile(
            join(options.cwd, '.git', 'config'),
            '[core]\nrepositoryformatversion = 0\n[remote "origin"]\nurl = https://example.invalid/repository\n',
          );
          return { code: 0 };
        },
      }),
      error => error?.code === 'REPOSITORY_CONFLICT',
    );
    assert.deepEqual(await readdir(remoteTarget), []);
  });
});

test('snapshots hostile generator options once and sanitizes rejected input', async () => {
  const { createDemo, DemoInputError } = await loadDemoModule();
  const target = await emptyTarget();
  const reads = { target: 0, name: 0, gitInit: 0 };
  const options = {};
  for (const [key, value] of Object.entries({ target, name: PROJECT_NAME, gitInit: false })) {
    Object.defineProperty(options, key, {
      enumerable: true,
      get() { reads[key] += 1; return value; },
    });
  }
  await createDemo(options);
  assert.deepEqual(reads, { target: 1, name: 1, gitInit: 1 });

  const canary = 'inert-private-input-canary';
  await assert.rejects(
    () => createDemo(Object.defineProperty({}, 'name', {
      enumerable: true,
      get() { throw new Error(canary); },
    })),
    error => error instanceof DemoInputError && !String(error.message).includes(canary),
  );
  const extraTarget = await emptyTarget();
  await assert.rejects(() => createDemo({ target: extraTarget, name: PROJECT_NAME, unexpected: true }), DemoInputError);
});

test('strict CLI parsing and routing expose only demo create with bounded options', async () => {
  assert.deepEqual(
    parseArgs(['demo', 'create', './planner', '--name=team-conference', '--git-init']),
    {
      command: 'demo',
      subcommand: 'create',
      operands: ['./planner'],
      flags: { name: 'team-conference', 'git-init': true },
    },
  );
  for (const argv of [
    ['demo', 'create'],
    ['demo', 'create', 'one', 'two'],
    ['demo', 'destroy', 'planner', '--name=team-conference'],
    ['demo', 'create', 'planner', '--name'],
    ['demo', 'create', 'planner', '--git-init=yes', '--name=team-conference'],
    ['demo', 'create', 'planner', '--publish', '--name=team-conference'],
  ]) assert.throws(() => parseArgs(argv));

  const capture = captureOutput();
  const calls = [];
  const exitCode = await main(
    ['demo', 'create', './planner', '--name=team-conference'],
    {
      output: capture.output,
      commands: {
        demo: async parsed => {
          calls.push(parsed);
          return EXIT_CODES.SUCCESS;
        },
      },
    },
  );
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subcommand, 'create');
});

test('demo CLI emits sanitized local next steps and no target path or implicit side effects', async () => {
  const { demoCommand } = await loadDemoModule();
  const target = await emptyTarget('private-target-marker-');
  const capture = captureOutput();
  const network = [];
  const result = await demoCommand({
    command: 'demo',
    subcommand: 'create',
    operands: [target],
    flags: { name: PROJECT_NAME },
  }, {
    fs: nodeFs,
    cwd: () => process.cwd(),
    packageRoot: REPOSITORY_ROOT,
    output: capture.output,
    fetch: (...args) => { network.push(args); throw new Error('network forbidden'); },
    runGit: async () => { throw new Error('git must remain opt-in'); },
  });
  assert.equal(result, EXIT_CODES.SUCCESS);
  assert.equal(network.length, 0);
  assert.match(capture.stdout.join(''), /npm ci/);
  assert.match(capture.stdout.join(''), /npm run check/);
  assert.doesNotMatch(capture.stdout.join(''), new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(capture.stderr, []);
});
