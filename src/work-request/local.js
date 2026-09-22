import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { createWorkRequest, WorkRequestError } from './contract.js';

const MAX_REQUEST_BYTES = 128 * 1024;
const LIST_ITEM = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;
const ACCEPTANCE_ITEM = /^\s*(?:AC\s*\d*|acceptance criteria)\s*[:.-]\s*(.+?)\s*$/i;

function fail() { throw new WorkRequestError(); }

function safeInputString(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value.normalize('NFKC') !== value || value.includes('\0')) fail();
  return value;
}

function sectionLines(lines, heading) {
  const start = lines.findIndex(line => new RegExp(`^#{2,6}\\s+${heading}\\s*$`, 'i').test(line));
  if (start < 0) return [];
  const result = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) break;
    result.push(lines[index]);
  }
  return result;
}

function listed(lines, matcher = LIST_ITEM, continuations = false) {
  const output = [];
  for (const line of lines) {
    const match = matcher.exec(line) ?? (matcher !== LIST_ITEM ? LIST_ITEM.exec(line) : null);
    if (match?.[1]) {
      output.push(match[1].trim());
    } else if (continuations && line.trim() && output.length > 0) {
      output[output.length - 1] = `${output.at(-1)} ${line.trim()}`;
    }
  }
  return output;
}

export function markdownAcceptanceCriteria(text) {
  return listed(sectionLines(text.replaceAll('\r\n', '\n').split('\n'), 'acceptance criteria'), ACCEPTANCE_ITEM, true);
}

function parseMarkdown(text) {
  const source = safeInputString(text, MAX_REQUEST_BYTES);
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const titleLine = lines.find(line => /^#\s+\S/.test(line));
  if (!titleLine) fail();
  const title = titleLine.replace(/^#\s+/, '').trim();
  const acceptanceCriteria = markdownAcceptanceCriteria(source);
  if (acceptanceCriteria.length === 0) fail();
  const contextRefs = listed(sectionLines(lines, 'context'));
  return { title, description: source.trim(), acceptanceCriteria, contextRefs };
}

function safeRelativeRequestPath(value) {
  const path = safeInputString(value, 512).replaceAll('\\', '/');
  if (isAbsolute(path) || !path.endsWith('.md') || path === '.' || path.startsWith('/')
    || path.endsWith('/') || path.includes('//') || /^[A-Za-z]:/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) fail();
  return path;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink;
}

async function assertSafeAncestors(root, relativePath) {
  const rootStatus = await lstat(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) fail();
  const parts = relativePath.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    const status = await lstat(current);
    if (status.isSymbolicLink() || !status.isDirectory()) fail();
  }
}

async function boundedRegularFile(rootInput, pathInput) {
  try {
    const root = resolve(safeInputString(rootInput, 4096));
    const requestPath = safeRelativeRequestPath(pathInput);
    const absolute = resolve(root, ...requestPath.split('/'));
    const contained = relative(root, absolute);
    if (!contained || contained.startsWith(`..${sep}`) || contained === '..' || isAbsolute(contained)) fail();
    await assertSafeAncestors(root, requestPath);
    const before = await lstat(absolute);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_REQUEST_BYTES) fail();
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!sameFile(before, opened)) fail();
      const chunks = [];
      let total = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(16 * 1024, MAX_REQUEST_BYTES + 1 - total));
        if (buffer.length === 0) fail();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_REQUEST_BYTES) fail();
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (!sameFile(opened, after) || total !== after.size) fail();
      const bytes = Buffer.concat(chunks, total);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
      return { requestPath, bytes, text };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof WorkRequestError) throw error;
    fail();
  }
}

export function resolveInlineWorkRequest(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Reflect.ownKeys(input).some(key => !['text', 'capturedAt'].includes(key))
      || !Object.hasOwn(input, 'text') || !Object.hasOwn(input, 'capturedAt')) fail();
    const parsed = parseMarkdown(input.text);
    return createWorkRequest({
      source: { kind: 'inline', ref: 'inline' },
      ...parsed,
      capturedAt: input.capturedAt,
    });
  } catch (error) {
    if (error instanceof WorkRequestError) throw error;
    fail();
  }
}

export async function resolveMarkdownWorkRequest(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Reflect.ownKeys(input).some(key => !['root', 'path', 'capturedAt'].includes(key))
      || !['root', 'path', 'capturedAt'].every(key => Object.hasOwn(input, key))) fail();
    const file = await boundedRegularFile(input.root, input.path);
    const parsed = parseMarkdown(file.text);
    return createWorkRequest({
      source: {
        kind: 'markdown',
        ref: file.requestPath,
        revision: `sha256:${createHash('sha256').update(file.bytes).digest('hex')}`,
      },
      ...parsed,
      capturedAt: input.capturedAt,
    });
  } catch (error) {
    if (error instanceof WorkRequestError) throw error;
    fail();
  }
}
