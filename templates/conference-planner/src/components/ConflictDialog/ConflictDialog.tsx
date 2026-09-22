'use client';

import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';

import type { ConferenceSession } from '@/domain/conference';
import { Button } from '@/components/Button/Button';

import styles from './ConflictDialog.module.css';

export type ConflictDialogProps = Readonly<{
  conflicts: readonly ConferenceSession[];
  onConfirm?: () => void;
  onDismiss?: () => void;
  open: boolean;
  requested: ConferenceSession;
  resolving?: boolean;
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

export function ConflictDialog({
  conflicts,
  onConfirm,
  onDismiss,
  open,
  requested,
  resolving = false,
}: ConflictDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    if (open && !wasOpen) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      const firstAction = [cancelRef.current, confirmRef.current]
        .find(action => action && !action.disabled);
      (firstAction ?? dialogRef.current)?.focus();
    } else if (!open && wasOpen) {
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected) previousFocus.focus();
      previousFocusRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !resolving) return;
    const dialog = dialogRef.current;
    const activeElement = document.activeElement;
    if (
      dialog
      && (
        !dialog.contains(activeElement)
        || activeElement === cancelRef.current
        || activeElement === confirmRef.current
      )
    ) dialog.focus();
  }, [open, resolving]);

  useLayoutEffect(() => () => {
    const dialog = dialogRef.current;
    const previousFocus = previousFocusRef.current;
    if (
      wasOpenRef.current
      && dialog?.contains(document.activeElement)
      && previousFocus?.isConnected
    ) previousFocus.focus();
    wasOpenRef.current = false;
    previousFocusRef.current = null;
  }, []);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!resolving) onDismiss?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const actions = [cancelRef.current, confirmRef.current]
      .filter((action): action is HTMLButtonElement => Boolean(action && !action.disabled));
    const firstAction = actions[0];
    const lastAction = actions.at(-1);
    if (!firstAction || !lastAction) {
      event.preventDefault();
      dialogRef.current?.focus();
    } else if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? lastAction : firstAction).focus();
    } else if (event.shiftKey && document.activeElement === firstAction) {
      event.preventDefault();
      lastAction.focus();
    } else if (!event.shiftKey && document.activeElement === lastAction) {
      event.preventDefault();
      firstAction.focus();
    }
  }

  return (
    <div className={styles.backdrop}>
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className={styles.title} id={titleId}>Schedule conflict</h2>
        <p className={styles.summary} id={descriptionId}>
          <span className={styles.requested}>{requested.title}</span> overlaps with your current agenda.
        </p>
        <ul aria-label="Conflicting sessions" className={styles.conflicts}>
          {conflicts.map(conflict => (
            <li className={styles.conflict} key={conflict.id}>
              <p className={styles.conflictTitle}>{conflict.title}</p>
              <p className={styles.conflictTime}>{timeLabel(conflict.startsAt, conflict.endsAt)}</p>
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <Button disabled={resolving} onClick={onDismiss} ref={cancelRef} variant="secondary">
            Keep current agenda
          </Button>
          <Button
            loading={resolving}
            loadingLabel="Updating agenda"
            onClick={onConfirm}
            ref={confirmRef}
          >
            Replace conflict with {requested.title}
          </Button>
        </div>
      </div>
    </div>
  );
}
