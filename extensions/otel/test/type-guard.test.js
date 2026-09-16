/**
 * The log-channel emitter rejects the event names SpanTracker owns at compile
 * time. That guarantee lives only in the type system, so it is asserted by
 * typechecking fixtures: one that must compile, one that must not.
 *
 * Without this, the guard could be weakened to a no-op — for example by widening
 * the payload type — and every other test would still pass.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(extensionRoot, "node_modules", "typescript", "bin", "tsc");

const TSC_FLAGS = [
  "--noEmit",
  "--strict",
  "--target",
  "ES2022",
  "--module",
  "NodeNext",
  "--moduleResolution",
  "NodeNext",
  "--skipLibCheck",
];

async function typecheck(fixture) {
  try {
    const { stdout } = await execute(
      process.execPath,
      [tsc, ...TSC_FLAGS, join("test", "fixtures", fixture)],
      { cwd: extensionRoot },
    );
    return { ok: true, output: stdout };
  } catch (error) {
    // tsc reports diagnostics on stdout and exits non-zero.
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("event names outside SpanTracker's set are accepted", async () => {
  const result = await typecheck("log-channel-allowed.ts");
  assert.ok(
    result.ok,
    `the allowed fixture must typecheck, got:\n${result.output}`,
  );
});

test("event names SpanTracker emits are rejected at compile time", async () => {
  const result = await typecheck("log-channel-rejected.ts");
  assert.equal(
    result.ok,
    false,
    "emitting a tracker-owned event on the log channel must fail to typecheck",
  );
  for (const eventName of ["pi.tool.error", "pi.llm_request.error"]) {
    assert.ok(
      result.output.includes(eventName),
      `the diagnostic must name ${eventName}:\n${result.output}`,
    );
  }
  // The marker type is what makes the diagnostic legible at the call site.
  assert.match(result.output, /EmittedBySpanTracker/);
});
