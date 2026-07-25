import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cycleApplyMode,
  getThinkingLevelsForModel,
  supportsVerifiedThinkingLevels,
  updateDefaultThinkingLevelJson,
} from "./helpers.ts";

describe("supportsVerifiedThinkingLevels", () => {
  it("gates provider-verified metadata at pi 0.82.0", () => {
    assert.equal(supportsVerifiedThinkingLevels("0.81.1"), false);
    assert.equal(supportsVerifiedThinkingLevels("0.82.0"), true);
    assert.equal(supportsVerifiedThinkingLevels("1.0.0"), true);
  });

  it("falls back safely for malformed versions", () => {
    assert.equal(supportsVerifiedThinkingLevels("unknown"), false);
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
