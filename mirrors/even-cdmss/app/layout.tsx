import './globals.css';
import { headers } from 'next/headers';
import { Inter, Source_Serif_4 } from 'next/font/google';
import { Shell } from '@/components/Shell';

// Clarity type system: Inter for UI/body, Source Serif 4 for display headings.
// next/font self-hosts at build time (no runtime fetch, no npm dep).
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});
const serif = Source_Serif_4({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600'],
  variable: '--font-serif',
});

export const metadata = {
  title: { default: 'CAT — Clinical Analysis Tool', template: '%s · CAT' },
  description: 'Clinical Analysis Tool (CAT) — evidence-grounded clinical decision support',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // medaudit.evenos.app (tagged by middleware) renders chrome-free — no CAT shell.
  const chromeFree = (await headers()).get('x-surface') === 'medaudit';
  const concordanceEnabled = process.env.CONCORDANCE_ENABLED === '1';
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable}`}>
      <body>{chromeFree ? children : <Shell concordanceEnabled={concordanceEnabled}>{children}</Shell>}</body>
    </html>
  );
}
