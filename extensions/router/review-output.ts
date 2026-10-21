import { randomBytes } from "node:crypto";
import { VERDICTS_BY_KIND } from "./core/safety.ts";
import type { SafetyReviewKind } from "./core/safety.ts";

const MAX_OUTPUT_CHARS = 200_000;
const MAX_BLOCK_CHARS = 64_000;

/** A fresh 128-bit attempt nonce; it binds a final answer to one router attempt. */
export function newReviewNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Text-only verdict contract for children without the SDK reviewer's verdict tool. */
export function reviewOutputContract(nonce: string, kind: SafetyReviewKind, scopeFingerprint: string): string {
  return [
    "Inspect read-only. Do not modify files, run mutating commands, or start other agents.",
    `Finish with exactly one block: an opening router-result tag with attribute nonce="${nonce}", one JSON object, then the closing tag.`,
    `The JSON object has exactly: reviewKind "${kind}", scopeFingerprint "${scopeFingerprint}", verdict, summary, evidence (1-100 strings), findings (0-100 strings).`,
    `verdict is one of: ${VERDICTS_BY_KIND[kind].join(", ")}.`,
    "Give advice, not permission.",
  ].join("\n");
}

/** The last nonce-tagged JSON block in final text, or undefined. Schema validation stays with the caller. */
export function parseReviewOutput(text: string, nonce: string): unknown {
  const bounded = text.slice(-MAX_OUTPUT_CHARS);
  const open = `<router-result nonce="${nonce}">`;
  const start = bounded.lastIndexOf(open);
  if (start < 0) return undefined;
  const end = bounded.indexOf("</router-result>", start + open.length);
  if (end < 0 || end - start > MAX_BLOCK_CHARS) return undefined;
  try {
    return JSON.parse(bounded.slice(start + open.length, end)) as unknown;
  } catch {
    return undefined;
  }
}
