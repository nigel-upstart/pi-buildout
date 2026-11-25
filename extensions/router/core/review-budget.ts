// Provisional delta scaling, isolated for the later Design E budget policy.
export const REVIEW_TIMEOUT_FLOOR_MS = 5 * 60_000;
export const REVIEW_TIMEOUT_CAP_MS = 4 * 60 * 60_000;
const REVIEW_MS_PER_CHANGED_LINE = 1_000;

/** Unknown/binary/unmeasurable scope receives the full cap, never a short default. */
export function reviewTimeoutMs(numstat: string | undefined): number {
  if (numstat === undefined || numstat.length > 256_000) return REVIEW_TIMEOUT_CAP_MS;
  let changedLines = 0;
  for (const line of numstat.trim().split("\n")) {
    if (!line) continue;
    const match = /^(\d+)\t(\d+)\t.+$/.exec(line);
    if (!match) return REVIEW_TIMEOUT_CAP_MS;
    changedLines += Number(match[1]) + Number(match[2]);
    if (!Number.isSafeInteger(changedLines)) return REVIEW_TIMEOUT_CAP_MS;
  }
  return Math.min(REVIEW_TIMEOUT_CAP_MS, REVIEW_TIMEOUT_FLOOR_MS + changedLines * REVIEW_MS_PER_CHANGED_LINE);
}
