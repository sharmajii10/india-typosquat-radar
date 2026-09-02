/**
 * Import this FIRST in any CLI script that talks to Supabase.
 *
 * Why it exists
 * -------------
 * `createClient()` eagerly constructs a Realtime client, and Realtime requires a
 * global `WebSocket`. Node 22 has one built in; Node 20 does not. On Node 20 the
 * call therefore throws before a single query runs:
 *
 *   Error: Node.js 20 detected without native WebSocket support.
 *
 * This never surfaces in the web app, because the Next.js server runtime
 * provides a `WebSocket` global of its own. It only bites the scripts in this
 * directory, which run on bare Node - which is exactly why `npm run seed` failed
 * on Node 20 while the same code worked fine under `next dev`. A bug that only
 * appears on the first command a new contributor runs is worth a five-line fix.
 *
 * This project never uses Realtime. Nothing subscribes to a channel, and the
 * connection is never opened. The assignment below exists purely to satisfy the
 * constructor, which is why `ws` is a devDependency rather than a runtime one -
 * the deployed app does not need it.
 *
 * Remove this once the project's minimum supported Node version is 22.
 */
import WebSocketImpl from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  // The `ws` constructor is API-compatible enough for the constructor check.
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocketImpl;
}

export {};
