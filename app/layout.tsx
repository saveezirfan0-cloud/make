import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Blueprint Runner',
  description:
    'Self-hosted Make.com-style automation runner: paste a blueprint, set tokens as variables, run it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
