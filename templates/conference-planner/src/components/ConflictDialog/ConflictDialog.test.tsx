import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConferenceSession } from '@/domain/conference';
import { ConflictDialog } from './ConflictDialog';

afterEach(cleanup);

const requested: ConferenceSession = {
  id: 'session-requested',
  title: 'Runtime guardrails that fail closed',
  startsAt: '2026-10-15T10:15:00.000Z',
  endsAt: '2026-10-15T11:00:00.000Z',
  track: 'engineering',
  speakers: ['Noah Reed'],
  room: 'Studio 2',
  capacity: 180,
};

const conflict: ConferenceSession = {
  ...requested,
  id: 'session-conflict',
  title: 'Evidence-led design reviews with a deliberately long title that must remain readable',
  track: 'design',
  speakers: ['Sofia Adeyemi'],
  room: 'Gallery',
};

function DismissibleDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">Open conflict details</button>
      <ConflictDialog
        open={open}
        requested={requested}
        conflicts={[conflict]}
        onDismiss={() => setOpen(false)}
      />
    </>
  );
}

describe('ConflictDialog', () => {
  it('is absent when closed', () => {
    render(<ConflictDialog open={false} requested={requested} conflicts={[conflict]} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has a modal accessible name and explains every conflicting session', () => {
    render(<ConflictDialog open requested={requested} conflicts={[conflict]} />);

    const dialog = screen.getByRole('dialog', { name: 'Schedule conflict' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(requested.title);
    expect(dialog).toHaveTextContent(conflict.title);
    expect(dialog).toHaveTextContent('10:15–11:00 UTC');
    expect(screen.getByRole('button', { name: 'Keep current agenda' })).toHaveFocus();
  });

  it('dismisses with Escape and does not confirm accidentally', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConflictDialog
        open
        requested={requested}
        conflicts={[conflict]}
        onDismiss={onDismiss}
        onConfirm={onConfirm}
      />,
    );

    await user.keyboard('[Escape]');

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('restores focus to the trigger after Escape closes the dialog', async () => {
    const user = userEvent.setup();
    render(<DismissibleDialog />);
    const trigger = screen.getByRole('button', { name: 'Open conflict details' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Keep current agenda' })).toHaveFocus();
    await user.keyboard('[Escape]');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('focuses the dialog fallback and traps Tab when opened with no enabled actions', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<button type="button">Agenda trigger</button>);
    const trigger = screen.getByRole('button', { name: 'Agenda trigger' });
    trigger.focus();

    rerender(
      <>
        <button type="button">Agenda trigger</button>
        <ConflictDialog open requested={requested} conflicts={[conflict]} resolving />
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Schedule conflict' });
    expect(dialog).toHaveFocus();
    await user.keyboard('[Tab]');
    expect(dialog).toHaveFocus();
  });

  it('keeps focus stable across unrelated rerenders and contained across resolving transitions', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConflictDialog open requested={requested} conflicts={[conflict]} />,
    );
    const confirm = screen.getByRole('button', { name: `Replace conflict with ${requested.title}` });
    confirm.focus();

    rerender(<ConflictDialog open requested={requested} conflicts={[{ ...conflict }]} />);
    expect(confirm).toHaveFocus();

    rerender(<ConflictDialog open requested={requested} conflicts={[conflict]} resolving />);
    const dialog = screen.getByRole('dialog', { name: 'Schedule conflict' });
    expect(dialog).toHaveFocus();
    await user.keyboard('[Tab]');
    expect(dialog).toHaveFocus();

    rerender(<ConflictDialog open requested={requested} conflicts={[conflict]} />);
    await user.keyboard('[Tab]');
    expect(screen.getByRole('button', { name: 'Keep current agenda' })).toHaveFocus();
  });

  it('does not restore stale focus when an open dialog unmounts after focus moved elsewhere', () => {
    const { rerender } = render(
      <>
        <button type="button">Original trigger</button>
        <button type="button">New destination</button>
      </>,
    );
    const original = screen.getByRole('button', { name: 'Original trigger' });
    original.focus();
    rerender(
      <>
        <button type="button">Original trigger</button>
        <button type="button">New destination</button>
        <ConflictDialog open requested={requested} conflicts={[conflict]} />
      </>,
    );
    const destination = screen.getByRole('button', { name: 'New destination' });
    destination.focus();

    rerender(
      <>
        <button type="button">Original trigger</button>
        <button type="button">New destination</button>
      </>,
    );

    expect(destination).toHaveFocus();
  });

  it('supports keyboard confirmation and disabled resolution', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConflictDialog open requested={requested} conflicts={[conflict]} onConfirm={onConfirm} />,
    );
    const confirm = screen.getByRole('button', { name: `Replace conflict with ${requested.title}` });
    confirm.focus();
    await user.keyboard('[Enter]');
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <ConflictDialog open requested={requested} conflicts={[conflict]} onConfirm={onConfirm} resolving />,
    );
    expect(screen.getByRole('button', { name: 'Updating agenda' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep current agenda' })).toBeDisabled();
  });
});
