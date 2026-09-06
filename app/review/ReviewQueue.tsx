'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { relativeTime } from '@/lib/feed';
import type { FeedItem } from '@/lib/types';

/**
 * The reviewer's working surface.
 *
 * Design intent: make the correct decision the easy one. Everything needed to
 * judge an item is on screen without a click - the evidence that produced the
 * score, the facts behind it, and any dispute someone has filed about it. The
 * reviewer should never have to open another tab to decide, because a review
 * step that is slow is a review step that silently stops happening.
 *
 * Clearing is given the most prominence of the three actions. The asymmetry is
 * deliberate: publishing a wrong accusation harms a real business, while
 * failing to publish a real phishing site costs a detection that this project
 * was never going to be alone in making.
 */

interface ReportRow {
  id: string;
  candidate_id: string | null;
  domain: string | null;
  kind: string;
  note: string;
  contact: string | null;
  created_at: string;
}

type Decision = 'publish' | 'clear' | 'hide';

export function ReviewQueue({
  items,
  reports,
  orphanReports
}: {
  items: FeedItem[];
  reports: Record<string, ReportRow[]>;
  orphanReports: ReportRow[];
}) {
  const router = useRouter();
  // Keyed by id, but carrying the domain too. Looking the domain up from
  // `items` after the fact does not work: router.refresh() re-renders from the
  // server, where the decided candidate is no longer in the pending queue, so
  // the lookup fails and the reviewer sees a bare UUID.
  const [done, setDone] = useState<Record<string, { domain: string; message: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remaining = useMemo(
    () => items.filter((i) => !done[i.id]),
    [items, done]
  );

  // A disputed item is the most urgent thing in the queue: someone is actively
  // saying this listing is wrong about them.
  const disputed = remaining.filter((i) => (reports[i.id]?.length ?? 0) > 0);
  const undisputed = remaining.filter((i) => (reports[i.id]?.length ?? 0) === 0);

  async function decide(id: string, domain: string, action: Decision, note: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch('/api/review/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, action, note })
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body.error ?? 'Could not save that decision.');
        return;
      }

      setDone((d) => ({
        ...d,
        [id]: {
          domain,
          message:
            action === 'publish'
              ? 'Published to the public feed.'
              : action === 'clear'
                ? `Cleared and permanently allowlisted${
                    body.resolvedReports
                      ? `, ${body.resolvedReports} dispute${body.resolvedReports === 1 ? '' : 's'} resolved`
                      : ''
                  }.`
                : 'Hidden. Still tracked internally and re-checked.'
        }
      }));
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyId(null);
    }
  }

  async function signOut() {
    await fetch('/api/review/session', { method: 'DELETE' });
    router.refresh();
  }

  return (
    <>
      <div className="review-head">
        <div>
          <h1>Review queue</h1>
          <p className="page-intro">
            {remaining.length === 0
              ? 'Nothing is waiting. Every unconfirmed candidate has been decided.'
              : `${remaining.length} candidate${remaining.length === 1 ? '' : 's'} waiting on a decision.`}
          </p>
        </div>
        <button type="button" className="ghost" onClick={signOut}>
          Sign out
        </button>
      </div>

      <div className="notice">
        <strong>What these three buttons mean.</strong> <em>Publish</em> puts the
        domain on the public feed as a high-confidence detection.{' '}
        <em>Not a threat</em> permanently allowlists it, so no future scan can
        flag it again, and resolves any dispute about it. <em>Keep hidden</em>{' '}
        leaves it off the feed but still tracked and re-checked, which is right
        for something suspicious that is not yet live.
      </div>

      {error && (
        <div className="form-status" data-kind="error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {disputed.length > 0 && (
        <>
          <h2 className="review-section">
            Disputed &mdash; someone says these listings are wrong
          </h2>
          {disputed.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              reports={reports[item.id] ?? []}
              busy={busyId === item.id}
              onDecide={decide}
            />
          ))}
        </>
      )}

      {undisputed.length > 0 && (
        <>
          {disputed.length > 0 && <h2 className="review-section">Everything else</h2>}
          {undisputed.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              reports={[]}
              busy={busyId === item.id}
              onDecide={decide}
            />
          ))}
        </>
      )}

      {Object.keys(done).length > 0 && (
        <>
          <h2 className="review-section">Decided just now</h2>
          <ul className="feed">
            {Object.entries(done).map(([id, { domain, message }]) => (
              <li className="item" key={id}>
                <span className="item-domain">{domain}</span>
                <div className="item-meta">
                  <span>{message}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {orphanReports.length > 0 && (
        <>
          <h2 className="review-section">
            Reports not tied to a listed domain
          </h2>
          <p style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 0 }}>
            Usually someone reporting a phishing domain the radar has not seen.
            There is no button for these; add the domain to the watchlist or
            allowlist by hand if it warrants it.
          </p>
          <ul className="feed">
            {orphanReports.map((r) => (
              <li className="item" key={r.id}>
                <span className="item-domain">{r.domain ?? '(no domain given)'}</span>
                <div className="item-meta">
                  <span>{r.kind}</span>
                  <span>{relativeTime(r.created_at)}</span>
                  {r.contact && <span>contact: {r.contact}</span>}
                </div>
                <p style={{ fontSize: 13.5, marginBottom: 0 }}>{r.note}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function ReviewCard({
  item,
  reports,
  busy,
  onDecide
}: {
  item: FeedItem;
  reports: ReportRow[];
  busy: boolean;
  onDecide: (id: string, domain: string, action: Decision, note: string) => void;
}) {
  const [note, setNote] = useState('');
  const positives = item.signals.filter((s) => s.points > 0);
  const mitigating = item.signals.filter((s) => s.points < 0);
  const gateNote = item.signals.find((s) => s.key === 'gate.note');

  return (
    <div className="item review-card" data-tier={item.tier}>
      <div className="item-top">
        <div>
          {/* Never a link. Linking a suspected credential-harvesting page from
              the tool that flagged it would be an own goal. */}
          <span className="item-domain">{item.domain}</span>
          {item.unicodeDomain && item.unicodeDomain !== item.domain && (
            <span className="item-unicode">displays as {item.unicodeDomain}</span>
          )}
        </div>
        <span className="badge badge-medium">Score {item.score}/100</span>
      </div>

      <div className="item-meta">
        <span>
          Resembles <b>{item.brand.name}</b>
        </span>
        <span>First seen {relativeTime(item.firstSeenAt)}</span>
        <span>Checked {relativeTime(item.lastCheckedAt)}</span>
        {item.domainAgeDays !== null && (
          <span>
            Registered <b>{item.domainAgeDays}d</b> ago
          </span>
        )}
        <span>{item.resolves ? 'Resolves' : 'Does not resolve'}</span>
        {item.hasPasswordField && <b>Serves a password field</b>}
        {item.registrar && <span>via {item.registrar}</span>}
      </div>

      {reports.length > 0 && (
        <div className="notice warn" style={{ margin: '12px 0' }}>
          <strong>
            {reports.length} dispute{reports.length === 1 ? '' : 's'} filed about this
            domain.
          </strong>
          {reports.map((r) => (
            <p key={r.id} style={{ margin: '8px 0 0', fontSize: 13.5 }}>
              &ldquo;{r.note}&rdquo;
              <span className="signal-detail">
                {' '}
                &mdash; {relativeTime(r.created_at)}
                {r.contact ? `, contact: ${r.contact}` : ', no contact given'}
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="review-evidence">
        <div>
          <h4>Why it scored</h4>
          <ul className="signal-list">
            {positives.map((s, i) => (
              <li className="signal" key={`${s.key}-${i}`}>
                <span className="signal-points" data-sign="pos">
                  +{s.points}
                </span>
                <span>
                  {s.label}
                  {s.detail && <span className="signal-detail"> — {s.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Arguing against</h4>
          {mitigating.length === 0 ? (
            <p className="signal-detail" style={{ margin: 0 }}>
              Nothing counted in this domain&rsquo;s favour.
            </p>
          ) : (
            <ul className="signal-list">
              {mitigating.map((s, i) => (
                <li className="signal" key={`${s.key}-${i}`}>
                  <span className="signal-points" data-sign="neg">
                    {s.points}
                  </span>
                  <span>{s.label}</span>
                </li>
              ))}
            </ul>
          )}
          {gateNote && (
            <p className="signal-detail" style={{ marginTop: 10 }}>
              {gateNote.label}
            </p>
          )}
        </div>
      </div>

      <div className="review-actions">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason (required to clear, recorded either way)"
          aria-label={`Reason for the decision on ${item.domain}`}
        />
        <div className="review-buttons">
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => onDecide(item.id, item.domain, 'publish', note)}
          >
            Publish
          </button>
          <button
            type="button"
            className="safe"
            disabled={busy || note.trim().length < 3}
            title={
              note.trim().length < 3
                ? 'Give a short reason first - this permanently allowlists the domain'
                : undefined
            }
            onClick={() => onDecide(item.id, item.domain, 'clear', note)}
          >
            Not a threat
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => onDecide(item.id, item.domain, 'hide', note)}
          >
            Keep hidden
          </button>
        </div>
      </div>
    </div>
  );
}
