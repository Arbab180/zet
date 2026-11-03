import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getLang } from '../server/lang';
import { LangProvider } from '../components/LangProvider';
import LangSwitch from '../components/LangSwitch';
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

/**
 * The language is read here, once per request, and handed down: to
 * <html lang> (screen readers and the phone's spell-check follow it) and
 * to LangProvider, which is where every Client Component gets it from.
 * See src/lib/i18n/index.ts for how the translation itself works.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang}>
      <body>
        <LangProvider lang={lang}>
          <LangSwitch />
          {children}
        </LangProvider>
      </body>
    </html>
  );
}
