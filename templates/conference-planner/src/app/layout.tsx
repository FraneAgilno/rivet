import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import '../styles/tokens.css';

export const metadata: Metadata = {
  title: 'Agilno Conference Planner',
  description: 'A deterministic conference planning demo.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
