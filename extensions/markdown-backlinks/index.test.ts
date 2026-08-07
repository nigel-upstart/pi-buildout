import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findMarkdownPointers, formatBacklinkTable } from "./helpers.ts";
import markdownBacklinksExtension from "./index.ts";

describe("markdownBacklinksExtension", () => {
  it("loads and registers its lifecycle hooks", () => {
    type EventName = Parameters<ExtensionAPI["on"]>[0];
    type EventHandler = Parameters<ExtensionAPI["on"]>[1];
    const hooks = new Map<EventName, EventHandler>();
    const api = {
      on: (event: EventName, handler: EventHandler): void => {
        hooks.set(event, handler);
      },
    };
    markdownBacklinksExtension(api as ExtensionAPI);

    assert.deepEqual([...hooks.keys()].sort(), ["before_agent_start", "session_start", "tool_result"]);
  });
});

describe("findMarkdownPointers", () => {
  it("finds file pointers and de-duplicates them", () => {
    assert.deepEqual(findMarkdownPointers("Read @README.md and @src/app.ts; then read @README.md."), [
      "@README.md",
      "@src/app.ts",
    ]);
  });

  it("does not treat email addresses as file pointers", () => {
    assert.deepEqual(findMarkdownPointers("Contact me@example.com; see @notes.txt."), ["@notes.txt"]);
  });
});

describe("formatBacklinkTable", () => {
  it("describes the read-until-resolved behavior without mutating the input", () => {
    const backlinks = [{ sourcePath: "/repo/AGENTS.md", pointer: "@README.md", targetPath: "/repo/README.md" }];
    const text = formatBacklinkTable(backlinks);
    assert.match(text, /@README\.md/);
    assert.match(text, /reasonable candidate for a `read` tool call/);
    assert.match(text, /until the target is read successfully/);
    assert.deepEqual(backlinks, [
      { sourcePath: "/repo/AGENTS.md", pointer: "@README.md", targetPath: "/repo/README.md" },
    ]);
  });
});
