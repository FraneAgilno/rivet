'use client';

import type { ConferenceSession } from '@/domain/conference';
import { Button } from '@/components/Button/Button';

import styles from './SessionCard.module.css';

type AgendaStatus = Readonly<{ tone: 'success' | 'error'; message: string }>;

export type SessionCardProps = Readonly<{
  disabled?: boolean;
  loading?: boolean;
  onAgendaChange?: (sessionId: string, selected: boolean) => void;
  selected?: boolean;
  session: ConferenceSession;
  status?: AgendaStatus;
}>;

function timeLabel(startsAt: string, endsAt: string) {
  const format = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${format.format(new Date(startsAt))}–${format.format(new Date(endsAt))} UTC`;
}

export function SessionCard({
  disabled = false,
  loading = false,
  onAgendaChange,
  selected = false,
  session,
  status,
}: SessionCardProps) {
  const titleId = `${session.id}-title`;
  const actionName = `${selected ? 'Remove' : 'Add'} ${session.title} ${selected ? 'from' : 'to'} agenda`;

  return (
    <article aria-labelledby={titleId} className={styles.card} data-layout="responsive">
      <div className={styles.content}>
        <p className={styles.eyebrow}>{session.track[0].toUpperCase()}{session.track.slice(1)}</p>
        <h3 className={styles.title} id={titleId}>{session.title}</h3>
        <p className={styles.schedule}>
          <time dateTime={session.startsAt}>{timeLabel(session.startsAt, session.endsAt)}</time>
        </p>
        <p className={styles.details}>{session.speakers.join(' · ')}</p>
        <p className={styles.details}>{session.room} · {session.capacity} seats</p>
      </div>
      <div className={styles.action}>
        <Button
          aria-label={loading ? `Saving ${session.title}` : actionName}
          disabled={disabled}
          loading={loading}
          loadingLabel={`Saving ${session.title}`}
          onClick={() => onAgendaChange?.(session.id, !selected)}
          pressed={selected}
          variant={selected ? 'secondary' : 'primary'}
        >
          {selected ? 'In my agenda' : 'Add to agenda'}
        </Button>
        {status ? (
          <p
            aria-live={status.tone === 'error' ? 'assertive' : 'polite'}
            className={styles.status}
            data-tone={status.tone}
            role="status"
          >
            {status.message}
          </p>
        ) : null}
      </div>
    </article>
  );
}
