import { conferenceSessions, type ConferenceSession } from './sessions';

const SESSION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type AgendaSuccess = Readonly<{ ok: true; sessionIds: readonly string[] }>;
export type AgendaFailure =
  | Readonly<{ ok: false; reason: 'invalid-session' }>
  | Readonly<{
      ok: false;
      reason: 'schedule-conflict';
      conflictingSessionIds: readonly string[];
    }>;
export type AgendaMutationResult = AgendaSuccess | AgendaFailure;

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError('Session schedule is invalid.');
  return parsed;
}

function interval(value: ConferenceSession): readonly [number, number] {
  const start = instant(value.startsAt);
  const end = instant(value.endsAt);
  if (end <= start) throw new TypeError('Session schedule is invalid.');
  return [start, end];
}

export function sessionsOverlap(left: ConferenceSession, right: ConferenceSession): boolean {
  const [leftStart, leftEnd] = interval(left);
  const [rightStart, rightEnd] = interval(right);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function catalog(value: readonly ConferenceSession[]) {
  const byId = new Map<string, ConferenceSession>();
  for (const session of value) {
    if (!SESSION_ID.test(session.id) || byId.has(session.id)) {
      throw new TypeError('Session catalog is invalid.');
    }
    interval(session);
    byId.set(session.id, session);
  }
  return byId;
}

function canonicalAgenda(
  sessionIds: readonly string[],
  byId: ReadonlyMap<string, ConferenceSession>,
): readonly string[] | null {
  if (!Array.isArray(sessionIds)) return null;
  const unique = [...new Set(sessionIds)];
  if (unique.some(id => typeof id !== 'string' || !SESSION_ID.test(id) || !byId.has(id))) return null;
  return Object.freeze(unique.sort((left, right) => {
    const leftSession = byId.get(left)!;
    const rightSession = byId.get(right)!;
    return instant(leftSession.startsAt) - instant(rightSession.startsAt) || left.localeCompare(right);
  }));
}

export function addSession(
  currentSessionIds: readonly string[],
  requestedSessionId: string,
  availableSessions: readonly ConferenceSession[] = conferenceSessions,
): AgendaMutationResult {
  const byId = catalog(availableSessions);
  const current = canonicalAgenda(currentSessionIds, byId);
  if (!current || typeof requestedSessionId !== 'string' || !SESSION_ID.test(requestedSessionId)) {
    return Object.freeze({ ok: false, reason: 'invalid-session' });
  }
  const requested = byId.get(requestedSessionId);
  if (!requested) return Object.freeze({ ok: false, reason: 'invalid-session' });
  if (current.includes(requestedSessionId)) return Object.freeze({ ok: true, sessionIds: current });
  const conflicts = current.filter(sessionId => sessionsOverlap(byId.get(sessionId)!, requested));
  if (conflicts.length > 0) {
    return Object.freeze({
      ok: false,
      reason: 'schedule-conflict',
      conflictingSessionIds: Object.freeze(conflicts),
    });
  }
  return Object.freeze({
    ok: true,
    sessionIds: canonicalAgenda([...current, requestedSessionId], byId)!,
  });
}

export function removeSession(
  currentSessionIds: readonly string[],
  requestedSessionId: string,
  availableSessions: readonly ConferenceSession[] = conferenceSessions,
): AgendaMutationResult {
  const byId = catalog(availableSessions);
  const current = canonicalAgenda(currentSessionIds, byId);
  if (!current || typeof requestedSessionId !== 'string' || !SESSION_ID.test(requestedSessionId)
    || !byId.has(requestedSessionId)) {
    return Object.freeze({ ok: false, reason: 'invalid-session' });
  }
  return Object.freeze({
    ok: true,
    sessionIds: Object.freeze(current.filter(sessionId => sessionId !== requestedSessionId)),
  });
}
