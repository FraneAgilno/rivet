import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { conferenceSessions } from '@/domain/sessions';

import { ConferencePlanner } from './ConferencePlanner';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ConferencePlanner', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the program while loading and then announces an empty agenda', async () => {
    let resolveAgenda: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { resolveAgenda = resolve; }));

    render(<ConferencePlanner sessions={conferenceSessions} />);

    expect(screen.getAllByRole('article')).toHaveLength(conferenceSessions.length);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your agenda');
    expect(screen.getAllByRole('button', { name: /agenda/i })[0]).toBeDisabled();

    resolveAgenda?.(jsonResponse({ sessionIds: [] }));
    expect(await screen.findByText('No sessions saved yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /agenda/i })[0]).toBeEnabled();
  });

  it('adds and removes a session with loading and saved feedback', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionIds: [] }))
      .mockResolvedValueOnce(jsonResponse({ sessionIds: ['session-runtime-guardrails'] }))
      .mockResolvedValueOnce(jsonResponse({ sessionIds: [] }));
    const user = userEvent.setup();

    render(<ConferencePlanner sessions={conferenceSessions} />);
    const add = await screen.findByRole('button', {
      name: 'Add Runtime guardrails that fail closed to agenda',
    });
    await user.click(add);

    expect(await screen.findByRole('button', {
      name: 'Remove Runtime guardrails that fail closed from agenda',
    })).toBeInTheDocument();
    expect(screen.getByText('Saved to your agenda.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/agenda', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'add', sessionId: 'session-runtime-guardrails' }),
    }));

    await user.click(screen.getByRole('button', {
      name: 'Remove Runtime guardrails that fail closed from agenda',
    }));
    expect(await screen.findByRole('button', {
      name: 'Add Runtime guardrails that fail closed to agenda',
    })).toBeInTheDocument();
    expect(screen.getByText('Removed from your agenda.')).toBeInTheDocument();
  });

  it('shows an actionable conflict and restores focus after keyboard dismissal', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionIds: ['session-opening-keynote'] }))
      .mockResolvedValueOnce(jsonResponse({
        error: 'schedule-conflict',
        conflictingSessionIds: ['session-opening-keynote'],
      }, 409));
    const user = userEvent.setup();

    render(<ConferencePlanner sessions={conferenceSessions} />);
    const trigger = await screen.findByRole('button', {
      name: 'Add Design a resilient personal agenda to agenda',
    });
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Schedule conflict' });
    expect(within(dialog).getByText('Designing dependable agentic products')).toBeInTheDocument();
    const activeElement = document.activeElement;
    expect(activeElement).toBeInstanceOf(HTMLElement);
    expect(dialog).toContainElement(activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('replaces conflicting sessions only after explicit dialog confirmation', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionIds: ['session-opening-keynote'] }))
      .mockResolvedValueOnce(jsonResponse({
        error: 'schedule-conflict',
        conflictingSessionIds: ['session-opening-keynote'],
      }, 409))
      .mockResolvedValueOnce(jsonResponse({ sessionIds: [] }))
      .mockResolvedValueOnce(jsonResponse({ sessionIds: ['session-agenda-workshop'] }));
    const user = userEvent.setup();

    render(<ConferencePlanner sessions={conferenceSessions} />);
    await user.click(await screen.findByRole('button', {
      name: 'Add Design a resilient personal agenda to agenda',
    }));
    await user.click(await screen.findByRole('button', {
      name: 'Replace conflict with Design a resilient personal agenda',
    }));

    expect(await screen.findByRole('button', {
      name: 'Remove Design a resilient personal agenda from agenda',
    })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/agenda', expect.objectContaining({
      body: JSON.stringify({ action: 'remove', sessionId: 'session-opening-keynote' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/agenda', expect.objectContaining({
      body: JSON.stringify({ action: 'add', sessionId: 'session-agenda-workshop' }),
    }));
  });

  it('fails closed and keeps agenda actions disabled when the API is unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('private-api-canary'));

    render(<ConferencePlanner sessions={conferenceSessions} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Agenda unavailable. Refresh to try again.');
    expect(screen.queryByText(/private-api-canary/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /agenda/i })[0]).toBeDisabled();
  });
});
