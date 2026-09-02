import { isConfigured, publicClient } from '@/lib/db';

/**
 * GET /api/stats - headline counts for the public page.
 *
 * Only counts things the anon key can already see. The number of hidden,
 * low-tier candidates is not published: it would be a fairly precise measure of
 * how noisy the matcher is, which is useful to an attacker tuning around it and
 * of no value to a visitor.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it.
// Dynamic, with CDN caching driven by the Cache-Control header below rather
// than by build-time prerendering - otherwise the first response after every
// deploy serves counts captured at build time.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  if (!isConfigured()) {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  const db = publicClient();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [published, review, last24h, last7d, brands] = await Promise.all([
    db.from('public_feed').select('id', { count: 'exact', head: true }).eq('publish_state', 'published'),
    db.from('public_feed').select('id', { count: 'exact', head: true }).eq('publish_state', 'pending_review'),
    db.from('public_feed').select('id', { count: 'exact', head: true }).gte('first_seen_at', dayAgo),
    db.from('public_feed').select('id', { count: 'exact', head: true }).gte('first_seen_at', weekAgo),
    db.from('brands').select('id', { count: 'exact', head: true }).eq('active', true)
  ]);

  return Response.json(
    {
      highConfidence: published.count ?? 0,
      underReview: review.count ?? 0,
      seenLast24h: last24h.count ?? 0,
      seenLast7d: last7d.count ?? 0,
      brandsWatched: brands.count ?? 0
    },
    {
      headers: {
        'cache-control': 'public, s-maxage=120, stale-while-revalidate=600',
        'access-control-allow-origin': '*'
      }
    }
  );
}
