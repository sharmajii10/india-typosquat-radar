import { isConfigured, publicClient } from '@/lib/db';
import { toFeedItem, type FeedRow } from '@/lib/feed';

/**
 * GET /api/candidates/:id - the full evidence record for one listed domain.
 *
 * This is the transparency endpoint. Every point that went into the score is
 * returned with its label and its weight, so a domain owner, a journalist, or a
 * bank's abuse team can see exactly what was observed and disagree with it
 * specifically rather than in general.
 *
 * RLS means a hidden or cleared candidate 404s here just as it does everywhere
 * else, so this cannot be used to enumerate the internal-only list.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it.
export const revalidate = 60;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isConfigured()) {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  const { id } = await params;
  const db = publicClient();

  const { data, error } = await db
    .from('public_feed')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return Response.json({ error: 'query_failed', message: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const item = toFeedItem(data as FeedRow);

  // Verification history, so a reader can see how the domain has behaved over
  // time rather than only its latest state. This is what distinguishes "was
  // always parked" from "went live yesterday".
  const { data: history } = await db
    .from('verifications')
    .select(
      'checked_at, resolves, http_status, has_password_field, looks_parked, domain_age_days, content_risk_score'
    )
    .eq('candidate_id', id)
    .order('checked_at', { ascending: false })
    .limit(20);

  return Response.json(
    {
      item,
      history: history ?? [],
      disclaimer:
        'This record describes what an automated scan observed. It is evidence, not a verdict. If this domain is yours and the listing is wrong, use the dispute link and it will be reviewed by a person.'
    },
    {
      headers: {
        'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
        'access-control-allow-origin': '*'
      }
    }
  );
}
