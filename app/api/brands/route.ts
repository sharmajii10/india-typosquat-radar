import { isConfigured, publicClient } from '@/lib/db';

/**
 * GET /api/brands - the watchlist, published openly.
 *
 * Transparency about what is being watched is part of the point. It also lets
 * anyone check whether their own brand is covered, and see the official domains
 * we treat as authoritative - which is how errors in the seed data get found.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it.
export const revalidate = 300;

export async function GET(): Promise<Response> {
  if (!isConfigured()) {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  const db = publicClient();
  const { data, error } = await db
    .from('brands')
    .select('name, slug, category, official_domains, aliases, active')
    .eq('active', true)
    .order('category')
    .order('name');

  if (error) {
    return Response.json({ error: 'query_failed', message: error.message }, { status: 500 });
  }

  return Response.json(
    { brands: data ?? [] },
    {
      headers: {
        'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
        'access-control-allow-origin': '*'
      }
    }
  );
}
