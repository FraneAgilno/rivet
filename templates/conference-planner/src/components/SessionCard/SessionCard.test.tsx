import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConferenceSession } from '@/domain/conference';
import { SessionCard } from './SessionCard';

afterEach(cleanup);

const session: ConferenceSession = {
  id: 'session-design-systems',
  title: 'Design systems that stay connected to delivery',
  startsAt: '2026-10-15T10:15:00.000Z',
  endsAt: '2026-10-15T11:00:00.000Z',
  track: 'design',
  speakers: ['Avery Stone', 'Rina Shah'],
  room: 'Gallery',
  capacity: 120,
};

describe('SessionCard', () => {
  it('labels the article and agenda action with the complete long title', async () => {
    const user = userEvent.setup();
    const onAgendaChange = vi.fn();
    const longTitle = 'An intentionally long conference session title that remains complete at narrow content boundaries without truncating the accessible name';
    render(<SessionCard session={{ ...session, title: longTitle }} onAgendaChange={onAgendaChange} />);

    expect(screen.getByRole('article', { name: longTitle })).toHaveAttribute('data-layout', 'responsive');
    expect(screen.getByRole('heading', { level: 3, name: longTitle })).toBeVisible();
    await user.click(screen.getByRole('button', { name: `Add ${longTitle} to agenda` }));

    expect(onAgendaChange).toHaveBeenCalledWith(session.id, true);
  });

  it('renders complete schedule, speaker, room, track, and capacity content', () => {
    render(<SessionCard session={session} />);

    expect(screen.getByText('Design')).toBeVisible();
    expect(screen.getByText('Avery Stone · Rina Shah')).toBeVisible();
    expect(screen.getByText('Gallery · 120 seats')).toBeVisible();
    expect(screen.getByText('10:15–11:00 UTC')).toBeVisible();
  });

  it('uses selected, disabled, and loading behavior from the shared button contract', () => {
    const { rerender } = render(<SessionCard session={session} selected />);
    expect(screen.getByRole('button', { name: `Remove ${session.title} from agenda`, pressed: true })).toBeEnabled();

    rerender(<SessionCard session={session} disabled />);
    expect(screen.getByRole('button', { name: `Add ${session.title} to agenda` })).toBeDisabled();

    rerender(<SessionCard session={session} loading />);
    expect(screen.getByRole('button', { name: `Saving ${session.title}` })).toHaveAttribute('aria-busy', 'true');
  });

  it.each([
    ['success', 'Added to your agenda'],
    ['error', 'Could not update your agenda'],
  ] as const)('announces a %s outcome', (tone, message) => {
    render(<SessionCard session={session} status={{ tone, message }} />);

    expect(screen.getByRole('status')).toHaveTextContent(message);
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', tone);
  });
});
