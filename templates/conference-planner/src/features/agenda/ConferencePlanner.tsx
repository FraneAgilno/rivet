'use client';

import { useEffect, useMemo, useState } from 'react';

import { ConflictDialog } from '@/components/ConflictDialog/ConflictDialog';
import { SessionCard } from '@/components/SessionCard/SessionCard';
import type { ConferenceSession } from '@/domain/sessions';

import styles from './ConferencePlanner.module.css';

type AgendaResponse = Readonly<{ ok: true; sessionIds: readonly string[] }>;
type ConflictResponse = Readonly<{
  ok: false;
  reason: 'schedule-conflict';
  conflictingSessionIds: readonly string[];
}>;

function captureSessionIds(value: unknown, knownIds: ReadonlySet<string>): readonly string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionIds = (value as { sessionIds?: unknown }).sessionIds;
  if (!Array.isArray(sessionIds) || sessionIds.length > knownIds.size
    || sessionIds.some(id => typeof id !== 'string' || !knownIds.has(id))
    || new Set(sessionIds).size !== sessionIds.length) return null;
  return Object.freeze([...sessionIds]);
}

function captureConflictIds(value: unknown, knownIds: ReadonlySet<string>): readonly string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as { error?: unknown }).error !== 'schedule-conflict') return null;
  const ids = (value as { conflictingSessionIds?: unknown }).conflictingSessionIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > knownIds.size
    || ids.some(id => typeof id !== 'string' || !knownIds.has(id))
    || new Set(ids).size !== ids.length) return null;
  return Object.freeze([...ids]);
}

export function ConferencePlanner({ sessions }: Readonly<{ sessions: readonly ConferenceSession[] }>) {
  const sessionsById = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
  const knownIds = useMemo(() => new Set(sessionsById.keys()), [sessionsById]);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [status, setStatus] = useState<Readonly<{
    id: string;
    tone: 'success' | 'error';
    message: string;
  }> | null>(null);
  const [conflict, setConflict] = useState<Readonly<{
    requested: ConferenceSession;
    conflicts: readonly ConferenceSession[];
  }> | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/agenda', {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        const ids = response.ok ? captureSessionIds(payload, knownIds) : null;
        if (!ids) throw new Error('invalid agenda response');
        setSelectedIds(ids);
        setPhase('ready');
      } catch {
        if (!controller.signal.aborted) setPhase('error');
      }
    })();
    return () => controller.abort();
  }, [knownIds]);

  async function requestMutation(
    action: 'add' | 'remove',
    sessionId: string,
  ): Promise<AgendaResponse | ConflictResponse> {
    const response = await fetch('/api/agenda', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ action, sessionId }),
    });
    const payload: unknown = await response.json();
    if (response.status === 409) {
      const conflictIds = captureConflictIds(payload, knownIds);
      if (!conflictIds) throw new Error('invalid conflict response');
      return { ok: false, reason: 'schedule-conflict', conflictingSessionIds: conflictIds };
    }
    const ids = response.ok ? captureSessionIds(payload, knownIds) : null;
    if (!ids) throw new Error('invalid agenda response');
    return { ok: true, sessionIds: ids };
  }

  async function changeAgenda(sessionId: string, selected: boolean) {
    if (phase !== 'ready' || savingId) return;
    setSavingId(sessionId);
    setStatus(null);
    try {
      const result = await requestMutation(selected ? 'add' : 'remove', sessionId);
      if (!result.ok) {
        const requested = sessionsById.get(sessionId);
        const conflicts = result.conflictingSessionIds
          .map(id => sessionsById.get(id))
          .filter((session): session is ConferenceSession => Boolean(session));
        if (!requested || conflicts.length !== result.conflictingSessionIds.length) {
          throw new Error('invalid conflict response');
        }
        setConflict({ requested, conflicts: Object.freeze(conflicts) });
        return;
      }
      setSelectedIds(result.sessionIds);
      setStatus({
        id: sessionId,
        tone: 'success',
        message: selected ? 'Saved to your agenda.' : 'Removed from your agenda.',
      });
    } catch {
      setPhase('error');
      setStatus({ id: sessionId, tone: 'error', message: 'Agenda update failed.' });
    } finally {
      setSavingId(null);
    }
  }

  async function replaceConflicts() {
    if (!conflict || resolving) return;
    setResolving(true);
    setSavingId(conflict.requested.id);
    try {
      let latest: readonly string[] = selectedIds;
      for (const existing of conflict.conflicts) {
        const removed = await requestMutation('remove', existing.id);
        if (!removed.ok) throw new Error('invalid remove response');
        latest = removed.sessionIds;
      }
      const added = await requestMutation('add', conflict.requested.id);
      if (!added.ok) throw new Error('conflict remained after confirmation');
      latest = added.sessionIds;
      setSelectedIds(latest);
      setStatus({
        id: conflict.requested.id,
        tone: 'success',
        message: 'Saved to your agenda.',
      });
      setConflict(null);
    } catch {
      setConflict(null);
      setPhase('error');
      setStatus(null);
    } finally {
      setResolving(false);
      setSavingId(null);
    }
  }

  const selected = selectedIds
    .map(id => sessionsById.get(id))
    .filter((session): session is ConferenceSession => Boolean(session));

  return (
    <main className={styles.planner}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Agilno Conference 2026</p>
        <h1>Build your conference day</h1>
        <p>Browse the program, save sessions, and resolve schedule conflicts before they reach your day.</p>
      </header>

      {phase === 'loading' ? <p role="status">Loading your agenda…</p> : null}
      {phase === 'error' ? (
        <p className={styles.error} role="alert">Agenda unavailable. Refresh to try again.</p>
      ) : null}

      <div className={styles.layout}>
        <section aria-labelledby="program-heading" className={styles.program}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Program</p>
              <h2 id="program-heading">Choose your sessions</h2>
            </div>
            <p>{sessions.length} sessions · Times shown in UTC</p>
          </div>
          <div className={styles.sessions}>
            {sessions.map(session => (
              <SessionCard
                disabled={phase !== 'ready' || Boolean(savingId && savingId !== session.id)}
                key={session.id}
                loading={savingId === session.id}
                onAgendaChange={(id, nextSelected) => { void changeAgenda(id, nextSelected); }}
                selected={selectedIds.includes(session.id)}
                session={session}
                status={status?.id === session.id ? status : undefined}
              />
            ))}
          </div>
        </section>

        <aside aria-labelledby="agenda-heading" className={styles.agenda}>
          <p className={styles.eyebrow}>My agenda</p>
          <h2 id="agenda-heading">Your conference day</h2>
          {phase === 'ready' && selected.length === 0 ? <p>No sessions saved yet.</p> : null}
          {selected.length > 0 ? (
            <ol className={styles.savedSessions}>
              {selected.map(session => <li key={session.id}>{session.title}</li>)}
            </ol>
          ) : null}
        </aside>
      </div>

      {conflict ? (
        <ConflictDialog
          conflicts={conflict.conflicts}
          onConfirm={() => { void replaceConflicts(); }}
          onDismiss={() => setConflict(null)}
          open
          requested={conflict.requested}
          resolving={resolving}
        />
      ) : null}
    </main>
  );
}
