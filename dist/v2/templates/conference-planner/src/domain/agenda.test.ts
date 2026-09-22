import { describe, expect, it } from 'vitest';

import { addSession, removeSession, sessionsOverlap } from './agenda';
import type { ConferenceSession } from './sessions';

function session(
  id: string,
  startsAt: string,
  endsAt: string,
): ConferenceSession {
  return Object.freeze({
    id,
    title: id,
    startsAt,
    endsAt,
    track: 'engineering',
    speakers: Object.freeze(['Test Speaker']),
    room: 'Test Room',
    capacity: 20,
  });
}

const opening = session(
  'session-opening',
  '2026-10-15T09:00:00.000Z',
  '2026-10-15T09:45:00.000Z',
);
const workshop = session(
  'session-workshop',
  '2026-10-15T09:30:00.000Z',
  '2026-10-15T10:15:00.000Z',
);
const adjacent = session(
  'session-adjacent',
  '2026-10-15T09:45:00.000Z',
  '2026-10-15T10:15:00.000Z',
);
const later = session(
  'session-later',
  '2026-10-15T11:00:00.000Z',
  '2026-10-15T11:45:00.000Z',
);
const sessions = Object.freeze([later, workshop, opening, adjacent]);

describe('agenda domain', () => {
  it('uses half-open intervals so overlap conflicts and adjacent sessions do not', () => {
    expect(sessionsOverlap(opening, workshop)).toBe(true);
    expect(sessionsOverlap(opening, adjacent)).toBe(false);
  });

  it('rejects an overlapping session with stable conflicting identities', () => {
    expect(addSession(['session-opening', 'session-later'], 'session-workshop', sessions)).toEqual({
      ok: false,
      reason: 'schedule-conflict',
      conflictingSessionIds: ['session-opening'],
    });
  });

  it('treats adding the same session as an idempotent success', () => {
    expect(addSession(['session-opening'], 'session-opening', sessions)).toEqual({
      ok: true,
      sessionIds: ['session-opening'],
    });
  });

  it('removes a selected session without changing the others', () => {
    expect(removeSession(
      ['session-later', 'session-opening'],
      'session-opening',
      sessions,
    )).toEqual({ ok: true, sessionIds: ['session-later'] });
  });

  it('returns agenda identities in chronological then lexical order', () => {
    expect(addSession(['session-later', 'session-adjacent'], 'session-opening', sessions)).toEqual({
      ok: true,
      sessionIds: ['session-opening', 'session-adjacent', 'session-later'],
    });
  });

  it('rejects malformed, unknown, and malformed-current session identities without throwing', () => {
    expect(addSession([], '../escape', sessions)).toEqual({ ok: false, reason: 'invalid-session' });
    expect(addSession([], 'session-unknown', sessions)).toEqual({ ok: false, reason: 'invalid-session' });
    expect(removeSession(['session-unknown'], 'session-opening', sessions)).toEqual({
      ok: false,
      reason: 'invalid-session',
    });
  });

  it('compares instants independently of timezone offsets', () => {
    const localOffset = session(
      'session-local-offset',
      '2026-10-15T11:30:00.000+02:00',
      '2026-10-15T12:00:00.000+02:00',
    );
    expect(sessionsOverlap(opening, localOffset)).toBe(true);
  });
});
