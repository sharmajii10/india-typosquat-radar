import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isConfigured, publicClient } from '@/lib/db';
import { relativeTime, toFeedItem, type FeedRow } from '@/lib/feed';

/**
 * The full evidence record for one listing.
 *
 * This page exists so that being listed is contestable in specifics. Someone who
 * disagrees can see every signal, its weight, and the history of checks, and
 * then dispute the particular observation that is wrong rather than the
 * conclusion in the abstract.
 */

export const revalidate = 60;

export default async function CandidatePage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isConfigured()) notFound();

  const { id } = await params;
  const db = publicClient();

  const { data } = await db
    .from('public_feed')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!data) notFound();

  const item = toFeedItem(data as FeedRow);

  const { data: history } = await db
    .from('verifications')
    .select(
      'checked_at, resolves, http_status, has_password_field, looks_parked, domain_age_days, page_title'
    )
    .eq('candidate_id', id)
    .order('checked_at', { ascending: false })
    .limit(20);

  const isHigh = item.tier === 'high' && item.confirmed;

  return (
    <>
      <p style={{ marginTop: 24, fontSize: 13 }}>
        <Link href="/">&larr; Back to the feed</Link>
      </p>

      <h1 style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>{item.domain}</h1>

      <p className="page-intro">
        <span className={`badge ${isHigh ? 'badge-high' : 'badge-medium'}`}>
          {item.statusLabel}
        </span>{' '}
        Resembles <strong>{item.brand.name}</strong>. Score {item.score} out of 100. First
        seen in a certificate log {relativeTime(item.firstSeenAt)}.
      </p>

      {!isHigh && (
        <div className="notice warn">
          <strong>This listing is unconfirmed.</strong> It scored highly enough to warrant a
          look but not highly enough to be published as a detection, and no person has
          reviewed it yet. It may be a completely legitimate website.
        </div>
      )}

      {item.unicodeDomain && item.unicodeDomain !== item.domain && (
        <div className="notice warn">
          <strong>This domain uses non-Latin characters.</strong> It is stored as{' '}
          <code>{item.domain}</code> but a browser displays it as{' '}
          <code>{item.unicodeDomain}</code>. That gap is how homograph attacks work.
        </div>
      )}

      <h2 style={{ fontSize: 17, marginTop: 30 }}>What was observed</h2>
      <ul className="signal-list">
        {item.signals.map((signal, i) => (
          <li className="signal" key={`${signal.key}-${i}`}>
            <span
              className="signal-points"
              data-sign={signal.points > 0 ? 'pos' : signal.points < 0 ? 'neg' : 'zero'}
            >
              {signal.points > 0 ? `+${signal.points}` : signal.points || '—'}
            </span>
            <span>
              {signal.label}
              {signal.detail && <span className="signal-detail"> — {signal.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
        Positive numbers raised the score, negative numbers lowered it. The weights and the
        reasoning behind each one are in <code>lib/scoring/weights.ts</code> in the public
        source.
      </p>

      <h2 style={{ fontSize: 17, marginTop: 30 }}>Facts on record</h2>
      <table style={{ borderCollapse: 'collapse', fontSize: 13.5, width: '100%', maxWidth: 620 }}>
        <tbody>
          <Row label="Domain" value={item.domain} mono />
          <Row label="Resembles" value={item.brand.name} />
          {item.brand.officialDomain && (
            <Row
              label="That brand's real domain"
              mono
              value={
                // Safe to link, unlike the row above it. Putting the two
                // addresses one line apart is the whole point of this row:
                // the reader compares them directly instead of taking our
                // word for the resemblance.
                <a
                  className="official-link"
                  href={`https://${item.brand.officialDomain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.brand.officialDomain}
                </a>
              }
            />
          )}
          <Row label="Certificate issuer" value={item.certIssuer ?? 'unknown'} />
          <Row
            label="Certificate issued"
            value={item.certIssuedAt ? new Date(item.certIssuedAt).toUTCString() : 'unknown'}
          />
          <Row label="Registrar" value={item.registrar ?? 'not available'} />
          <Row
            label="Domain age"
            value={
              item.domainAgeDays === null
                ? 'not available'
                : `${item.domainAgeDays} day${item.domainAgeDays === 1 ? '' : 's'}`
            }
          />
          <Row
            label="Currently resolving"
            value={item.resolves === null ? 'unknown' : item.resolves ? 'yes' : 'no'}
          />
          <Row
            label="Serves a password field"
            value={
              item.hasPasswordField === null
                ? 'unknown'
                : item.hasPasswordField
                  ? 'yes'
                  : 'no'
            }
          />
          <Row label="Last checked" value={relativeTime(item.lastCheckedAt)} />
        </tbody>
      </table>

      {history && history.length > 1 && (
        <>
          <h2 style={{ fontSize: 17, marginTop: 30 }}>Check history</h2>
          <p style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 0 }}>
            Every candidate is re-checked on a schedule rather than judged once. A domain
            that was dormant and then went live shows up here.
          </p>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-faint)' }}>
                <th style={cell}>Checked</th>
                <th style={cell}>Resolves</th>
                <th style={cell}>HTTP</th>
                <th style={cell}>Password field</th>
                <th style={cell}>Parked</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td style={cell}>{relativeTime(h.checked_at as string)}</td>
                  <td style={cell}>{h.resolves ? 'yes' : 'no'}</td>
                  <td style={cell}>{(h.http_status as number | null) ?? '—'}</td>
                  <td style={cell}>{h.has_password_field ? 'yes' : 'no'}</td>
                  <td style={cell}>{h.looks_parked ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="notice" style={{ marginTop: 30 }}>
        <strong>Is this domain yours?</strong>{' '}
        <Link href={`/report?domain=${encodeURIComponent(item.domain)}&id=${item.id}`}>
          Tell us and a person will review it
        </Link>
        . If it is listed in error it will be removed and permanently allowlisted, so it
        cannot reappear.
      </div>
    </>
  );
}

const cell: React.CSSProperties = {
  padding: '6px 12px 6px 0',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top'
};

function Row({
  label,
  value,
  mono
}: {
  label: string;
  // ReactNode rather than string so one row can carry the official-domain link.
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <tr>
      <td style={{ ...cell, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</td>
      <td
        style={{
          ...cell,
          fontFamily: mono ? 'var(--mono)' : undefined,
          wordBreak: 'break-all'
        }}
      >
        {value}
      </td>
    </tr>
  );
}
