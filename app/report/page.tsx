'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

/**
 * The dispute path.
 *
 * Built in the first pass rather than bolted on later, because publishing a list
 * of suspected impersonators without a fast correction route is the part of this
 * project that could actually hurt someone. A small business whose domain is
 * wrongly listed needs a link, not an email address buried in a footer.
 */

/** Optional. When set, the dispute page offers an email route as well as the
 *  form - some people will not trust a form on a site that just listed their
 *  domain, and the dispute path has to be easy to reach or it does not work. */
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL;

export default function ReportPage() {
  return (
    <Suspense fallback={<h1>Dispute or report a listing</h1>}>
      <ReportForm />
    </Suspense>
  );
}

function ReportForm() {
  const params = useSearchParams();
  const [domain, setDomain] = useState(params.get('domain') ?? '');
  const [kind, setKind] = useState(params.get('domain') ? 'dispute' : 'confirm');
  const [note, setNote] = useState('');
  const [contact, setContact] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);

  const candidateId = params.get('id');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);

    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain, kind, note, contact, candidateId })
      });
      const body = await res.json();

      if (!res.ok) {
        setStatus({ kind: 'error', message: body.error ?? 'Something went wrong.' });
      } else {
        setStatus({ kind: 'ok', message: body.message });
        setNote('');
      }
    } catch {
      setStatus({
        kind: 'error',
        message: 'Could not reach the server. Please try again.'
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1>Dispute or report a listing</h1>
      <p className="page-intro">
        If a domain listed here is yours and the listing is wrong, tell us. It will be
        reviewed by a person, and if it was listed in error it is removed and permanently
        allowlisted so it cannot reappear. You can also use this form to report a phishing
        domain we have missed.
      </p>

      <div className="notice">
        <strong>What we do with this.</strong> Reports go into a review queue that a person
        works through. Your message and contact details are stored so the review can be
        followed up; they are never published, never shown on the site, and never shared
        with third parties. Leaving the contact field blank is fine, but then we cannot
        tell you the outcome.
      </div>

      <form className="form" onSubmit={submit}>
        <div>
          <label htmlFor="kind">What is this about?</label>
          <select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="dispute">This domain is mine and the listing is wrong</option>
            <option value="confirm">This is a phishing domain you have missed</option>
            <option value="other">Something else</option>
          </select>
        </div>

        <div>
          <label htmlFor="domain">Domain</label>
          <input
            id="domain"
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.co.in"
            required
          />
        </div>

        <div>
          <label htmlFor="note">
            Details
            <span className="hint">
              {kind === 'dispute'
                ? 'What does the site actually do, and how long has it been running? Anything that shows the domain is a genuine business helps the review go faster.'
                : 'What did you see, and what brand is it impersonating?'}
            </span>
          </label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minLength={10}
            maxLength={4000}
            required
          />
        </div>

        <div>
          <label htmlFor="contact">
            Contact
            <span className="hint">
              Optional. An email address if you want to hear the outcome.
            </span>
          </label>
          <input
            id="contact"
            type="text"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={200}
          />
        </div>

        {status && (
          <div className="form-status" data-kind={status.kind}>
            {status.message}
          </div>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send report'}
        </button>
      </form>

      {CONTACT_EMAIL && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 20 }}>
          If you would rather not use this form, email{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> instead. A dispute sent
          either way reaches the same person.
        </p>
      )}

      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 28 }}>
        For anything urgent involving an active phishing site, also report it to the
        affected bank directly and to India&rsquo;s National Cyber Crime Reporting Portal.
        This project is an early-warning signal, not an enforcement body, and cannot take a
        site down. <Link href="/about">More about what this does and does not do.</Link>
      </p>
    </>
  );
}
