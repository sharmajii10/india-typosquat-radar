import { isConfigured, publicClient } from '@/lib/db';

/**
 * POST /api/report - the dispute path.
 *
 * Built early rather than last, because it is the thing that makes publishing
 * defensible at all. A public list of suspected impersonators will be wrong
 * sometimes; the difference between a responsible tool and a reckless one is
 * whether there is a fast, obvious way for the wrongly-listed to say so.
 *
 * Writes through the ANON key on purpose, so the insert is constrained by the
 * RLS policy in supabase/migrations/0002_rls.sql - it can create an open report
 * and nothing else. It cannot read reports back, cannot change a candidate, and
 * cannot resolve its own dispute. The service key is not involved in any path a
 * member of the public can reach.
 *
 * Body: { domain?, candidateId?, kind: 'dispute'|'confirm'|'other', note, contact? }
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it.
export const dynamic = 'force-dynamic';

const MIN_NOTE = 10;
const MAX_NOTE = 4000;
const MAX_CONTACT = 200;

export async function POST(req: Request): Promise<Response> {
  if (!isConfigured()) {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
  const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';
  const candidateId = typeof body.candidateId === 'string' ? body.candidateId : null;
  const kindRaw = typeof body.kind === 'string' ? body.kind : 'dispute';
  const kind = ['dispute', 'confirm', 'other'].includes(kindRaw) ? kindRaw : 'other';

  if (note.length < MIN_NOTE) {
    return Response.json(
      { error: `Please describe the issue in at least ${MIN_NOTE} characters.` },
      { status: 400 }
    );
  }
  if (note.length > MAX_NOTE) {
    return Response.json({ error: 'Message is too long.' }, { status: 400 });
  }
  if (contact.length > MAX_CONTACT) {
    return Response.json({ error: 'Contact field is too long.' }, { status: 400 });
  }
  if (!domain && !candidateId) {
    return Response.json(
      { error: 'Tell us which domain this is about.' },
      { status: 400 }
    );
  }

  const db = publicClient();
  const { error } = await db.from('reports').insert({
    candidate_id: candidateId,
    domain: domain || null,
    kind,
    note,
    contact: contact || null,
    status: 'open'
  });

  if (error) {
    return Response.json(
      { error: 'Could not save your report. Please try again.', detail: error.message },
      { status: 500 }
    );
  }

  return Response.json({
    ok: true,
    message:
      'Thanks - your report was received and will be reviewed by a person. If you told us the domain is yours, it will be checked and, if listed in error, removed and permanently allowlisted.'
  });
}
