import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, "extensions", "otel");

/**
 * The OpenTelemetry SDK and exporter packages that carry the real Node floor.
 * They publish a single shared engine range, so each is checked by name: a range
 * that changes, or an `engines` field that disappears, fails here instead of
 * being filtered out and passing vacuously.
 *
 * The API packages (`@opentelemetry/api`, `@opentelemetry/api-logs`) are
 * deliberately excluded: they advertise a permissive `>=8.0.0` so any consumer
 * can depend on them, and they do not constrain this extension.
 */
const OTEL_FLOOR_PACKAGES = [
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/resources",
  "@opentelemetry/core",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-logs-otlp-http",
];

describe("vendored OTel extension engine range", () => {
  it("advertises exactly the engine range its dependencies declare", async () => {
    // Advertising a lower floor than the dependency train supports invites an
    // install that resolves and then fails at runtime.
    const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(extension, "package-lock.json"), "utf8"));

    for (const name of OTEL_FLOOR_PACKAGES) {
      const entry = lock.packages[`node_modules/${name}`];
      assert.ok(entry, `${name} must be present in the lockfile`);
      const range = entry.engines?.node;
      assert.ok(range, `${name} must declare engines.node`);
      assert.equal(manifest.engines.node, range, `engines.node must equal the range ${name} declares (${range})`);
    }
  });

  it("keeps the lockfile's own engine metadata in step with the manifest", async () => {
    // npm copies the manifest's engines into the lockfile root, so editing one
    // without regenerating the other leaves two disagreeing contracts.
    const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(extension, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[""].engines.node, manifest.engines.node);
  });
});
