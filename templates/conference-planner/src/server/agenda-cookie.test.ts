import { describe, expect, it } from 'vitest';

import { decodeAgendaCookie, encodeAgendaCookie } from './agenda-cookie';

const secret = 'local-test-secret-with-at-least-thirty-two-bytes';

describe('agenda cookie', () => {
  it('round-trips a versioned canonical agenda with Web Crypto', async () => {
    const value = await encodeAgendaCookie(
      ['session-runtime-guardrails', 'session-opening-keynote'],
      secret,
    );
    expect(value.startsWith('v1.')).toBe(true);
    await expect(decodeAgendaCookie(value, secret)).resolves.toEqual([
      'session-opening-keynote',
      'session-runtime-guardrails',
    ]);
  });

  it('rejects tampering, unknown versions, and malformed payloads without exposing content', async () => {
    const value = await encodeAgendaCookie(['session-opening-keynote'], secret);
    await expect(decodeAgendaCookie(`${value}x`, secret)).resolves.toEqual([]);
    await expect(decodeAgendaCookie(value.replace(/^v1\./, 'v2.'), secret)).resolves.toEqual([]);
    await expect(decodeAgendaCookie('private-cookie-canary', secret)).resolves.toEqual([]);
  });

  it('requires a bounded signing secret without retaining it in the public error', async () => {
    await expect(encodeAgendaCookie([], 'private-short-secret')).rejects.toMatchObject({
      message: 'Agenda cookie signing is not configured.',
    });
    await expect(encodeAgendaCookie([], 'private-short-secret')).rejects.not.toHaveProperty('cause');
  });
});
