import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET, POST } from './route';

const TEST_SECRET = 'local-test-secret-with-at-least-thirty-two-bytes';
const COOKIE_NAME = 'agilno_conference_agenda';

function jsonRequest(body: unknown, cookie?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', `${COOKIE_NAME}=${cookie}`);
  return new Request('http://localhost/api/agenda', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getRequest(cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', `${COOKIE_NAME}=${cookie}`);
  return new Request('http://localhost/api/agenda', { headers });
}

function responseCookie(response: Response) {
  const header = response.headers.get('set-cookie');
  expect(header).toMatch(/HttpOnly/i);
  expect(header).toMatch(/SameSite=Lax/i);
  const match = header?.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

function streamingRequest(contentLength?: string) {
  let reads = 0;
  let cancellations = 0;
  let textCalls = 0;
  const reader = {
    async read() {
      reads += 1;
      if (reads === 1) return { done: false, value: new Uint8Array(4096) };
      if (reads === 2) return { done: false, value: new Uint8Array(1) };
      throw new Error('the oversized request body must not be buffered');
    },
    async cancel() {
      await Promise.resolve();
      cancellations += 1;
    },
    releaseLock() {},
  };
  const headers = new Headers();
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  const request = {
    body: { getReader: () => reader },
    headers,
    async text() {
      textCalls += 1;
      throw new Error('request.text() must not be used for bounded input');
    },
  } as unknown as Request;
  return { request, observations: () => ({ reads, cancellations, textCalls }) };
}

function noncooperativeCancellationRequest(kind: 'declared' | 'streamed') {
  let reads = 0;
  let cancellations = 0;
  let rejectCancellation: ((reason?: unknown) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const cancel = () => {
    cancellations += 1;
    return cancellation;
  };
  const reader = {
    async read() {
      reads += 1;
      if (reads === 1) return { done: false, value: new Uint8Array(4097) };
      throw new Error('the oversized request body must stop after the first chunk');
    },
    cancel,
    releaseLock() {},
  };
  const headers = new Headers();
  if (kind === 'declared') headers.set('content-length', '4097');
  const request = {
    body: {
      cancel,
      getReader() {
        if (kind === 'declared') throw new Error('declared overflow must not acquire a reader');
        return reader;
      },
    },
    headers,
  } as unknown as Request;
  return {
    request,
    observations: () => ({ reads, cancellations }),
    rejectCancellation: () => rejectCancellation?.(new Error('late cancellation canary')),
  };
}

async function promptResponse(operation: Promise<Response>, releaseCancellation: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('response waited for body cancellation')), 100);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    releaseCancellation();
    await operation.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('agenda route', () => {
  beforeEach(() => { process.env.DEMO_SESSION_SECRET = TEST_SECRET; });
  afterEach(() => { delete process.env.DEMO_SESSION_SECRET; });

  it('reads an empty agenda without setting a cookie', async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessionIds: [] });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('adds and removes a session through a signed HttpOnly cookie', async () => {
    const added = await POST(jsonRequest({ action: 'add', sessionId: 'session-opening-keynote' }));
    expect(added.status).toBe(200);
    await expect(added.json()).resolves.toEqual({ sessionIds: ['session-opening-keynote'] });
    const cookie = responseCookie(added);

    const read = await GET(getRequest(cookie));
    await expect(read.json()).resolves.toEqual({ sessionIds: ['session-opening-keynote'] });

    const removed = await POST(jsonRequest(
      { action: 'remove', sessionId: 'session-opening-keynote' },
      cookie,
    ));
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ sessionIds: [] });
  });

  it('returns an actionable conflict without replacing the current agenda', async () => {
    const initial = await POST(jsonRequest({ action: 'add', sessionId: 'session-opening-keynote' }));
    const cookie = responseCookie(initial);
    const conflict = await POST(jsonRequest(
      { action: 'add', sessionId: 'session-agenda-workshop' },
      cookie,
    ));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: 'schedule-conflict',
      conflictingSessionIds: ['session-opening-keynote'],
    });
    expect(conflict.headers.get('set-cookie')).toBeNull();
  });

  it('treats a tampered cookie as an empty agenda', async () => {
    const response = await GET(getRequest('v1.private-cookie-canary.invalid'));
    await expect(response.json()).resolves.toEqual({ sessionIds: [] });
  });

  it('rejects invalid commands without reflecting input or secret values', async () => {
    const response = await POST(jsonRequest({ action: 'private-action-canary', sessionId: '../escape' }));
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"error":"Agenda request is invalid."}');
    expect(body).not.toContain(TEST_SECRET);
    expect(body).not.toContain('private-action-canary');
  });

  it('fails closed when the signing secret is unavailable', async () => {
    delete process.env.DEMO_SESSION_SECRET;
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Agenda cookie signing is not configured.',
    });
  });

  for (const [label, contentLength] of [['missing', undefined], ['lying', '1']] as const) {
    it(`stops and cancels an oversized stream with ${label} Content-Length`, async () => {
      const { request, observations } = streamingRequest(contentLength);
      const response = await POST(request);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Agenda request is too large.' });
      expect(observations()).toEqual({ reads: 2, cancellations: 1, textCalls: 0 });
    });
  }

  for (const kind of ['declared', 'streamed'] as const) {
    it(`returns 413 promptly for ${kind} overflow when cancellation never settles`, async () => {
      const { request, observations, rejectCancellation } = noncooperativeCancellationRequest(kind);
      const response = await promptResponse(POST(request), rejectCancellation);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Agenda request is too large.' });
      expect(observations()).toEqual({ reads: kind === 'declared' ? 0 : 1, cancellations: 1 });
    });
  }
});
