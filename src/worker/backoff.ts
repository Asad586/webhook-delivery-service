/**
 * Full jitter: random between 0 and the exponential ceiling.
 *
 * Not `exponential + small random`. When a subscriber recovers from an outage,
 * every queued delivery would otherwise fire in the same millisecond and knock
 * it over again. Full jitter spreads the herd across the whole window.
 */
export function nextAttemptDelayMs(
  attempts: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.floor(random() * exponential);
}
