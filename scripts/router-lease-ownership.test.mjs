import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";

test("lint rejects a second lease store and direct writes through nested snapshots", async () => {
  const file = resolve("extensions/router/index.ts");
  const source = await readFile(file, "utf8");
  const eslint = new ESLint();
  const [result] = await eslint.lintText(
    `${source}
let state: unknown;
state = undefined;
const snapshot = { active: { lifecycle: { phase: "ordinary" } } };
snapshot.active.lifecycle.phase = "discovery_ready";
`,
    { filePath: file },
  );
  const violations = result.messages.filter(({ ruleId }) => ruleId === "no-restricted-syntax");
  assert.ok(violations.some(({ message }) => message.includes("second store")));
  assert.ok(violations.some(({ message }) => message.includes("only mutable lease store")));
  assert.ok(violations.some(({ message }) => message.includes("Nested lease snapshots")));

  const [readOnly] = await eslint.lintText(
    "const snapshot = { active: { lifecycle: { phase: 'ordinary' } } }; let value; value = snapshot.active.lifecycle.phase;",
    { filePath: file },
  );
  assert.ok(
    !readOnly.messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"),
    "reading a nested lease on the right side must not be reported as a mutation",
  );
});
