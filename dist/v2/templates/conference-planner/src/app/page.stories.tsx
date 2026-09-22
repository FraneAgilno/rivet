import type { Meta, StoryObj } from '@storybook/react';

import ConferencePage from './page';

const meta = {
  title: 'Pages/Conference',
  component: ConferencePage,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ConferencePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
