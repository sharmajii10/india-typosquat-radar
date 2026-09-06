/**
 * Time budgeting for serverless jobs.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vercel kills a function at its `maxDuration` and returns HTTP 504
 * FUNCTION_INVOCATION_TIMEOUT. Nothing is flushed, nothing is recorded, and the
 * caller cannot tell a timeout from a crash.
 *
 * The first version of this project managed that with a single "soft deadline"
 * checked between units of work. That is not enough, because a unit of work can
 * itself outlast the whole budget: one crt.sh term with three 20-second attempts
 * plus backoff is 66 seconds, against a 60-second ceiling. Checking the clock
 * before starting it does not help once it has started.
 *
 * So every network call takes an absolute deadline and shrinks its own timeout
 * to fit inside it. The rule is: no operation may begin unless there is time to
 * finish it, and no operation may run past the budget once begun.
 *
 * Deadlines are absolute epoch milliseconds rather than durations, so they can
 * be passed down through several layers without each one re-deriving "how long
 * is left" from a start time it does not have.
 */

/** An absolute deadline, `ms` from now. */
export function deadlineIn(ms: number): number {
  return Date.now() + ms;
}

/** Milliseconds left, never negative. */
export function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

/**
 * True when there is not enough time left to usefully start something.
 *
 * `needMs` is the caller's honest worst-case estimate for the work it is about
 * to begin. Passing a real number here is the whole point: `expired(d)` with no
 * argument only tells you the budget is already gone, which is too late.
 */
export function outOfTime(deadlineAt: number, needMs = 0): boolean {
  return remainingMs(deadlineAt) <= needMs;
}

/**
 * A timeout that fits inside the remaining budget.
 *
 * Returns the preferred timeout, or whatever time is actually left minus a
 * small margin, whichever is smaller. The margin exists so the caller gets its
 * own abort and can record a result, rather than the platform killing the
 * function mid-write.
 *
 * Returns 0 when there is no useful time left, which callers treat as "skip".
 */
export function boundedTimeout(
  deadlineAt: number,
  preferredMs: number,
  marginMs = 750
): number {
  const usable = remainingMs(deadlineAt) - marginMs;
  if (usable <= 0) return 0;
  return Math.min(preferredMs, usable);
}

/** Sleep, but never past the deadline. */
export function sleepUntil(deadlineAt: number, ms: number): Promise<void> {
  const capped = Math.min(ms, remainingMs(deadlineAt));
  if (capped <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, capped));
}
