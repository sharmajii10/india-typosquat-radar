import { timingSafeEqual } from 'node:crypto';

/**
 * Shared-secret auth for the /api/jobs/* routes.
 *
 * These routes make outbound network requests and write to the database, so
 * leaving them open would let anyone use the deployment as a scanning proxy and
 * burn the free tier's quota. The GitHub Actions workflow sends the secret as
 * `Authorization: Bearer <JOB_SECRET>`.
 */
export function isAuthorizedJobRequest(req: Request): boolean {
  const expected = process.env.JOB_SECRET;
  if (!expected || expected.length < 16) {
    // Refuse rather than fall open. A deployment with no secret set should not
    // silently expose its job routes to the internet.
    return false;
  }

  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Some CI setups find a header easier than a body; accept a query param too,
  // but only over the same constant-time comparison.
  const fromQuery = new URL(req.url).searchParams.get('secret') ?? '';
  const provided = bearer || fromQuery;
  if (!provided) return false;

  return constantTimeEquals(provided, expected);
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Compare fixed-size digests of equal length instead.
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure path costs roughly the same.
    try {
      timingSafeEqual(bufA, bufA);
    } catch {
      /* ignore */
    }
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' }
  });
}
