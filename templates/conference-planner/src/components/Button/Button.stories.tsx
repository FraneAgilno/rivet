import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from '@storybook/test';

import { Button } from './Button';

const meta = {
  title: 'Components/Button',
  component: Button,
  args: { children: 'Add to agenda' },
  parameters: { a11y: { test: 'error' } },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hover: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Add to agenda' });
    await userEvent.hover(button);
    await expect(button).toBeVisible();
  },
};

function FocusExample() {
  const [activated, setActivated] = useState(false);
  return (
    <Button data-activated={activated} onClick={() => setActivated(true)}>
      Add to agenda
    </Button>
  );
}

export const Focus: Story = {
  render: () => <FocusExample />,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Add to agenda' });
    button.focus();
    await expect(button).toHaveFocus();
  },
};

export const Pressed: Story = { args: { children: 'In my agenda', pressed: true } };
export const Disabled: Story = { args: { children: 'Unavailable', disabled: true } };
export const Loading: Story = { args: { loading: true, loadingLabel: 'Saving session' } };
