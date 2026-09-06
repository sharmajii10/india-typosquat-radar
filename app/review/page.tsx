import { cookies } from 'next/headers';
import { ReviewLogin } from '@/app/review/ReviewLogin';
import { ReviewQueue } from '@/app/review/ReviewQueue';
import { hasServiceKey, isConfigured, serviceClient } from '@/lib/db';
import { toFeedItem, type FeedRow } from '@/lib/feed';
import { loadOpenReports, loadReviewQueue } from '@/lib/pipeline/review';
import {
  REVIEW_COOKIE_NAME,
  reviewAuthConfigured,
  usingJobSecretFallback,
  verifySessionToken
} from '@/lib/review-auth';

/**
 * The human review queue.
 *
 * Medium-tier candidates never auto-publish; they wait here for a person. Until
 * now that queue was a JSON endpoint driven by curl, which technically worked
 * and practically meant nobody would ever work through it. A review step that
 * is too tedious to use is the same as not having one, and this project's
 * safety argument depends on it actually happening.
 *
 * Reads through the SERVICE key, deliberately. The queue must show what the
 * public cannot see - that is the entire point - so Row Level Security would be
 * working against it here. The page is gated on a session cookie instead, and
 * is noindex so it never turns up in a search result.
 */

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Review queue',
  robots: { index: false, follow: false }
};

export default async function ReviewPage() {
  if (!isConfigured() || !hasServiceKey()) {
    return (
      <>
        <h1>Review queue</h1>
        <div className="notice warn">
          This deployment is not fully configured. The review queue needs the
          Supabase secret key, because it shows candidates the public cannot see.
          Check <code>/api/health</code>.
        </div>
      </>
    );
  }

  if (!reviewAuthConfigured()) {
    return (
      <>
        <h1>Review queue</h1>
        <div className="notice warn">
          <strong>Locked, because no password is set.</strong> Set{' '}
          <code>REVIEW_PASSWORD</code> to a string of at least 16 characters and
          redeploy. Until then this page refuses every login rather than falling
          open, since it can publish accusations and permanently allowlist
          domains.
        </div>
      </>
    );
  }

  const jar = await cookies();
  const signedIn = verifySessionToken(jar.get(REVIEW_COOKIE_NAME)?.value);

  if (!signedIn) {
    return <ReviewLogin usingJobSecret={usingJobSecretFallback()} />;
  }

  const db = serviceClient();
  const [rows, reports] = await Promise.all([loadReviewQueue(db), loadOpenReports(db)]);

  const items = rows.map((r) => toFeedItem(r as FeedRow));

  // A dispute about a domain is the most important thing to know before
  // deciding on it, so attach reports to their candidate rather than leaving
  // them in a separate list the reviewer has to cross-reference by hand.
  const reportsByCandidate = new Map<string, typeof reports>();
  const orphanReports: typeof reports = [];
  for (const report of reports) {
    const key = report.candidate_id as string | null;
    if (key) {
      const existing = reportsByCandidate.get(key) ?? [];
      existing.push(report);
      reportsByCandidate.set(key, existing);
    } else {
      orphanReports.push(report);
    }
  }

  return (
    <ReviewQueue
      items={items}
      reports={Object.fromEntries(reportsByCandidate)}
      orphanReports={orphanReports}
    />
  );
}
