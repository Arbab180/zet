import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Digital ZET',
  description: 'Closing cash sheet — C.A. China Spice Restaurants LTD',
};

// initial-scale=1, no maximum-scale/user-scalable=no: a manager on a phone
// must be able to pinch-zoom the sheet, same as they would a paper one.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="el">
      <body>{children}</body>
    </html>
  );
}
