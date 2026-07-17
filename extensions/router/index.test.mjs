import assert from "node:assert/strict";
import { describe, it } from "node:test";
import routerExtension from "./index.ts";

describe("routerExtension", () => {
	it("registers the routing lifecycle and status command without starting background work", () => {
		const hooks = new Map();
		const commands = new Map();
		routerExtension({
			on: (event, handler) => hooks.set(event, handler),
			registerCommand: (name, command) => commands.set(name, command),
		});
		for (const event of [
			"session_start",
			"session_compact",
			"session_before_fork",
			"input",
			"before_agent_start",
			"model_select",
			"thinking_level_select",
			"agent_start",
			"after_provider_response",
			"agent_end",
		]) {
			assert.equal(hooks.has(event), true, `missing ${event}`);
		}
		assert.match(commands.get("route").description, /model-router mode/);
	});
});
