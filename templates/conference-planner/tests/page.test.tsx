import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConferencePage from '../src/app/page';

describe('conference page', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the seeded program with accessible headings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ sessionIds: [] }),
      { headers: { 'content-type': 'application/json' } },
    )));
    render(<ConferencePage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Build your conference day' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(await screen.findByText('No sessions saved yet.')).toBeInTheDocument();
  });
});
