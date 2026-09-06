import { SCANNER_USER_AGENT } from '@/lib/config';
import { extractDnsNames, parseLeaf } from '@/lib/ct/leaf';
import type { CertSighting } from '@/lib/types';
import { normalizeCertName } from '@/lib/util/domain';

/**
 * Reading a Certificate Transparency log directly, per RFC 6962.
 *
 * This exists to replace polling crt.sh. crt.sh is one third-party web
 * front-end that returns 502s for hours at a time, and worse, answers HTTP 200
 * with an empty array while broken. The logs themselves are operated by Google,
 * Cloudflare, DigiCert and Let's Encrypt, are covered by Chrome's uptime
 * requirements, and are the source crt.sh is itself reading.
 *
 * Two endpoints do everything:
 *   GET ct/v1/get-sth      - current tree size, so we know how far to read
 *   GET ct/v1/get-entries  - a range of entries by index
 *
 * The protocol reference implementation is Google's certificate-transparency-go.
 * This is a deliberately small subset of it: enough to walk forward through new
 * entries and pull out domain names, and nothing about running or auditing a
 * log, which is most of what that project does.
 */

export interface SignedTreeHead {
  treeSize: number;
  timestampMs: number;
}

export interface ScanRange {
  from: number;
  to: number;
}

export interface ScanResult {
  sightings: CertSighting[];
  /** Index to resume from next time. */
  nextIndex: number;
  entriesRead: number;
  /** Entries deliberately skipped because the cursor had fallen too far
   *  behind. Non-zero means this log is producing faster than we can read it. */
  entriesSkipped: number;
  /** Entries the parser could not make sense of. A handful is normal; CT logs
   *  contain genuinely malformed certificates. A high proportion means the
   *  parser has a bug. */
  entriesUnparsed: number;
  treeSize: number;
  stoppedBecause: 'caught-up' | 'budget' | 'limit' | 'error';
  error?: string;
}

/**
 * Entries requested per call. Logs cap this themselves and return fewer than
 * asked without it being an error, so the loop must always advance by what it
 * actually received rather than by what it requested. Getting that wrong is the
 * classic way to build a scanner that silently skips entries.
 */
const ENTRIES_PER_REQUEST = 256;

/** How far back to start when a log has never been scanned before.
 *
 *  Logs hold billions of entries; starting at zero would read years of history
 *  to find nothing current. This project only cares about certificates issued
 *  minutes ago, so a new log starts just behind its head. */
const COLD_START_BACKFILL = 2_000;

export async function getSth(logUrl: string, timeoutMs = 15_000): Promise<SignedTreeHead> {
  const body = await getJson<{ tree_size: number; timestamp: number }>(
    `${logUrl}ct/v1/get-sth`,
    timeoutMs
  );
  return { treeSize: body.tree_size, timestampMs: body.timestamp };
}

export interface ScanOptions {
  logUrl: string;
  /** Where the last run stopped. 0 means this log has never been scanned. */
  fromIndex: number;
  /** Absolute epoch-ms budget for this log. */
  deadlineAt: number;
  /** Stop after this many entries even if time remains, so one busy log cannot
   *  consume a whole run and starve the others. */
  maxEntries: number;
  /**
   * If the cursor is further behind the head than this, skip forward and admit
   * the gap.
   *
   * This is a live radar. A scanner that has fallen a day behind is reading
   * yesterday's certificates, which is worse than useless - it looks healthy
   * while reporting stale results, and it never catches up because the log
   * grows faster than it reads. Jumping to the head restores usefulness
   * immediately and the skip is recorded rather than hidden.
   */
  maxLag: number;
  /** Only names matching this survive. Filtering here rather than downstream is
   *  what makes reading the firehose viable: well under one in a thousand
   *  certificates is interesting, and the rest are discarded before they cost
   *  anything. */
  isInteresting: (name: string) => boolean;
  signal?: AbortSignal;
}

export async function scanLog(options: ScanOptions): Promise<ScanResult> {
  const { logUrl, deadlineAt, maxEntries, isInteresting } = options;

  const result: ScanResult = {
    sightings: [],
    nextIndex: options.fromIndex,
    entriesRead: 0,
    entriesSkipped: 0,
    entriesUnparsed: 0,
    treeSize: 0,
    stoppedBecause: 'caught-up'
  };

  let sth: SignedTreeHead;
  try {
    sth = await getSth(logUrl);
  } catch (err) {
    result.stoppedBecause = 'error';
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  result.treeSize = sth.treeSize;

  let index =
    options.fromIndex > 0
      ? options.fromIndex
      : Math.max(0, sth.treeSize - COLD_START_BACKFILL);

  // A log can shrink relative to our cursor only if we recorded a bad value, or
  // the log was replaced at the same URL. Either way, resync to the head rather
  // than looping forever asking for entries past the end.
  if (index > sth.treeSize) {
    index = Math.max(0, sth.treeSize - COLD_START_BACKFILL);
  }

  // Too far behind to catch up: jump to the head and record what was skipped.
  const lag = sth.treeSize - index;
  if (options.maxLag > 0 && lag > options.maxLag) {
    const target = Math.max(0, sth.treeSize - options.maxLag);
    result.entriesSkipped = target - index;
    index = target;
  }

  const seen = new Set<string>();

  while (index < sth.treeSize) {
    if (result.entriesRead >= maxEntries) {
      result.stoppedBecause = 'limit';
      break;
    }
    if (Date.now() >= deadlineAt) {
      result.stoppedBecause = 'budget';
      break;
    }

    const end = Math.min(index + ENTRIES_PER_REQUEST - 1, sth.treeSize - 1);

    let batch: { entries?: Array<{ leaf_input?: string }> };
    try {
      batch = await getJson(
        `${logUrl}ct/v1/get-entries?start=${index}&end=${end}`,
        Math.max(2000, Math.min(15_000, deadlineAt - Date.now())),
        options.signal
      );
    } catch (err) {
      result.stoppedBecause = 'error';
      result.error = err instanceof Error ? err.message : String(err);
      break;
    }

    const entries = batch.entries ?? [];
    if (entries.length === 0) {
      // The log returned nothing for a range it says exists. Advancing anyway
      // would skip entries; stopping means the next run retries the same range.
      result.stoppedBecause = 'error';
      result.error = `log returned 0 entries for range ${index}-${end}`;
      break;
    }

    for (const entry of entries) {
      if (!entry.leaf_input) {
        result.entriesUnparsed++;
        continue;
      }

      const leaf = parseLeaf(entry.leaf_input);
      if (!leaf) {
        result.entriesUnparsed++;
        continue;
      }

      const names = extractDnsNames(leaf.der);
      if (names.length === 0) {
        // Not necessarily an error: certificates can carry only IP addresses or
        // only a common name.
        continue;
      }

      const loggedAt = new Date(leaf.timestampMs).toISOString();

      for (const raw of names) {
        const name = normalizeCertName(raw);
        if (!name || seen.has(name)) continue;
        if (!isInteresting(name)) continue;
        seen.add(name);

        result.sightings.push({
          name,
          issuer: null, // Not parsed; RDAP and the cert timing signal do not need it here.
          notBefore: loggedAt,
          loggedAt,
          source: 'certstream'
        });
      }
    }

    // Advance by what the log actually returned, never by what was requested.
    result.entriesRead += entries.length;
    index += entries.length;
    result.nextIndex = index;
  }

  if (index >= sth.treeSize) result.stoppedBecause = 'caught-up';
  result.nextIndex = index;
  return result;
}

async function getJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': SCANNER_USER_AGENT },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
