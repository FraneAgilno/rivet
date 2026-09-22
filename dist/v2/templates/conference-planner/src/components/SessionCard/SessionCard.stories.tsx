import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from '@storybook/test';

import type { ConferenceSession } from '@/domain/conference';
import { SessionCard } from './SessionCard';

const session: ConferenceSession = {
  id: 'session-runtime-guardrails',
  title: 'Runtime guardrails that fail closed',
  startsAt: '2026-10-15T10:15:00.000Z',
  endsAt: '2026-10-15T11:00:00.000Z',
  track: 'engineering',
  speakers: ['Noah Reed', 'Leila Marin'],
  room: 'Studio 2',
  capacity: 180,
};

const meta = {
  title: 'Components/SessionCard',
  component: SessionCard,
  args: { session },
  parameters: { a11y: { test: 'error' } },
} satisfies Meta<typeof SessionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
export const Disabled: Story = { args: { disabled: true } };
export const Loading: Story = { args: { loading: true } };
export const Success: Story = { args: { status: { tone: 'success', message: 'Added to your agenda' } } };
export const Error: Story = { args: { status: { tone: 'error', message: 'Could not update your agenda' } } };

export const Hover: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button');
    await userEvent.hover(button);
    await expect(button).toBeVisible();
  },
};

export const Focus: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button');
    button.focus();
    await expect(button).toHaveFocus();
  },
};

export const ContentBoundary: Story = {
  args: {
    session: {
      ...session,
      title: 'An intentionally long conference session title that remains complete and readable at narrow content boundaries',
    },
  },
  parameters: { viewport: { defaultViewport: 'conferenceMobile' } },
};

export const Desktop: Story = {
  parameters: { viewport: { defaultViewport: 'conferenceDesktop' } },
};
