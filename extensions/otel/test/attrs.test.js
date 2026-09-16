import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clampAttr,
  DEFAULT_MAX_ATTRIBUTE_BYTES,
} from "../dist/attrs.js";
import { MAX_ATTRIBUTE_BYTES_LIMIT, resolveConfig } from "../dist/config.js";
import { SpanTracker } from "../dist/spans.js";

const SUFFIX = "…[truncated]";

function recordingTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, opts) {
      const rec = {
        name,
        kind: opts?.kind,
        attributes: { ...(opts?.attributes ?? {}) },
      };
      spans.push(rec);
      return {
        setAttribute(k, v) {
          rec.attributes[k] = v;
        },
        setStatus() {},
        addEvent(name, attributes) {
          (rec.events ??= []).push({ name, attributes });
        },
        end() {},
        spanContext: () => ({
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
        }),
      };
    },
  };
}

/** Settings dir isolation: resolveConfig also reads $HOME/.pi/agent/settings.json. */
function withSettings(otel, fn) {
  const home = mkdtempSync(join(tmpdir(), "pi-otel-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-otel-cwd-"));
  if (otel !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ otel }));
  }
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(cwd);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
  }
}

function withEnv(key, value, fn) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

// --- clampAttr ------------------------------------------------------------

test("the default cap stays at the upstream 60 KiB compatibility value", () => {
  assert.equal(DEFAULT_MAX_ATTRIBUTE_BYTES, 60 * 1024);
  const oversized = "x".repeat(DEFAULT_MAX_ATTRIBUTE_BYTES + 1);
  const clamped = clampAttr(oversized);
  assert.ok(clamped.endsWith(SUFFIX));
  assert.ok(Buffer.byteLength(clamped, "utf8") <= DEFAULT_MAX_ATTRIBUTE_BYTES);
});

test("a value at exactly the cap is untouched and carries no marker", () => {
  const exact = "x".repeat(DEFAULT_MAX_ATTRIBUTE_BYTES);
  assert.equal(clampAttr(exact), exact);
});

test("a configured cap above 60 KiB keeps a large payload intact", () => {
  const large = "tool-output-".repeat(20_000); // 240 KB, far past the default
  assert.ok(Buffer.byteLength(large, "utf8") > DEFAULT_MAX_ATTRIBUTE_BYTES);
  assert.equal(clampAttr(large, 1024 * 1024), large);
});

test("truncation never splits a multi-byte character and never exceeds the cap", () => {
  for (const maxBytes of [15, 16, 17, 18, 40, 4096]) {
    const clamped = clampAttr("🙂".repeat(4096), maxBytes);
    assert.ok(
      Buffer.byteLength(clamped, "utf8") <= maxBytes,
      `maxBytes=${maxBytes} produced ${Buffer.byteLength(clamped, "utf8")} bytes`,
    );
    assert.ok(clamped.endsWith(SUFFIX), `maxBytes=${maxBytes} lost the marker`);
    assert.ok(
      !clamped.includes("\uFFFD"),
      `maxBytes=${maxBytes} split a character`,
    );
  }
});

test("a cap too small for the marker emits content only, still within the cap", () => {
  const clamped = clampAttr("abcdefghij", 4);
  assert.equal(clamped, "abcd");
  assert.ok(Buffer.byteLength(clamped, "utf8") <= 4);
});

test("non-string values are JSON-serialized before clamping", () => {
  assert.equal(clampAttr({ a: 1 }), '{"a":1}');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof clampAttr(cyclic), "string");
});

test("values JSON.stringify cannot represent still clamp to a string", () => {
  // JSON.stringify returns undefined for these, which would throw in
  // Buffer.byteLength if it were passed through unchecked.
  assert.equal(clampAttr(undefined), "undefined");
  assert.equal(clampAttr(() => 1), "() => 1");
  assert.equal(clampAttr(Symbol("tool")), "Symbol(tool)");
});

// --- resolveConfig --------------------------------------------------------

test("maxAttributeBytes defaults to 60 KiB when unset", () => {
  withSettings(undefined, (cwd) => {
    assert.equal(
      resolveConfig(cwd).maxAttributeBytes,
      DEFAULT_MAX_ATTRIBUTE_BYTES,
    );
  });
});

test("maxAttributeBytes is read from settings, as a number or a numeric string", () => {
  withSettings({ maxAttributeBytes: 1_048_576 }, (cwd) => {
    assert.equal(resolveConfig(cwd).maxAttributeBytes, 1_048_576);
  });
  withSettings({ maxAttributeBytes: " 1048576 " }, (cwd) => {
    assert.equal(resolveConfig(cwd).maxAttributeBytes, 1_048_576);
  });
});

test("the env var overrides settings, matching the documented precedence", () => {
  withSettings({ maxAttributeBytes: 1_048_576 }, (cwd) => {
    withEnv("PI_OTEL_MAX_ATTRIBUTE_BYTES", "2048", () => {
      assert.equal(resolveConfig(cwd).maxAttributeBytes, 2048);
    });
  });
});

