import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveInlineWorkRequest,
  resolveMarkdownWorkRequest,
} from '../../src/work-request/local.js';

const NOW = '2026-08-31T12:00:00.000Z';
const REQUEST = `# Smart Agenda Builder

Add a deterministic personal-agenda recommendation flow.

## Acceptance criteria

- Attendees can select preferred tracks and an availability window.
- The accepted agenda downloads as an iCalendar file.

## Context

- CONFLUENCE:1234
`;

test('resolves inline Markdown into the canonical work request', () => {
  const request = resolveInlineWorkRequest({ text: REQUEST, capturedAt: NOW });

  assert.equal(request.source.kind, 'inline');
  assert.equal(request.title, 'Smart Agenda Builder');
  assert.deepEqual(request.acceptanceCriteria, [
    'Attendees can select preferred tracks and an availability window.',
    'The accepted agenda downloads as an iCalendar file.',
  ]);
  assert.deepEqual(request.contextRefs, ['CONFLUENCE:1234']);
});

test('preserves wrapped continuation lines in acceptance criteria', () => {
  const request = resolveInlineWorkRequest({
    capturedAt: NOW,
    text: `# Session discovery

## Acceptance criteria

- Add or update Playwright coverage for search, filter composition, reset,
  empty state, keyboard operation, and mobile behavior.
- All configured lint, typecheck, test, Storybook, accessibility, and build
  gates must pass.
`,
  });

  assert.deepEqual(request.acceptanceCriteria, [
    'Add or update Playwright coverage for search, filter composition, reset, empty state, keyboard operation, and mobile behavior.',
    'All configured lint, typecheck, test, Storybook, accessibility, and build gates must pass.',
  ]);
});

test('reads one regular Markdown file and binds its relative path and digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-request-local-'));
  await mkdir(join(root, 'requests'));
  await writeFile(join(root, 'requests', 'smart-agenda.md'), REQUEST);

  const request = await resolveMarkdownWorkRequest({
    root,
    path: 'requests/smart-agenda.md',
    capturedAt: NOW,
  });

  assert.equal(request.source.kind, 'markdown');
  assert.equal(request.source.ref, 'requests/smart-agenda.md');
  assert.match(request.source.revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(request.title, 'Smart Agenda Builder');
});

test('rejects missing criteria, traversal, symlinks, hard links, invalid UTF-8, and oversized input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'work-request-hostile-'));
  await writeFile(join(root, 'plain.md'), '# Missing criteria\n\nImplement something.');
  await writeFile(join(root, 'valid.md'), REQUEST);
  await symlink(join(root, 'valid.md'), join(root, 'linked.md'));
  await link(join(root, 'valid.md'), join(root, 'hard.md'));
  await writeFile(join(root, 'invalid.md'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(root, 'large.md'), `# Large\n\n## Acceptance criteria\n\n- ${'x'.repeat(132_000)}`);

  assert.throws(() => resolveInlineWorkRequest({ text: 'Add calendar export', capturedAt: NOW }), /Work request is invalid/);
  for (const path of ['../outside.md', 'linked.md', 'hard.md', 'invalid.md', 'large.md', 'plain.md']) {
    await t.test(path, async () => {
      await assert.rejects(
        () => resolveMarkdownWorkRequest({ root, path, capturedAt: NOW }),
        /Work request is invalid/,
      );
    });
  }
});

test('rejects a symlinked ancestor before opening the request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-request-ancestor-'));
  const outside = await mkdtemp(join(tmpdir(), 'work-request-outside-'));
  await writeFile(join(outside, 'request.md'), REQUEST);
  await symlink(outside, join(root, 'requests'));

  await assert.rejects(
    () => resolveMarkdownWorkRequest({ root, path: 'requests/request.md', capturedAt: NOW }),
    /Work request is invalid/,
  );
});
