import { NextResponse } from 'next/server';

import { addSession, removeSession } from '@/domain/agenda';
import { conferenceSessionIds } from '@/domain/sessions';
import { decodeAgendaCookie, encodeAgendaCookie } from '@/server/agenda-cookie';

const COOKIE_NAME = 'agilno_conference_agenda';
const MAX_REQUEST_BYTES = 4096;
const TOO_LARGE = Symbol('too-large');
const INVALID_BODY = Symbol('invalid-body');

function signingSecret(): string | null {
  const value = process.env.DEMO_SESSION_SECRET;
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32 ? value : null;
}

function cookieValue(request: Request): string | undefined {
  const cookie = request.headers.get('cookie') ?? '';
  for (const pair of cookie.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== COOKIE_NAME) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}

function unavailable() {
  return NextResponse.json({ error: 'Agenda cookie signing is not configured.' }, { status: 503 });
}

function observeCancellation(cancel: () => Promise<void>) {
  try {
    const result = cancel();
    Promise.prototype.then.call(result, () => undefined, () => undefined);
  } catch { /* cancellation failure must not replace the bounded public response */ }
}

function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (body) observeCancellation(() => body.cancel());
}

function isByteChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
    || (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]');
}

async function readBoundedBody(request: Request): Promise<Uint8Array | typeof TOO_LARGE | typeof INVALID_BODY> {
  const body = request.body;
  if (!body) return new Uint8Array();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); }
  catch { return INVALID_BODY; }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!isByteChunk(result.value)) throw new Error('invalid chunk');
      total += result.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        observeCancellation(() => reader.cancel());
        return TOO_LARGE;
      }
      chunks.push(result.value);
    }
  } catch {
    observeCancellation(() => reader.cancel());
    return INVALID_BODY;
  } finally {
    try { reader.releaseLock(); }
    catch { /* releasing an already-settled reader is best effort */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function GET(request: Request) {
  const secret = signingSecret();
  if (!secret) return unavailable();
  const sessionIds = (await decodeAgendaCookie(cookieValue(request), secret))
    .filter(sessionId => conferenceSessionIds.has(sessionId));
  return NextResponse.json({ sessionIds });
}

export async function POST(request: Request) {
  const secret = signingSecret();
  if (!secret) return unavailable();
  const contentLength = request.headers.get('content-length');
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    cancelBody(request.body);
    return NextResponse.json({ error: 'Agenda request is too large.' }, { status: 413 });
  }
  const body = await readBoundedBody(request);
  if (body === TOO_LARGE) {
    return NextResponse.json({ error: 'Agenda request is too large.' }, { status: 413 });
  }
  if (body === INVALID_BODY) return NextResponse.json({ error: 'Agenda request is invalid.' }, { status: 400 });
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { return NextResponse.json({ error: 'Agenda request is invalid.' }, { status: 400 }); }
  let command: unknown;
  try {
    command = JSON.parse(source);
  } catch {
    return NextResponse.json({ error: 'Agenda request is invalid.' }, { status: 400 });
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)
    || Object.keys(command).sort().join(',') !== 'action,sessionId') {
    return NextResponse.json({ error: 'Agenda request is invalid.' }, { status: 400 });
  }
  const { action, sessionId } = command as { action?: unknown; sessionId?: unknown };
  if (!['add', 'remove'].includes(action as string)
    || typeof sessionId !== 'string' || !conferenceSessionIds.has(sessionId)) {
    return NextResponse.json({ error: 'Agenda request is invalid.' }, { status: 400 });
  }
  const current = (await decodeAgendaCookie(cookieValue(request), secret))
    .filter(value => conferenceSessionIds.has(value));
  const result = action === 'add'
    ? addSession(current, sessionId)
    : removeSession(current, sessionId);
  if (!result.ok && result.reason === 'schedule-conflict') {
    return NextResponse.json({
      error: result.reason,
      conflictingSessionIds: result.conflictingSessionIds,
    }, { status: 409 });
  }
  if (!result.ok) return NextResponse.json({ error: 'Agenda request is invalid.' }, { status: 400 });
  let value: string;
  try { value = await encodeAgendaCookie(result.sessionIds, secret); }
  catch { return NextResponse.json({ error: 'Agenda request is invalid.' }, { status: 400 }); }
  const response = NextResponse.json({ sessionIds: result.sessionIds });
  response.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
