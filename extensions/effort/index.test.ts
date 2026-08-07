import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import effortExtension from "./index.ts";
import {
  cycleApplyMode,
  getThinkingLevelsForModel,
  parseThinkingLevelArgument,
  supportsVerifiedThinkingLevels,
  updateDefaultThinkingLevelJson,
} from "./helpers.ts";

// helpers.ts keeps its level list internal, so restate it here as the expected
// public contract of the /effort argument parser.
const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

describe("supportsVerifiedThinkingLevels", () => {
  it("gates provider-verified metadata at pi 0.82.0", () => {
    assert.equal(supportsVerifiedThinkingLevels("0.81.1"), false);
    assert.equal(supportsVerifiedThinkingLevels("0.82.0"), true);
    assert.equal(supportsVerifiedThinkingLevels("1.0.0"), true);
  });

  it("falls back safely for malformed versions", () => {
    assert.equal(supportsVerifiedThinkingLevels("unknown"), false);
    assert.equal(supportsVerifiedThinkingLevels("0.82.0garbage"), false);
  });
});

describe("getThinkingLevelsForModel", () => {
  it("keeps all historical choices below pi 0.82.0", () => {
    assert.deepEqual(
      getThinkingLevelsForModel("0.81.1", {
        reasoning: true,
        thinkingLevelMap: { off: null, low: "low", high: "high" },
      }),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    );
  });

  it("filters choices using provider-verified model metadata", () => {
    assert.deepEqual(
      getThinkingLevelsForModel("0.82.0", {
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
      }),
      ["off", "low", "high"],
    );
  });

  it("only offers off for models without reasoning support", () => {
    assert.deepEqual(getThinkingLevelsForModel("0.82.0", { reasoning: false }), ["off"]);
  });

  it("does not infer xhigh or max without model metadata", () => {
    assert.deepEqual(getThinkingLevelsForModel("0.82.0", { reasoning: true }), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("parseThinkingLevelArgument", () => {
  it("recognizes each supported level only when it exactly matches", () => {
    for (const level of ALL_THINKING_LEVELS) {
      assert.deepEqual(parseThinkingLevelArgument(level), { kind: "level", level });
    }
  });

  it("treats an empty argument as missing", () => {
    assert.deepEqual(parseThinkingLevelArgument(""), { kind: "missing" });
  });

  it("rejects unknown, partial, case-variant, and whitespace-padded arguments", () => {
    for (const argument of ["med", "MEDIUM", " medium", "medium ", "high extra"]) {
      assert.deepEqual(parseThinkingLevelArgument(argument), { kind: "unknown", value: argument });
    }
  });
});

function createCommandHarness() {
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type CommandHandler = Command["handler"];
  type CommandContext = Parameters<CommandHandler>[1];
  type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

  let command: Command | undefined;
  const levels: ThinkingLevel[] = [];
  const notifications: { message: string; level: string }[] = [];
  let customCalls = 0;

  const api = {
    registerCommand(_name: string, options: Command): void {
      command = options;
    },
    getThinkingLevel(): ThinkingLevel {
      return "low";
    },
    setThinkingLevel(level: ThinkingLevel): void {
      levels.push(level);
    },
  };
  effortExtension(api as ExtensionAPI);

  const ctx = {
    mode: "tui",
    ui: {
      notify(message: string, level: string): void {
        notifications.push({ message, level });
      },
      custom(): Promise<null> {
        customCalls += 1;
        return Promise.resolve(null);
      },
    },
  } as unknown as CommandContext;

  if (!command) throw new Error("effort extension did not register its command");
  return { command, ctx, customCalls: () => customCalls, levels, notifications };
}

describe("effort command arguments", () => {
  it("applies an exact level without opening the dialog", async () => {
    const harness = createCommandHarness();

    await harness.command.handler("medium", harness.ctx);

    assert.deepEqual(harness.levels, ["medium"]);
    assert.equal(harness.customCalls(), 0);
    assert.deepEqual(harness.notifications, [
      { message: "Thinking effort set to medium for current session", level: "info" },
    ]);
  });

  it("warns about an unknown argument before opening the dialog", async () => {
    const harness = createCommandHarness();

    await harness.command.handler("med", harness.ctx);

    assert.equal(harness.customCalls(), 1);
    assert.equal(harness.levels.length, 0);
    const notification = harness.notifications[0];
    assert.ok(notification);
    assert.equal(notification.level, "warning");
    assert.match(notification.message, /Unknown thinking effort "med"/);
  });

  it("opens the dialog without warning when the argument is missing", async () => {
    const harness = createCommandHarness();

    await harness.command.handler("", harness.ctx);

    assert.equal(harness.customCalls(), 1);
    assert.deepEqual(harness.notifications, []);
  });
});

describe("cycleApplyMode", () => {
  it("toggles from default mode to session-only mode", () => {
    assert.equal(cycleApplyMode("default"), "session");
  });

  it("toggles from session-only mode to default mode", () => {
    assert.equal(cycleApplyMode("session"), "default");
  });
});

describe("updateDefaultThinkingLevelJson", () => {
  it("sets defaultThinkingLevel while preserving existing settings", () => {
    const result = updateDefaultThinkingLevelJson('{"theme":"dark","defaultThinkingLevel":"low"}', "high");
    assert.deepEqual(JSON.parse(result.json), {
      theme: "dark",
      defaultThinkingLevel: "high",
    });
    assert.equal(result.hadParseError, false);
  });

  it("creates settings from an empty file", () => {
    const result = updateDefaultThinkingLevelJson("", "medium");
    assert.deepEqual(JSON.parse(result.json), {
      defaultThinkingLevel: "medium",
    });
    assert.equal(result.hadParseError, false);
  });

  it("recovers from invalid JSON and reports parse error", () => {
    const result = updateDefaultThinkingLevelJson("{not valid json", "minimal");
    assert.deepEqual(JSON.parse(result.json), {
      defaultThinkingLevel: "minimal",
    });
    assert.equal(result.hadParseError, true);
  });
});
