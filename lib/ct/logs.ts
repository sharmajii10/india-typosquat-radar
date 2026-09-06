import { SCANNER_USER_AGENT } from '@/lib/config';

/**
 * Discovering which CT logs to read.
 *
 * Google publishes the authoritative list of logs trusted by Chrome, including
 * each log's lifecycle state. Logs are sharded by year and retired on a
 * schedule, so hardcoding URLs guarantees the scanner silently stops finding
 * anything the following January. Reading the list at runtime means shard
 * rollover happens on its own.
 *
 * Only `usable` logs are scanned. The other states exist for good reasons -
 * `pending` is not yet trusted, `readonly` has stopped accepting new entries,
 * `retired` and `rejected` should not be relied on - and none of them will
 * carry the freshly-issued certificates this project is looking for.
 */

const LOG_LIST_URL = 'https://www.gstatic.com/ct/log_list/v3/log_list.json';

export interface CtLogInfo {
  url: string;
  description: string;
  operator: string;
}

interface LogListJson {
  version?: string;
  operators?: Array<{
    name?: string;
    logs?: Array<{
      description?: string;
      url?: string;
      state?: Record<string, unknown>;
    }>;
  }>;
}

export async function fetchUsableLogs(timeoutMs = 20_000): Promise<CtLogInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(LOG_LIST_URL, {
      signal: controller.signal,
      headers: { 'user-agent': SCANNER_USER_AGENT, accept: 'application/json' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`log list HTTP ${res.status}`);

    const body = (await res.json()) as LogListJson;
    const logs: CtLogInfo[] = [];

    for (const operator of body.operators ?? []) {
      for (const log of operator.logs ?? []) {
        if (!log.url) continue;
        // `state` is an object with exactly one key naming the state.
        const state = Object.keys(log.state ?? {})[0];
        if (state !== 'usable') continue;

        logs.push({
          url: log.url.endsWith('/') ? log.url : `${log.url}/`,
          description: log.description ?? log.url,
          operator: operator.name ?? 'unknown'
        });
      }
    }

    return logs;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which logs to actually scan, given a budget.
 *
 * Spreads across operators rather than taking the first N, because a single
 * operator's logs largely mirror each other - every certificate is submitted to
 * several logs, so reading two Google shards finds much the same certificates
 * twice while missing whatever only went to Cloudflare. One log per operator
 * first, then a second round, and so on.
 */
export function spreadAcrossOperators(logs: CtLogInfo[], limit: number): CtLogInfo[] {
  const byOperator = new Map<string, CtLogInfo[]>();
  for (const log of logs) {
    const list = byOperator.get(log.operator) ?? [];
    list.push(log);
    byOperator.set(log.operator, list);
  }

  const rounds = [...byOperator.values()];
  const picked: CtLogInfo[] = [];
  let depth = 0;

  while (picked.length < limit) {
    let addedThisRound = false;
    for (const list of rounds) {
      if (picked.length >= limit) break;
      if (depth < list.length) {
        picked.push(list[depth]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    depth++;
  }

  return picked;
}
