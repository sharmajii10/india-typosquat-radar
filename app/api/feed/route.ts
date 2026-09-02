import { FEED_MAX_PAGE_SIZE, FEED_PAGE_SIZE } from '@/lib/config';
import { isConfigured, publicClient } from '@/lib/db';
import { toFeedItem, type FeedRow } from '@/lib/feed';

/**
 * GET /api/feed - the public feed. No key, no login, no rate limit gate.
 *
 * Reads through the anon Supabase key, which means Row Level Security applies:
 * even if this handler had a bug, the database will not hand it a hidden or
 * cleared candidate. The gating is enforced in three places on purpose - the
 * scorer sets publish_state, the `public_feed` view filters on it, and RLS
 * filters again on the underlying table.
 *
 * Query parameters:
 *   brand=<slug>       filter to one brand
 *   tier=high|medium   filter by confidence (default: both)
 *   category=<cat>     bank | payment | government | other
 *   limit, offset      pagination
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it.
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!isConfigured()) {
    return Response.json(
      {
        error: 'not_configured',
        message:
          'Supabase environment variables are not set. See .env.example and the README.'
      },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const brand = url.searchParams.get('brand');
  const tier = url.searchParams.get('tier');
  const category = url.searchParams.get('category');
  const limit = clamp(
    Number(url.searchParams.get('limit') ?? FEED_PAGE_SIZE),
    1,
    FEED_MAX_PAGE_SIZE
  );
  const offset = clamp(Number(url.searchParams.get('offset') ?? 0), 0, 10_000);

  const db = publicClient();
  let query = db
    .from('public_feed')
    .select('*', { count: 'exact' })
    .order('first_seen_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (brand) query = query.eq('brand_slug', brand);
  if (category) query = query.eq('brand_category', category);
  if (tier === 'high') query = query.eq('publish_state', 'published');
  if (tier === 'medium') query = query.eq('publish_state', 'pending_review');

  const { data, error, count } = await query;

  if (error) {
    return Response.json({ error: 'query_failed', message: error.message }, { status: 500 });
  }

  const items = (data ?? []).map((row) => toFeedItem(row as FeedRow));

  return Response.json(
    {
      items,
      total: count ?? items.length,
      limit,
      offset,
      // Stated in the payload so anyone consuming the API programmatically sees
      // the caveat too, not just visitors to the web page.
      disclaimer:
        'Items marked "unconfirmed" have not been verified by a human. A domain resembling a brand is not proof of wrongdoing. If a domain listed here is yours, use the dispute link to have it reviewed.'
    },
    {
      headers: {
        'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
        'access-control-allow-origin': '*'
      }
    }
  );
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
