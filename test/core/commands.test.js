import assert from 'node:assert/strict';
import { renameSync, symlinkSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';
import { CommandPolicyError, prepareCommand, runCommand } from '../../src/policy/commands.js';

async function executableFixture(root, name, source) {
  const path = join(root, name);
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function authority(commands = ['test']) {
  return createAuthorityEnvelope({
    actorId: 'worker-one', principal: 'agent', actions: commands.map(id => `command.${id}`),
    ownedPaths: [], providers: [], commands,
  });
}

function approvalRegistry() {
  return createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agilno-command-')));
  const worktree = join(root, 'worktree');
  await mkdir(join(worktree, 'nested'), { recursive: true });
  const print = await executableFixture(root, 'print', '#!/bin/sh\nprintf "%s" "$1"\n');
  const sleep = await executableFixture(root, 'wait', '#!/bin/sh\nsleep 2\n');
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  return { root, worktree, print, sleep };
}

function contract(worktree, executable, overrides = {}) {
  return {
    worktree,
    authority: authority(),
    commands: {
      test: { executable, args: ['safe-output'], action: 'command.test' },
    },
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    maxStreamOutputBytes: 1_024,
    ...overrides,
  };
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await lstat(path); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for command fixture marker');
}

test('prepares an allowlisted executable and argv without a shell', async t => {
  const { worktree, print } = await fixture(t);
  const prepared = await prepareCommand(contract(worktree, print), {
    actorId: 'worker-one', commandId: 'test', cwd: 'nested', args: [],
  });
  assert.equal(prepared.executable, print);
  assert.deepEqual(prepared.args, ['safe-output']);
  assert.equal(prepared.shell, false);
  assert.equal(prepared.cwd, join(worktree, 'nested'));
  assert.ok(Object.isFrozen(prepared));
});

test('rejects shell strings, metacharacters, unsafe interpreters, and non-allowlisted commands', async t => {
  const { worktree, print } = await fixture(t);
  const base = contract(worktree, print);
  await assert.rejects(() => prepareCommand(base, { actorId: 'worker-one', commandId: 'missing', cwd: '.' }), /not allowlisted/);
  await assert.rejects(() => prepareCommand({ ...base, commands: { test: `${print} safe` } }, { actorId: 'worker-one', commandId: 'test', cwd: '.' }), CommandPolicyError);
  await assert.rejects(() => prepareCommand({ ...base, commands: { test: { executable: print, args: ['safe;touch-marker'], action: 'command.test' } } }, { actorId: 'worker-one', commandId: 'test', cwd: '.' }), /metacharacter/);
  await assert.rejects(() => prepareCommand({ ...base, commands: { test: { executable: '/bin/sh', args: ['-c', 'true'], action: 'command.test' } } }, { actorId: 'worker-one', commandId: 'test', cwd: '.' }), /unsafe executable/);
});

test('rejects cwd escape, cwd symlinks, and executable symlinks', async t => {
  const { root, worktree, print } = await fixture(t);
  await symlink(root, join(worktree, 'linked'));
  await assert.rejects(() => prepareCommand(contract(worktree, print), {
    actorId: 'worker-one', commandId: 'test', cwd: '..',
  }), /assigned worktree/);
  await assert.rejects(() => prepareCommand(contract(worktree, print), {
    actorId: 'worker-one', commandId: 'test', cwd: 'linked',
  }), /symlink/);
  const linkedExecutable = join(root, 'linked-print');
  await symlink(print, linkedExecutable);
  await assert.rejects(() => prepareCommand(contract(worktree, linkedExecutable), {
    actorId: 'worker-one', commandId: 'test', cwd: '.',
  }), /unsafe executable/);
  for (const cwd of [
    'nested\\child', 'C:\\private', 'nested/CON', 'nested/conout$.txt', 'nested/COM¹.log',
    'nested/name.', 'nested/name ', 'nested/file：stream', 'nested＼child', 'nested／..／private',
  ]) {
    await assert.rejects(() => prepareCommand(contract(worktree, print), {
      actorId: 'worker-one', commandId: 'test', cwd,
    }), CommandPolicyError, cwd);
  }
});

test('runs with finite output limits and suppresses sensitive results before returning', async t => {
  const { worktree, print } = await fixture(t);
  const marker = 'inert-sensitive-marker-123';
  const result = await runCommand(contract(worktree, print, {
    timeoutMs: 5_000,
    environment: { DEMO_API_TOKEN: marker },
    commands: { test: { executable: print, args: [], action: 'command.test', allowExtraArgs: true } },
  }), {
    actorId: 'worker-one', commandId: 'test', cwd: '.', args: [marker],
  });
  assert.equal(result.status, 'success');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.redacted, true);
  assert.deepEqual(result.truncated, { stdout: false, stderr: false, combined: false });
});

test('execution environment is the mandatory redaction source and secrets are redacted before output limits', async t => {
  const { worktree, print } = await fixture(t);
  const marker = 'inert-sensitive-marker-123456789';
  const configured = contract(worktree, print, {
    environment: { DEMO_API_TOKEN: marker },
    maxOutputBytes: 12,
    maxStreamOutputBytes: 12,
    commands: { test: { executable: print, args: [marker], action: 'command.test' } },
  });
  await assert.rejects(() => runCommand(configured, {
    actorId: 'worker-one', commandId: 'test', cwd: '.',
  }, { environment: { DEMO_API_TOKEN: 'different-marker' } }), CommandPolicyError);
  const result = await runCommand(configured, { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.redacted, true);

  const token = 'xx github_pat_12345678YY';
  const tokenResult = await runCommand(contract(worktree, print, {
    maxOutputBytes: 12,
    maxStreamOutputBytes: 12,
    commands: { test: { executable: print, args: [token], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(tokenResult.stdout, '');
  assert.equal(tokenResult.stderr, '');
  assert.equal(tokenResult.redacted, true);
});

test('redacts configured multibyte secrets that cross write chunks and output boundaries', async t => {
  const { root, worktree } = await fixture(t);
  const marker = 'inert-🙂-secret-value-123456';
  const split = await executableFixture(root, 'split-secret', `#!/bin/sh\nprintf "inert-🙂-sec"\nsleep 0.02\nprintf "ret-value-123456"\n`);
  const result = await runCommand(contract(worktree, split, {
    environment: { DEMO_API_TOKEN: marker },
    maxOutputBytes: 16,
    maxStreamOutputBytes: 16,
    commands: { test: { executable: split, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.redacted, true);
});

test('combined stream limits cannot expose a second partial configured secret after the first is redacted', async t => {
  const { root, worktree } = await fixture(t);
  const marker = `inert-${'x'.repeat(5_000)}`;
  const both = await executableFixture(root, 'both-streams', '#!/bin/sh\nprintf "%s" "$DEMO_API_TOKEN"\nprintf "%s" "$DEMO_API_TOKEN" >&2\n');
  const result = await runCommand(contract(worktree, both, {
    environment: { DEMO_API_TOKEN: marker },
    maxOutputBytes: 12,
    maxStreamOutputBytes: 12,
    commands: { test: { executable: both, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.redacted, true);
});

test('raw capture overflow returns no repeated-secret bytes from either stream', async t => {
  const { root, worktree } = await fixture(t);
  const repeated = await executableFixture(root, 'repeated-overflow-secrets', [
    '#!/bin/sh',
    'index=0',
    'while [ "$index" -lt "$REPETITIONS" ]; do printf "a%sb" "$DEMO_API_TOKEN"; index=$((index + 1)); done',
    'index=0',
    'while [ "$index" -lt "$REPETITIONS" ]; do printf "1%s2" "$DEMO_API_TOKEN" >&2; index=$((index + 1)); done',
    '',
  ].join('\n'));
  for (const [marker, maxOutputBytes, repetitions] of [
    [`clé🙂-${'x'.repeat(120)}`, 400, '40'],
    [`very-long-clé🙂-${'y'.repeat(5_000)}`, 10_064, '3'],
  ]) {
    const result = await runCommand(contract(worktree, repeated, {
      environment: { DEMO_API_TOKEN: marker, REPETITIONS: repetitions },
      maxOutputBytes,
      maxStreamOutputBytes: maxOutputBytes,
      commands: { test: { executable: repeated, args: [], action: 'command.test' } },
    }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
    assert.equal(result.status, 'output-overflow');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.redacted, false);
    assert.equal(result.suppressed, true);
    assert.deepEqual(result.truncated, { stdout: true, stderr: true, combined: true });
  }
});

test('bounded repeated secrets suppress the whole result', async t => {
  const { root, worktree } = await fixture(t);
  const repeated = await executableFixture(root, 'bounded-repeated-secrets', [
    '#!/bin/sh',
    'printf "a%sb%s" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN"',
    'printf "1%s2%s" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" >&2',
    '',
  ].join('\n'));
  const marker = `clé🙂-${'x'.repeat(120)}`;
  const result = await runCommand(contract(worktree, repeated, {
    environment: { DEMO_API_TOKEN: marker },
    maxOutputBytes: 400,
    maxStreamOutputBytes: 200,
    commands: { test: { executable: repeated, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.redacted, true);
});

test('trailing known-secret prefixes suppress results at every code-point boundary on either stream', async t => {
  const { root, worktree } = await fixture(t);
  const boundary = await executableFixture(root, 'secret-prefix-boundary', [
    '#!/bin/sh',
    'if [ "$TARGET_STREAM" = "stdout" ]; then',
    '  printf "%s|%s|%s|%s" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$OUTPUT_PART"',
    'else',
    '  printf "%s|%s|%s|%s" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$OUTPUT_PART" >&2',
    'fi',
    '',
  ].join('\n'));

  for (const marker of ['xy', 'clé🙂fin']) {
    const boundaries = [];
    let offset = 0;
    for (const character of marker) {
      offset += character.length;
      if (offset < marker.length) boundaries.push(offset);
    }
    for (const splitAt of boundaries) {
      const prefix = marker.slice(0, splitAt);
      for (const target of ['stdout', 'stderr']) {
        const result = await runCommand(contract(worktree, boundary, {
          environment: { DEMO_API_TOKEN: marker, OUTPUT_PART: prefix, TARGET_STREAM: target },
          commands: { test: { executable: boundary, args: [], action: 'command.test' } },
        }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
        assert.equal(result.status, 'success');
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
        assert.equal(result.redacted, true);
      }
    }
  }
});

test('delimited secret prefixes before newline and control framing suppress the whole result', async t => {
  const { root, worktree } = await fixture(t);
  const framed = await executableFixture(root, 'framed-secret-prefix', [
    '#!/bin/sh',
    'emit_result() {',
    '  printf "%s|%s|%s" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$OUTPUT_PART"',
    '  if [ "$FRAME_KIND" = "nul" ]; then printf "\\000"; else printf "%s" "$FRAME_VALUE"; fi',
    '}',
    'if [ "$TARGET_STREAM" = "stdout" ]; then emit_result; else emit_result >&2; fi',
    '',
  ].join('\n'));
  const values = [
    ['xy', 'x'],
    ['clé🙂fin', 'clé🙂'],
    [`long-${'z'.repeat(5_000)}-🙂`, `long-${'z'.repeat(64)}`],
  ];
  const framings = [
    { kind: 'value', value: '\n' },
    { kind: 'value', value: '\r\n' },
    { kind: 'value', value: '\t' },
    { kind: 'value', value: '\u0001' },
    { kind: 'value', value: '\u001f' },
    { kind: 'nul', value: '' },
  ];
  for (const [marker, prefix] of values) {
    for (const framing of framings) {
      for (const target of ['stdout', 'stderr']) {
        const result = await runCommand(contract(worktree, framed, {
          environment: {
            DEMO_API_TOKEN: marker,
            OUTPUT_PART: prefix,
            FRAME_KIND: framing.kind,
            FRAME_VALUE: framing.value,
            TARGET_STREAM: target,
          },
          commands: { test: { executable: framed, args: [], action: 'command.test' } },
        }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
        assert.equal(result.redacted, true);
      }
    }
  }

  const prefixOnly = await executableFixture(root, 'framed-prefix-only', '#!/bin/sh\nprintf "|%s\\n" "$OUTPUT_PART"\n');
  const prefixOnlyResult = await runCommand(contract(worktree, prefixOnly, {
    environment: { DEMO_API_TOKEN: 'xy', OUTPUT_PART: 'x' },
    commands: { test: { executable: prefixOnly, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(prefixOnlyResult.stdout, '');
  assert.equal(prefixOnlyResult.stderr, '');
  assert.equal(prefixOnlyResult.redacted, true);
});

test('assignment framing and punctuation-leading secret prefixes suppress either stream', async t => {
  const { root, worktree } = await fixture(t);
  const assigned = await executableFixture(root, 'assigned-secret-prefix', [
    '#!/bin/sh',
    'emit_result() { printf "%s%s\\n" "$LABEL" "$OUTPUT_PART"; }',
    'if [ "$TARGET_STREAM" = "stdout" ]; then emit_result; else emit_result >&2; fi',
    '',
  ].join('\n'));
  for (const scenario of [
    { marker: 'xy', prefix: 'x', label: 'TOKEN=' },
    { marker: 'clé🙂fin', prefix: 'clé🙂', label: 'AUTH:' },
    { marker: '|abcdef', prefix: '|abc', label: '' },
    { marker: '|abcdef', prefix: '|abc', label: 'TOKEN=' },
  ]) {
    for (const target of ['stdout', 'stderr']) {
      const result = await runCommand(contract(worktree, assigned, {
        environment: {
          DEMO_API_TOKEN: scenario.marker,
          OUTPUT_PART: scenario.prefix,
          LABEL: scenario.label,
          TARGET_STREAM: target,
        },
        commands: { test: { executable: assigned, args: [], action: 'command.test' } },
      }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(result.redacted, true);
      assert.equal(result.suppressed, true);
    }
  }
});

test('trailing punctuation framing cannot expose configured secret prefixes', async t => {
  const { root, worktree } = await fixture(t);
  const c1Controls = Array.from({ length: 32 }, (_, index) => String.fromCodePoint(0x80 + index));
  const framed = await executableFixture(root, 'punctuation-framed-secret-prefix', [
    '#!/bin/sh',
    'emit_result() { printf "%s%s%s" "$LABEL" "$OUTPUT_PART" "$TRAILING_FRAME"; }',
    'if [ "$TARGET_STREAM" = "stdout" ]; then emit_result; else emit_result >&2; fi',
    '',
  ].join('\n'));
  for (const scenario of [
    { marker: 'abcdef', label: 'TOKEN=', prefix: 'abc', frame: ',' },
    { marker: 'abcdef', label: 'TOKEN="', prefix: 'abc', frame: '"' },
    { marker: 'abcdef', label: '{"token":"', prefix: 'abc', frame: '"}' },
    { marker: 'abcdef', label: 'AUTH=(', prefix: 'abc', frame: ')' },
    { marker: 'clé🙂fin', label: 'TOKEN=', prefix: 'clé🙂', frame: '。' },
    { marker: 'abc,def', label: 'TOKEN=', prefix: 'abc,', frame: '' },
    { marker: 'ab:cdef', label: 'AUTH=(', prefix: 'ab:c', frame: ')' },
    { marker: '|abcdef', label: 'TOKEN=', prefix: '|abc', frame: ')' },
    { marker: '※abcdef', label: 'TOKEN=', prefix: '※abc', frame: '」' },
    { marker: 'abcdef', label: 'TOKEN=', prefix: 'abc', frame: ','.repeat(257) },
    { marker: 'abcdef', label: '「', prefix: 'abc', frame: '」' },
    { marker: 'abcdef', label: 'TOKEN→', prefix: 'abc', frame: '。' },
    { marker: 'abcdef', label: 'TOKEN—', prefix: 'abc', frame: '…' },
    { marker: 'abcdef', label: 'TOKEN≔', prefix: 'abc', frame: '⊣' },
    { marker: 'abcdef', label: 'TOKEN€', prefix: 'abc', frame: '™' },
    { marker: 'abcdef', label: '\u200b', prefix: 'abc', frame: '' },
    { marker: 'abcdef', label: 'TOKEN=', prefix: 'abc', frame: '\u200b' },
    { marker: 'abcdef', label: '\u2066', prefix: 'abc', frame: '\u2069' },
    { marker: 'abcdef', label: 'TOKEN=\u2066', prefix: 'abc', frame: '' },
    { marker: 'abcdef', label: 'TOKEN=', prefix: 'abc', frame: '\u2069' },
    ...c1Controls.map(control => ({ marker: 'abcdef', label: control, prefix: 'abc', frame: control })),
    ...[c1Controls[0], c1Controls[5], c1Controls[31]].flatMap(control => [
      { marker: 'abcdef', label: control, prefix: 'abc', frame: '' },
      { marker: 'abcdef', label: 'TOKEN=', prefix: 'abc', frame: control },
    ]),
    { marker: 'abcdef', label: 'TOKEN=', prefix: 'abc', frame: c1Controls[0].repeat(256) },
    { marker: 'abcdef', label: 'TOKEN=', prefix: 'abc', frame: c1Controls[0].repeat(257) },
  ]) {
    for (const target of ['stdout', 'stderr']) {
      const result = await runCommand(contract(worktree, framed, {
        environment: {
          DEMO_API_TOKEN: scenario.marker,
          LABEL: scenario.label,
          OUTPUT_PART: scenario.prefix,
          TRAILING_FRAME: scenario.frame,
          TARGET_STREAM: target,
        },
        commands: { test: { executable: framed, args: [], action: 'command.test' } },
      }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
      assert.equal(result.stdout, '', `${target} exposed ${scenario.label}${scenario.prefix}${scenario.frame}`);
      assert.equal(result.stderr, '', `${target} exposed ${scenario.label}${scenario.prefix}${scenario.frame}`);
      assert.equal(result.redacted, true);
      assert.equal(result.suppressed, true);
    }
  }
});

test('sensitive suppression derives overflow metadata only from captured raw bytes', async t => {
  const { worktree, print } = await fixture(t);
  const exact = await runCommand(contract(worktree, print, {
    environment: { DEMO_API_TOKEN: 'x' },
    maxOutputBytes: 1,
    maxStreamOutputBytes: 1,
    commands: { test: { executable: print, args: ['x'], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(exact.status, 'success');
  assert.deepEqual(exact.truncated, { stdout: false, stderr: false, combined: false });
  assert.equal(exact.stdout, '');
  assert.equal(exact.stderr, '');
  assert.equal(exact.redacted, true);
  assert.equal(exact.suppressed, true);

  const exceeded = await runCommand(contract(worktree, print, {
    environment: { DEMO_API_TOKEN: 'xy' },
    maxOutputBytes: 1,
    maxStreamOutputBytes: 1,
    commands: { test: { executable: print, args: ['xy'], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(exceeded.status, 'output-overflow');
  assert.deepEqual(exceeded.truncated, { stdout: true, stderr: false, combined: true });
  assert.equal(exceeded.stdout, '');
  assert.equal(exceeded.stderr, '');
  assert.equal(exceeded.redacted, true);
  assert.equal(exceeded.suppressed, true);
});

test('framed long prefixes are suppressed below and exactly at the raw ceiling', async t => {
  const { root, worktree } = await fixture(t);
  const framed = await executableFixture(root, 'limited-framed-secret-prefix', [
    '#!/bin/sh',
    'emit_result() { printf "%s|%s|%s\\n" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$OUTPUT_PART"; }',
    'if [ "$TARGET_STREAM" = "stdout" ]; then emit_result; else emit_result >&2; fi',
    '',
  ].join('\n'));
  const marker = `prefix-${'q'.repeat(5_000)}-🙂`;
  const prefix = marker.slice(0, 64);
  const exactMaximum = Buffer.byteLength(prefix) + 3;
  for (const maximum of [exactMaximum + 1, exactMaximum]) {
    for (const target of ['stdout', 'stderr']) {
      const result = await runCommand(contract(worktree, framed, {
        environment: { DEMO_API_TOKEN: marker, OUTPUT_PART: prefix, TARGET_STREAM: target },
        maxOutputBytes: maximum,
        maxStreamOutputBytes: maximum,
        commands: { test: { executable: framed, args: [], action: 'command.test' } },
      }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
      assert.equal(result.status, 'output-overflow');
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(result.redacted, true);
    }
  }
});

test('known-secret boundary handling is safe below, at, and above raw capture limits', async t => {
  const { root, worktree } = await fixture(t);
  const boundary = await executableFixture(root, 'limited-secret-prefix-boundary', [
    '#!/bin/sh',
    'index=0',
    'if [ "$TARGET_STREAM" = "stdout" ]; then',
    '  while [ "$index" -lt "$REPETITIONS" ]; do printf "%s" "$DEMO_API_TOKEN"; index=$((index + 1)); done',
    '  printf "%s" "$OUTPUT_PART"',
    'else',
    '  while [ "$index" -lt "$REPETITIONS" ]; do printf "%s" "$DEMO_API_TOKEN" >&2; index=$((index + 1)); done',
    '  printf "%s" "$OUTPUT_PART" >&2',
    'fi',
    '',
  ].join('\n'));
  const marker = `prefix-${'y'.repeat(5_000)}-🙂`;
  const markerBytes = Buffer.byteLength(marker);
  for (const target of ['stdout', 'stderr']) {
    for (const scenario of [
      { name: 'below-overflow', repetitions: '2', prefix: marker.slice(0, 7), maximum: 8, status: 'output-overflow', empty: true },
      { name: 'at-overflow', repetitions: '2', prefix: marker.slice(0, 8), maximum: 8, status: 'output-overflow', empty: true },
      { name: 'at-overflow-after-full-secrets', repetitions: '3', prefix: marker.slice(0, 64), maximum: markerBytes + 64, status: 'output-overflow', empty: true },
      { name: 'above', repetitions: '2', prefix: marker.slice(0, 9), maximum: 8, status: 'output-overflow', empty: true },
    ]) {
      const result = await runCommand(contract(worktree, boundary, {
        environment: {
          DEMO_API_TOKEN: marker,
          REPETITIONS: scenario.repetitions,
          OUTPUT_PART: scenario.prefix,
          TARGET_STREAM: target,
        },
        maxOutputBytes: scenario.maximum,
        maxStreamOutputBytes: scenario.maximum,
        commands: { test: { executable: boundary, args: [], action: 'command.test' } },
      }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
      assert.equal(result.status, scenario.status, `${target} ${scenario.name}`);
      assert.equal(result.stdout === '' && result.stderr === '', scenario.empty, `${target} ${scenario.name}`);
      assert.equal(`${result.stdout}${result.stderr}`.includes(scenario.prefix), false, `${target} ${scenario.name}`);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /�/);
      if (scenario.name !== 'above') assert.equal(result.redacted, true);
    }
  }
});

test('safe text and unrelated trailing prefix characters are not over-redacted', async t => {
  const { root, worktree } = await fixture(t);
  const safe = await executableFixture(root, 'safe-secret-adjacency', '#!/bin/sh\nprintf "%s%s%s%s" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$DEMO_API_TOKEN" "$SAFE_TEXT"\n');
  const ordinaryOutput = await executableFixture(root, 'ordinary-prefix-output', [
    '#!/bin/sh',
    'if [ "$TARGET_STREAM" = "stderr" ]; then printf "%s" "$SAFE_TEXT" >&2; else printf "%s" "$SAFE_TEXT"; fi',
    '',
  ].join('\n'));
  const marker = 'common-secret';
  const afterSecret = await runCommand(contract(worktree, safe, {
    environment: { DEMO_API_TOKEN: marker, SAFE_TEXT: 'ordinary-safe-text' },
    commands: { test: { executable: safe, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(afterSecret.stdout, '');
  assert.equal(afterSecret.stderr, '');
  assert.equal(afterSecret.redacted, true);

  for (const safeText of [
    'ordinaryc', 'ordinaryc。', 'motéc」', '{"value":"ordinaryc"}',
    'ordinaryc\u200b', '\u200bordinaryc\u2069', 'ordinary\u200bxc\u2069',
    'ordinaryc\u0080', '\u0080ordinaryc\u009f', 'ordinary\u0080xc\u009f',
  ]) {
    for (const target of ['stdout', 'stderr']) {
      const ordinary = await runCommand(contract(worktree, ordinaryOutput, {
        environment: { DEMO_API_TOKEN: marker, SAFE_TEXT: safeText, TARGET_STREAM: target },
        commands: { test: { executable: ordinaryOutput, args: [], action: 'command.test' } },
      }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
      assert.equal(ordinary.stdout, target === 'stdout' ? safeText : '');
      assert.equal(ordinary.stderr, target === 'stderr' ? safeText : '');
      assert.equal(ordinary.redacted, false);
      assert.equal(ordinary.suppressed, false);
    }
  }

  for (const ambiguousText of [
    'ordinary-c', 'ordinary-c,', 'ordinary—c…', 'ordinary\u200bc', 'ordinary\u2066c\u2069',
    'ordinary\u0080c', 'ordinary\u0080c\u009f',
  ]) {
    for (const target of ['stdout', 'stderr']) {
      const ambiguous = await runCommand(contract(worktree, ordinaryOutput, {
        environment: { DEMO_API_TOKEN: marker, SAFE_TEXT: ambiguousText, TARGET_STREAM: target },
        commands: { test: { executable: ordinaryOutput, args: [], action: 'command.test' } },
      }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
      assert.equal(ambiguous.stdout, '');
      assert.equal(ambiguous.stderr, '');
      assert.equal(ambiguous.redacted, true);
      assert.equal(ambiguous.suppressed, true);
    }
  }
});

test('configured secrets split across stdout and stderr suppress every split point and order', async t => {
  const { root, worktree } = await fixture(t);
  const splitOutput = await executableFixture(root, 'split-stream-secret', [
    '#!/bin/sh',
    'printf "%s" "$FIRST_A"',
    'printf "%s" "$FIRST_B"',
    'printf "%s" "$SECOND_A" >&2',
    'printf "%s" "$SECOND_B" >&2',
    '',
  ].join('\n'));

  async function assertEverySplit(marker) {
    const boundaries = [];
    let offset = 0;
    for (const character of marker) {
      offset += character.length;
      if (offset < marker.length) boundaries.push(offset);
    }
    for (const splitAt of boundaries) {
      const prefix = marker.slice(0, splitAt);
      const suffix = marker.slice(splitAt);
      for (const [stdoutPiece, stderrPiece] of [[prefix, suffix], [suffix, prefix]]) {
        const stdoutCharacters = [...stdoutPiece];
        const stderrCharacters = [...stderrPiece];
        const stdoutChunk = Math.max(1, Math.floor(stdoutCharacters.length / 2));
        const stderrChunk = Math.max(1, Math.floor(stderrCharacters.length / 2));
        const result = await runCommand(contract(worktree, splitOutput, {
          environment: {
            DEMO_API_TOKEN: marker,
            FIRST_A: stdoutCharacters.slice(0, stdoutChunk).join(''),
            FIRST_B: stdoutCharacters.slice(stdoutChunk).join(''),
            SECOND_A: stderrCharacters.slice(0, stderrChunk).join(''),
            SECOND_B: stderrCharacters.slice(stderrChunk).join(''),
          },
          commands: { test: { executable: splitOutput, args: [], action: 'command.test' } },
        }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
        assert.equal(result.stdout, '', `stdout exposed split ${splitAt} of ${marker}`);
        assert.equal(result.stderr, '', `stderr exposed split ${splitAt} of ${marker}`);
        assert.equal(result.redacted, true);
      }
    }
  }

  await assertEverySplit('vwxyz');
  await assertEverySplit('xy');
  await assertEverySplit('clé🙂fin');

  const c1Split = await runCommand(contract(worktree, splitOutput, {
    environment: {
      DEMO_API_TOKEN: 'abcdef',
      FIRST_A: '\u0080abc',
      FIRST_B: '\u009f',
      SECOND_A: '\u0080def',
      SECOND_B: '\u009f',
    },
    commands: { test: { executable: splitOutput, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(c1Split.stdout, '');
  assert.equal(c1Split.stderr, '');
  assert.equal(c1Split.redacted, true);
  assert.equal(c1Split.suppressed, true);
});

test('cross-stream redaction survives asynchronous chunks, multibyte text, and output truncation', async t => {
  const { root, worktree } = await fixture(t);
  const chunked = await executableFixture(root, 'chunked-stream-secret', [
    '#!/bin/sh',
    'printf "%s" "$FIRST_A"',
    '/bin/sleep 0.02',
    'printf "%s" "$FIRST_B"',
    'printf "%s" "$SECOND_A" >&2',
    '/bin/sleep 0.02',
    'printf "%s" "$SECOND_B" >&2',
    'printf "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"',
    'printf "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr" >&2',
    '',
  ].join('\n'));
  const marker = 'clé🙂fin';
  const prefix = 'clé🙂';
  const suffix = 'fin';
  const result = await runCommand(contract(worktree, chunked, {
    environment: {
      DEMO_API_TOKEN: marker,
      FIRST_A: prefix.slice(0, 2),
      FIRST_B: prefix.slice(2),
      SECOND_A: suffix.slice(0, 1),
      SECOND_B: suffix.slice(1),
    },
    maxOutputBytes: 24,
    maxStreamOutputBytes: 12,
    commands: { test: { executable: chunked, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(result.status, 'output-overflow');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.redacted, true);
});

test('classifies timeout and output overflow stably and completes cleanup', async t => {
  const { worktree, print, sleep } = await fixture(t);
  const timed = await runCommand(contract(worktree, sleep, {
    timeoutMs: 25,
    commands: { test: { executable: sleep, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(timed.status, 'timeout');
  assert.equal(timed.timedOut, true);

  const overflow = await runCommand(contract(worktree, print, {
    maxOutputBytes: 4,
    maxStreamOutputBytes: 4,
    commands: { test: { executable: print, args: ['abcdefgh'], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' });
  assert.equal(overflow.status, 'output-overflow');
  assert.equal(Buffer.byteLength(overflow.stdout), 4);
  assert.deepEqual(overflow.truncated, { stdout: true, stderr: false, combined: true });
});

test('dependency installation requires elevated human approval even when command is configured', async t => {
  const { worktree, print } = await fixture(t);
  const installAuthority = createAuthorityEnvelope({
    actorId: 'worker-one', principal: 'agent', actions: ['dependency.install'], ownedPaths: [], providers: [],
    commands: ['install'],
  });
  await assert.rejects(() => prepareCommand(contract(worktree, print, {
    authority: installAuthority,
    commands: { install: { executable: print, args: ['install'], action: 'dependency.install' } },
  }), { actorId: 'worker-one', commandId: 'install', cwd: '.' }), /approval required/);
});

test('command action is bound to its allowlist ID and cannot borrow unrelated authority', async t => {
  const { worktree, print } = await fixture(t);
  const unrelated = createAuthorityEnvelope({
    actorId: 'worker-one', principal: 'agent', actions: ['file.read'], ownedPaths: ['src'], providers: [],
    commands: ['test'],
  });
  await assert.rejects(() => prepareCommand(contract(worktree, print, {
    authority: unrelated,
    commands: { test: { executable: print, args: ['safe'], action: 'file.read' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' }), CommandPolicyError);
});

test('an abort signal terminates a running command and returns a stable classification', async t => {
  const { worktree, sleep } = await fixture(t);
  const controller = new AbortController();
  const running = runCommand(contract(worktree, sleep, {
    commands: { test: { executable: sleep, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const result = await running;
  assert.equal(result.status, 'aborted');
});

test('run snapshots configured environment getters exactly once', async t => {
  const { worktree, print } = await fixture(t);
  let accesses = 0;
  const environment = {
    get SAFE_VALUE() { accesses += 1; return accesses === 1 ? 'inert-one' : 'inert-two'; },
  };
  const result = await runCommand(contract(worktree, print, { environment }), {
    actorId: 'worker-one', commandId: 'test', cwd: '.',
  });
  assert.equal(result.status, 'success');
  assert.equal(accesses, 1);
});

test('snapshots nested environment before cwd validation so a getter cannot redirect execution', async t => {
  const { root, worktree } = await fixture(t);
  const nested = join(worktree, 'nested');
  const displaced = join(root, 'displaced');
  const markerPath = join(displaced, 'executed-marker');
  const writeMarker = await executableFixture(root, 'write-marker', '#!/bin/sh\nprintf marker > executed-marker\n');
  let accesses = 0;
  const environment = {
    get SAFE_VALUE() {
      accesses += 1;
      renameSync(nested, displaced);
      symlinkSync(displaced, nested);
      return 'inert-value';
    },
  };
  await assert.rejects(() => runCommand(contract(worktree, writeMarker, {
    environment,
    commands: { test: { executable: writeMarker, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: 'nested' }), CommandPolicyError);
  await assert.rejects(() => import('node:fs/promises').then(fs => fs.lstat(markerPath)));
  assert.equal(accesses, 1);
});

test('anchored execution stops if the verified cwd is externally renamed and replaced', async t => {
  const { root, worktree } = await fixture(t);
  const nested = join(worktree, 'nested');
  const displaced = join(root, 'displaced-running');
  const markerPath = join(displaced, 'executed-after-move');
  const started = join(nested, 'target-started');
  const delayed = await executableFixture(root, 'delayed-marker', '#!/bin/sh\nprintf started > target-started\nsleep 0.25\nprintf marker > executed-after-move\n');
  const running = runCommand(contract(worktree, delayed, {
    commands: { test: { executable: delayed, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: 'nested' });
  await waitForPath(started);
  await rename(nested, displaced);
  await mkdir(nested);
  const result = await running;
  await new Promise(resolve => setTimeout(resolve, 350));
  await assert.rejects(() => import('node:fs/promises').then(fs => fs.lstat(markerPath)));
  assert.notEqual(result.status, 'success');
});

test('abort terminates the command process group without leaving a marker-writing orphan', async t => {
  const { root, worktree } = await fixture(t);
  const orphan = await executableFixture(root, 'orphan-attempt', '#!/bin/sh\nprintf started > target-started\n(trap "" HUP TERM; sleep 0.2; printf marker > orphan-marker) &\nwait\n');
  const controller = new AbortController();
  const running = runCommand(contract(worktree, orphan, {
    timeoutMs: 1_000,
    commands: { test: { executable: orphan, args: [], action: 'command.test' } },
  }), { actorId: 'worker-one', commandId: 'test', cwd: '.' }, { signal: controller.signal });
  await waitForPath(join(worktree, 'target-started'));
  controller.abort();
  const result = await running;
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(() => import('node:fs/promises').then(fs => fs.lstat(join(worktree, 'orphan-marker'))));
  assert.equal(result.status, 'aborted');
});

test('signal state and methods are captured once with deterministic listener cleanup', async t => {
  const { worktree, print } = await fixture(t);
  const accesses = { add: 0, remove: 0, aborted: 0 };
  let listener;
  const signal = {
    get addEventListener() { accesses.add += 1; return (_name, handler) => { listener = handler; }; },
    get removeEventListener() { accesses.remove += 1; return (_name, handler) => { if (listener === handler) listener = undefined; }; },
    get aborted() { accesses.aborted += 1; return false; },
  };
  const result = await runCommand(contract(worktree, print), {
    actorId: 'worker-one', commandId: 'test', cwd: '.',
  }, { signal });
  assert.equal(result.status, 'success');
  assert.deepEqual(accesses, { add: 1, remove: 1, aborted: 1 });
  assert.equal(listener, undefined);
});

test('signal snapshot failure removes the listener and sanitizes the hostile getter', async t => {
  const { worktree, print } = await fixture(t);
  const canary = 'signal-private-canary';
  let listener;
  let removals = 0;
  const signal = {
    addEventListener(_name, handler) { listener = handler; },
    removeEventListener(_name, handler) { removals += 1; if (listener === handler) listener = undefined; },
    get aborted() { throw new Error(canary); },
  };
  await assert.rejects(() => runCommand(contract(worktree, print), {
    actorId: 'worker-one', commandId: 'test', cwd: '.',
  }, { signal }), error => {
    assert.ok(error instanceof CommandPolicyError);
    assert.equal(error.message.includes(canary), false);
    return true;
  });
  assert.equal(removals, 1);
  assert.equal(listener, undefined);
});

test('elevated allowlist commands require an exact human receipt and consume it atomically', async t => {
  const { worktree, print } = await fixture(t);
  const registry = approvalRegistry();
  const receipt = createApprovalReceipt({
    id: 'approval-command', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'worker-one',
    action: 'command.test', resource: `command:test:${worktree}`, policyId: 'command.elevated.test',
    decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  });
  const elevated = contract(worktree, print, {
    commands: { test: {
      executable: print, args: ['safe'], action: 'command.test', elevated: true,
      approvalPolicyId: 'command.elevated.test', approverId: 'human-owner',
    } },
  });
  await assert.rejects(() => prepareCommand(elevated, {
    actorId: 'worker-one', commandId: 'test', cwd: '.',
  }), /approval required/);
  const prepared = await prepareCommand(elevated, {
    actorId: 'worker-one', commandId: 'test', cwd: '.', approval: receipt,
    approvalRegistry: registry, nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  });
  assert.equal(prepared.commandId, 'test');
  await assert.rejects(() => prepareCommand(elevated, {
    actorId: 'worker-one', commandId: 'test', cwd: '.', approval: receipt,
    approvalRegistry: registry, nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  }), /approval required/);
});

test('invalid command getters are snapshotted once and errors are sanitized', async t => {
  const { worktree } = await fixture(t);
  const canary = 'command-private-canary';
  let accesses = 0;
  const commands = Object.defineProperty({}, 'test', {
    enumerable: true,
    get() { accesses += 1; throw new Error(canary); },
  });
  await assert.rejects(() => prepareCommand({
    worktree, authority: authority(), commands, timeoutMs: 100, maxOutputBytes: 10, maxStreamOutputBytes: 10,
  }, { actorId: 'worker-one', commandId: 'test', cwd: '.' }), error => {
    assert.ok(error instanceof CommandPolicyError);
    assert.equal(error.message.includes(canary), false);
    assert.equal(JSON.stringify(error).includes(canary), false);
    return true;
  });
  assert.equal(accesses, 1);
});

test('command allowlist maps and argv array traps are read exactly once', async t => {
  const { worktree, print } = await fixture(t);
  const accesses = { ownKeys: 0, command: 0, length: 0, zero: 0 };
  const args = new Proxy(['safe-output'], {
    get(target, property, receiver) {
      if (property === 'length') accesses.length += 1;
      if (property === '0') accesses.zero += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const commands = new Proxy({ test: { executable: print, args, action: 'command.test' } }, {
    ownKeys(target) { accesses.ownKeys += 1; return Reflect.ownKeys(target); },
    get(target, property, receiver) { if (property === 'test') accesses.command += 1; return Reflect.get(target, property, receiver); },
  });
  const prepared = await prepareCommand(contract(worktree, print, { commands }), {
    actorId: 'worker-one', commandId: 'test', cwd: '.',
  });
  assert.equal(prepared.commandId, 'test');
  assert.deepEqual(accesses, { ownKeys: 1, command: 1, length: 1, zero: 1 });
});
