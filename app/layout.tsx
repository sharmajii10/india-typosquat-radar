import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'India Typosquat Radar',
  description:
    'A free, public radar for newly-issued TLS certificates on domains that impersonate Indian banks, payment apps and government portals.',
  robots: { index: true, follow: true }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="wrap site-header-inner">
            <div>
              <h1 className="site-title">
                <Link href="/">India Typosquat Radar</Link>
              </h1>
              <p className="site-tagline">
                Watching Certificate Transparency logs for domains impersonating Indian
                banks, payment apps and government services.
              </p>
            </div>
            <nav className="site-nav">
              <Link href="/">Feed</Link>
              <Link href="/about">How it works</Link>
              <Link href="/report">Dispute a listing</Link>
            </nav>
          </div>
        </header>

        <main className="wrap">{children}</main>

        <footer className="site-footer">
          <div className="wrap">
            <p>
              A non-commercial public-interest project. No accounts, no tracking, no ads,
              nothing for sale. Data comes from public Certificate Transparency logs
              (crt.sh), public DNS, and RDAP.
            </p>
            <p>
              Listings describe what an automated scan observed. They are evidence, not a
              verdict, and never a statement about anyone&rsquo;s intent. If a domain here
              is yours,{' '}
              <Link href="/report">tell us and a person will review it</Link>.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
