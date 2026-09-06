import Link from 'next/link';
import { relativeTime } from '@/lib/feed';
import type { FeedItem } from '@/lib/types';

/**
 * The feed list.
 *
 * Every item shows its evidence inline, collapsed. That is a deliberate design
 * choice rather than a nice extra: a public list of accused domains that does
 * not show its reasoning is asking to be trusted, and this project's whole
 * argument is that name similarity does not deserve to be trusted.
 */
export function FeedList({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0 }}>Nothing matching those filters right now.</p>
        <p style={{ margin: '6px 0 0', fontSize: 13 }}>
          An empty feed is a good sign, not a broken one.
        </p>
      </div>
    );
  }

  return (
    <ul className="feed">
      {items.map((item) => (
        <FeedRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const isHigh = item.tier === 'high' && item.confirmed;

  return (
    <li className="item" data-tier={item.tier}>
      <div className="item-top">
        <div>
          {/* Never a live link. Linking a suspected credential-harvesting page
              from a warning page would be an own goal - the domain is shown as
              plain text so a reader can recognise it, not visit it. */}
          <span className="item-domain">{item.domain}</span>
          {item.unicodeDomain && item.unicodeDomain !== item.domain && (
            <span className="item-unicode" title="How this domain renders in a browser">
              displays as {item.unicodeDomain}
            </span>
          )}
        </div>
        <span className={`badge ${isHigh ? 'badge-high' : 'badge-medium'}`}>
          {item.statusLabel}
        </span>
      </div>

      <div className="item-meta">
        <span>
          Resembles <b>{item.brand.name}</b>
          {item.brand.officialDomain && (
            <>
              {', whose real site is '}
              {/* The one domain on this page that IS safe to link, and the
                  contrast is the point: the suspected domain above is inert
                  text, the genuine one is reachable. Anyone who cannot tell the
                  two apart by eye is precisely who a typosquat works on. */}
              <a
                className="official-link"
                href={`https://${item.brand.officialDomain}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.brand.officialDomain}
              </a>
            </>
          )}
        </span>
        <span>
          First seen <b>{relativeTime(item.firstSeenAt)}</b>
        </span>
        {item.domainAgeDays !== null && (
          <span>
            Registered <b>{item.domainAgeDays} day{item.domainAgeDays === 1 ? '' : 's'} ago</b>
          </span>
        )}
        {item.resolves === false && <span>Not currently resolving</span>}
        {item.hasPasswordField && <span>Serves a password field</span>}
        {item.registrar && <span>via {item.registrar}</span>}
        <span>Score {item.score}/100</span>
      </div>

      {item.signals.length > 0 && (
        <details className="evidence">
          <summary>Why this is listed ({countedSignals(item)} signals)</summary>
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
          <p style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
            <Link href={`/candidate/${item.id}`}>Full record and check history</Link>
            {' · '}
            <Link href={`/report?domain=${encodeURIComponent(item.domain)}&id=${item.id}`}>
              This domain is mine
            </Link>
          </p>
        </details>
      )}
    </li>
  );
}

function countedSignals(item: FeedItem): number {
  return item.signals.filter((s) => s.points !== 0).length;
}
