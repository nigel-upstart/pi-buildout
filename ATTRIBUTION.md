# Attribution

The subagent extension in [`extensions/subagents`](extensions/subagents) was informed by the two implementations identified by the project owner. The implementation in this repository is original code, but it deliberately carries forward architectural ideas and operational lessons from both projects.

## `nicobailon/pi-subagents`

- Repository: <https://github.com/nicobailon/pi-subagents>
- Local revision reviewed: `315e1eb1482c4ac2d912a8d95aac4287dc7e60ac`
- License declared by its package: MIT

Ideas and lessons used:

- Treat a subagent as a separate Pi process and session rather than an in-process prompt persona.
- Keep asynchronous child work observable through structured state and transcript tails.
- Expose explicit lifecycle controls for status inspection, steering, interruption, and stopping.
- Bound child protocol and diagnostic output so a malformed or noisy child cannot grow parent memory without limit.
- Make recursive delegation safe by scoping child registries and controls to a parent/child tree rather than a global fleet.
- Validate model choices against Pi's live model registry and preserve a clear fallback path.
- Clean up child processes and extension-owned resources during Pi session shutdown/reload.

We intentionally did **not** reproduce its agent profiles, chain/parallel workflow engine, intercom/supervisor channel, watchdog, artifact protocol, slash-command suite, or TUI fleet. This extension stays between that feature-rich design and a one-shot runner.

## `elpapi42/pi-minimal-subagent`

- Repository: <https://github.com/elpapi42/pi-minimal-subagent>
- Local revision reviewed: `4c847a37b7d675470a8c5eb50d736d11ceac910a`
- License declared by its package: MIT

Ideas and lessons used:

- Keep the model-facing surface centered on one small `subagent` tool.
- Let ordinary natural-language requests cause the parent model to delegate; do not require a special slash workflow.
- Launch child Pi with normal extension/resource discovery by default so configured tools and integrations remain available.
- Resolve the Pi executable robustly when Pi is running either as a standalone executable or through Node.
- Use process isolation and propagate shutdown/abort behavior instead of sharing an agent session object.
- Keep task dispatch simple and avoid requiring named role/persona files.

We extended that minimal shape with persistent RPC children, task-targeted context compaction, automatic model/effort classification, direct-child spying and control, and recursive child creation.

## Pi documentation and examples

The implementation also follows the public extension, SDK, RPC, compaction, session, package, model, and TUI documentation shipped with `@earendil-works/pi-coding-agent` 0.80.6, including Pi's bundled subagent and custom-compaction examples. Those references informed API usage, JSONL framing, tool rendering, model authentication, resource inheritance, and shutdown handling.
