import type { Meta, StoryObj } from '@storybook/react';

import type { ConferenceSession } from '@/domain/conference';
import { ConflictDialog } from './ConflictDialog';

const requested: ConferenceSession = {
  id: 'session-runtime-guardrails',
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
  id: 'session-evidence-led-design',
  title: 'Evidence-led design reviews',
  track: 'design',
  speakers: ['Sofia Adeyemi'],
  room: 'Gallery',
};

const meta = {
  title: 'Components/ConflictDialog',
  component: ConflictDialog,
  args: { conflicts: [conflict], open: true, requested },
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
} satisfies Meta<typeof ConflictDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Resolving: Story = { args: { resolving: true } };
export const ContentBoundary: Story = {
  args: {
    conflicts: [{
      ...conflict,
      title: 'A deliberately long conflicting session title that remains readable without truncation at the smallest supported viewport',
    }],
  },
  parameters: { viewport: { defaultViewport: 'conferenceMobile' } },
};
export const Desktop: Story = {
  parameters: { viewport: { defaultViewport: 'conferenceDesktop' } },
};
