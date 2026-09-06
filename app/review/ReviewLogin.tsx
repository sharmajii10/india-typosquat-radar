'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ReviewLogin({ usingJobSecret }: { usingJobSecret: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/review/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });

      if (res.ok) {
        setPassword('');
        router.refresh();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Could not sign in.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Review queue</h1>
      <p className="page-intro">
        Candidates that scored high enough to warrant a look but not high enough
        to publish. Nothing here is on the public feed as a detection; each item
        is shown as unconfirmed until a person decides.
      </p>

      <form className="form" onSubmit={submit} style={{ maxWidth: 420 }}>
        <div>
          <label htmlFor="password">Reviewer password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {usingJobSecret && (
            <span className="hint">
              This deployment has no <code>REVIEW_PASSWORD</code> set, so it is
              accepting <code>JOB_SECRET</code>. Setting a separate password is
              better: the job secret is also stored in GitHub Actions.
            </span>
          )}
        </div>

        {error && (
          <div className="form-status" data-kind="error">
            {error}
          </div>
        )}

        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </>
  );
}
