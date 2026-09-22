import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

afterEach(cleanup);

describe('Button', () => {
  it.each(['Enter', ' '])('activates from the keyboard with %j', async key => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add to agenda</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Add to agenda' })).toHaveFocus();
    await user.keyboard(key === ' ' ? '[Space]' : `[${key}]`);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('exposes pressed state without changing its accessible name', () => {
    render(<Button pressed>In my agenda</Button>);

    expect(screen.getByRole('button', { name: 'In my agenda', pressed: true })).toBeEnabled();
  });

  it('does not activate while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Unavailable</Button>);

    await user.click(screen.getByRole('button', { name: 'Unavailable' }));

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
  });

  it('is busy, disabled, and explicitly named while loading', () => {
    render(<Button loading loadingLabel="Saving session">Add to agenda</Button>);

    const button = screen.getByRole('button', { name: 'Saving session' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});
