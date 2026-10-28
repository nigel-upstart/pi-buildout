import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewTimeoutMs, REVIEW_TIMEOUT_FLOOR_MS, REVIEW_TIMEOUT_CAP_MS } from "./review-budget.ts";

test("review budget has a five-minute floor, four-hour cap, and conservative unknown scope", () => {
  assert.equal(REVIEW_TIMEOUT_FLOOR_MS, 300_000);
  assert.equal(REVIEW_TIMEOUT_CAP_MS, 14_400_000);
  assert.equal(reviewTimeoutMs(""), REVIEW_TIMEOUT_FLOOR_MS);
  assert.equal(reviewTimeoutMs("5\t3\tsrc/a.ts\n"), REVIEW_TIMEOUT_FLOOR_MS + 8000);
  assert.equal(reviewTimeoutMs("999999\t0\thuge.ts\n"), REVIEW_TIMEOUT_CAP_MS);
  for (const unknown of [undefined, "-\t-\timage.png", "malformed", "1".repeat(256001)])
    assert.equal(reviewTimeoutMs(unknown), REVIEW_TIMEOUT_CAP_MS);
});
