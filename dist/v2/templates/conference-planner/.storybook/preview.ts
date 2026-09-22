import type { Preview } from '@storybook/react';
import '../src/app/globals.css';
import '../src/styles/tokens.css';

const preview: Preview = {
  parameters: {
    a11y: { manual: true, test: 'error' },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    viewport: {
      viewports: {
        conferenceMobile: { name: 'Conference mobile', styles: { width: '320px', height: '800px' } },
        conferenceDesktop: { name: 'Conference desktop', styles: { width: '1280px', height: '800px' } },
      },
    },
  },
};

export default preview;