test("boundary values are accepted", () => {
  for (const value of [1, MAX_ATTRIBUTE_BYTES_LIMIT]) {
    withSettings({ maxAttributeBytes: value }, (cwd) => {
      assert.equal(resolveConfig(cwd).maxAttributeBytes, value);
    });
  }
});

test("an unusable cap falls back to the default instead of dropping capture", () => {
  const rejected = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_ATTRIBUTE_BYTES_LIMIT + 1,
    Number.MAX_SAFE_INTEGER + 2,
    "",
    "   ",
    "not-a-number",
    true,
    null,
    [],
    {},
  ];
  for (const value of rejected) {
    withSettings({ maxAttributeBytes: value }, (cwd) => {
      assert.equal(
        resolveConfig(cwd).maxAttributeBytes,
        DEFAULT_MAX_ATTRIBUTE_BYTES,
        `maxAttributeBytes=${JSON.stringify(value)} must fall back to the default`,
      );
    });
  }
});

// --- SpanTracker end-to-end ----------------------------------------------

function toolResultAttrs(maxAttributeBytes, result) {
  const tracer = recordingTracer();
  const opts = {
    tracer,
    captureContent: "full",
    cwd: "/tmp/wd",
    sessionId: () => "sess-1",
  };
  if (maxAttributeBytes !== undefined) {
    opts.maxAttributeBytes = maxAttributeBytes;
  }
  const tracker = new SpanTracker(opts);
  tracker.startInteraction("hello");
  tracker.startTurn(0);
  tracker.startTool("call-1", "bash", { cmd: "ls" });
  tracker.endTool("call-1", { isError: false, result });
  return tracer.spans.find((s) => s.name === "pi.tool.bash").attributes;
}

test("a tool result larger than 60 KiB is exported intact under a raised cap", () => {
  const result = "R".repeat(200 * 1024);
  const attrs = toolResultAttrs(1024 * 1024, result);
  assert.equal(attrs["pi.tool.output"], result);
  assert.equal(attrs["gen_ai.tool.call.result"], result);
});

test("the same tool result is still truncated at the default cap", () => {
  const result = "R".repeat(200 * 1024);
  const attrs = toolResultAttrs(undefined, result);
  for (const key of ["pi.tool.output", "gen_ai.tool.call.result"]) {
    assert.ok(attrs[key].endsWith(SUFFIX), `${key} must be marked truncated`);
    assert.ok(
      Buffer.byteLength(attrs[key], "utf8") <= DEFAULT_MAX_ATTRIBUTE_BYTES,
      `${key} must respect the default cap`,
    );
  }
});

test("a raised cap reaches prompt, message-list, and tool-input attributes", () => {
  const big = "P".repeat(120 * 1024);
  const tracer = recordingTracer();
  const tracker = new SpanTracker({
    tracer,
    captureContent: "full",
    maxAttributeBytes: 1024 * 1024,
    cwd: "/tmp/wd",
    sessionId: () => "sess-1",
  });
  tracker.startInteraction(big);
  tracker.startTurn(0);
  tracker.noteUserMessage(big);
  tracker.startLlmRequest("claude-sonnet-4", "anthropic");
  tracker.startTool("call-1", "bash", { cmd: big });
  tracker.endTool("call-1", { isError: false, result: "ok" });
  tracker.noteAssistantMessage({ content: big, provider: "anthropic" });

  const interaction = tracer.spans.find((s) => s.name === "pi.interaction");
  assert.equal(interaction.attributes["pi.user_prompt"], big);

  const llm = tracer.spans.find((s) => s.name === "pi.llm_request");
  for (const key of ["gen_ai.input.messages", "gen_ai.output.messages"]) {
    assert.ok(
      !llm.attributes[key].endsWith(SUFFIX),
      `${key} must not be truncated under a raised cap`,
    );
    assert.ok(llm.attributes[key].includes(big));
  }

  const tool = tracer.spans.find((s) => s.name === "pi.tool.bash");
  assert.ok(tool.attributes["pi.tool.input"].includes(big));
  assert.ok(!tool.attributes["pi.tool.input"].endsWith(SUFFIX));
});

test("omitting maxAttributeBytes preserves upstream truncation behavior", () => {
  const big = "P".repeat(120 * 1024);
  const tracer = recordingTracer();
  const tracker = new SpanTracker({
    tracer,
    captureContent: "full",
    cwd: "/tmp/wd",
    sessionId: () => "sess-1",
  });
  tracker.startInteraction(big);
  const interaction = tracer.spans.find((s) => s.name === "pi.interaction");
  const prompt = interaction.attributes["pi.user_prompt"];
  assert.ok(prompt.endsWith(SUFFIX));
  assert.ok(
    Buffer.byteLength(prompt, "utf8") <= DEFAULT_MAX_ATTRIBUTE_BYTES,
  );
});
