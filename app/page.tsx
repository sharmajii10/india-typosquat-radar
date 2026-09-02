import Link from 'next/link';
import { FeedList } from '@/app/components/FeedList';
import { FEED_PAGE_SIZE } from '@/lib/config';
import { isConfigured, publicClient } from '@/lib/db';
import { toFeedItem, type FeedRow } from '@/lib/feed';
import type { FeedItem } from '@/lib/types';

/**
 * The public feed page.
 *
 * A server component reading Supabase directly through the anon key, so Row
 * Level Security applies here exactly as it does to the JSON API. Revalidates
 * every 60 seconds, which is well inside the 10-15 minute polling cadence and
 * costs nothing on a static-ish page.
 */

export const revalidate = 60;

interface SearchParams {
  brand?: string;
  tier?: string;
  category?: string;
}

export default async function HomePage({
  searchParams
}: {
  // Next 15+ hands route props in as promises so the framework can start
  // rendering before they resolve.
  searchParams: Promise<SearchParams>;
}) {
  if (!isConfigured()) return <NotConfigured />;

  const filters = await searchParams;

  const db = publicClient();

  let query = db
    .from('public_feed')
    .select('*')
    .order('first_seen_at', { ascending: false })
    .limit(FEED_PAGE_SIZE);

  if (filters.brand) query = query.eq('brand_slug', filters.brand);
  if (filters.category) query = query.eq('brand_category', filters.category);
  if (filters.tier === 'high') query = query.eq('publish_state', 'published');
  if (filters.tier === 'medium') query = query.eq('publish_state', 'pending_review');

  const [{ data: rows, error }, { data: brands }, stats] = await Promise.all([
    query,
    db.from('brands').select('name, slug').eq('active', true).order('name'),
    loadStats()
  ]);

  if (error) {
    // Visitors get a neutral message; the detail belongs in the server log.
    console.error('[feed] query failed:', error.message);
  }

  const items: FeedItem[] = (rows ?? []).map((r) => toFeedItem(r as FeedRow));

  return (
    <>
      <h1>Recently seen lookalike domains</h1>
      <p className="page-intro">
        Every domain below appeared in a public Certificate Transparency log, resembled a
        watched Indian bank, payment service or government portal, and then passed
        independent checks on whether it is actually live and what it serves.
      </p>

      <div className="notice warn">
        <strong>Read this before acting on anything here.</strong> A domain resembling a
        brand is not proof of wrongdoing. Items marked{' '}
        <em>unconfirmed &ndash; under review</em> have not been checked by a person and may
        be entirely legitimate businesses. Nothing on this page is a legal accusation. If
        one of these domains is yours,{' '}
        <Link href="/report">say so and it will be reviewed</Link>.
      </div>

      {stats && (
        <div className="stats">
          <Stat value={stats.highConfidence} label="High confidence" />
          <Stat value={stats.underReview} label="Awaiting human review" />
          <Stat value={stats.seenLast24h} label="New in last 24 hours" />
          <Stat value={stats.brandsWatched} label="Brands watched" />
        </div>
      )}

      <div className="filters">
        <span className="filter-label">Confidence</span>
        <Chip href={buildHref(filters, { tier: undefined })} active={!filters.tier}>
          All
        </Chip>
        <Chip
          href={buildHref(filters, { tier: 'high' })}
          active={filters.tier === 'high'}
        >
          High only
        </Chip>
        <Chip
          href={buildHref(filters, { tier: 'medium' })}
          active={filters.tier === 'medium'}
        >
          Under review
        </Chip>
      </div>

      <div className="filters">
        <span className="filter-label">Brand</span>
        <Chip href={buildHref(filters, { brand: undefined })} active={!filters.brand}>
          All
        </Chip>
        {(brands ?? []).map((b) => (
          <Chip
            key={b.slug as string}
            href={buildHref(filters, { brand: b.slug as string })}
            active={filters.brand === b.slug}
          >
            {b.name as string}
          </Chip>
        ))}
      </div>

      {error ? (
        // Deliberately does not print the underlying error. A visitor cannot act
        // on a Postgres or fetch exception, and the message can carry internal
        // detail. Operators get the real thing in the server logs and in the
        // job_runs table.
        <div className="empty">
          <p style={{ margin: 0 }}>The feed is temporarily unavailable.</p>
          <p style={{ margin: '6px 0 0', fontSize: 13 }}>
            This is a problem at our end, not a sign that anything was found.
            Please try again shortly.
          </p>
        </div>
      ) : (
        <FeedList items={items} />
      )}

      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 24 }}>
        Machine-readable version at <code>/api/feed</code>. It is open, unauthenticated and
        CORS-enabled.
      </p>
    </>
  );
}

async function loadStats() {
  try {
    const db = publicClient();
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    const [high, review, day, brands] = await Promise.all([
      db.from('public_feed').select('id', { count: 'exact', head: true }).eq('publish_state', 'published'),
      db.from('public_feed').select('id', { count: 'exact', head: true }).eq('publish_state', 'pending_review'),
      db.from('public_feed').select('id', { count: 'exact', head: true }).gte('first_seen_at', dayAgo),
      db.from('brands').select('id', { count: 'exact', head: true }).eq('active', true)
    ]);
    return {
      highConfidence: high.count ?? 0,
      underReview: review.count ?? 0,
      seenLast24h: day.count ?? 0,
      brandsWatched: brands.count ?? 0
    };
  } catch {
    return null;
  }
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value.toLocaleString('en-IN')}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Chip({
  href,
  active,
  children
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link className="chip" href={href} data-active={active}>
      {children}
    </Link>
  );
}

function buildHref(current: SearchParams, patch: Partial<SearchParams>): string {
  const merged = { ...current, ...patch };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/?${qs}` : '/';
}

function NotConfigured() {
  return (
    <>
      <h1>Not configured yet</h1>
      <div className="notice">
        <p style={{ marginTop: 0 }}>
          The Supabase environment variables are missing, so there is no database to read.
        </p>
        <p style={{ marginBottom: 0 }}>
          Copy <code>.env.example</code> to <code>.env.local</code>, fill in the Supabase
          project URL and keys, run the migrations in <code>supabase/migrations/</code>,
          then <code>npm run seed</code>. Full steps are in the README.
        </p>
      </div>
    </>
  );
}
