import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { completeSimple, StringEnum, type Model } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	resolveCliModel,
	serializeConversation,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	THINKING_LEVELS,
	clampThinkingLevel,
	extractTextContent,
	formatModelCatalog,
	parseClassifierDecision,
	truncateMiddle,
	type ModelLike,
	type ThinkingLevel,
} from "./helpers.ts";
import { ManagedSubagent, type ChildSnapshot } from "./rpc.ts";

const MAX_CONTEXT_CHARS = 320_000;
const MAX_CLASSIFIER_CONTEXT_CHARS = 24_000;
const MAX_STATUS_TEXT_CHARS = 45_000;
const MAX_ACTIVE_CHILDREN = 12;
const MAX_DEPTH = 8;
const DEPTH_ENV = "PI_SIMPLE_SUBAGENT_DEPTH";
const SELF_EXTENSION_PATH = fileURLToPath(import.meta.url);

const SubagentParameters = Type.Object({
	action: StringEnum(["create", "list", "status", "steer", "follow_up", "interrupt", "stop"] as const, {
		description: "create a child; inspect it; steer now; queue follow_up; interrupt its current operation; or stop its process",
	}),
	task: Type.Optional(Type.String({
		description: "For create: the complete task. For steer/follow_up: the additional message.",
	})),
	id: Type.Optional(Type.String({ description: "Direct child id for status/control actions" })),
	name: Type.Optional(Type.String({ description: "Optional human-readable name when creating a child" })),
	model: Type.Optional(Type.String({
		description: "Optional model request, such as gpt-5.6-luna or openai/gpt-5.6-luna. Preserve a model explicitly requested by the user.",
	})),
	effort: Type.Optional(StringEnum(THINKING_LEVELS, {
		description: "Optional reasoning effort. Preserve an effort explicitly requested by the user, for example high.",
	})),
});

interface Selection {
	model: Model<any>;
	effort: ThinkingLevel;
	source: "explicit" | "classified" | "fallback";
	rationale?: string;
}

function currentDepth(): number {
	const value = Number(process.env[DEPTH_ENV] ?? "0");
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function textFromAssistant(response: { content: unknown }): string {
	return extractTextContent(response.content).trim();
}

function parentThinking(pi: ExtensionAPI): ThinkingLevel {
	const value = pi.getThinkingLevel();
	return THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : "off";
}

async function utilityCompletion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	maxTokens: number,
): Promise<string> {
	if (!ctx.model) throw new Error("The parent session has no selected model.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key is available for ${ctx.model.provider}/${ctx.model.id}.`);
	const effort = parentThinking(pi);
	const response = await completeSimple(
		ctx.model,
		{
			messages: [{
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			}],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens,
			signal: ctx.signal,
			...(effort === "off" ? {} : { reasoning: effort }),
		},
	);
	const text = textFromAssistant(response);
	if (!text) throw new Error("Utility model returned an empty response.");
	return text;
}

function serializeParentContext(ctx: ExtensionContext): string {
	const built = ctx.sessionManager.buildSessionContext();
	try {
		return serializeConversation(convertToLlm(built.messages));
	} catch {
		return JSON.stringify(built.messages, null, 2);
	}
}

async function compactContextForTask(pi: ExtensionAPI, ctx: ExtensionContext, task: string): Promise<{ summary: string; fallback: boolean }> {
	const built = ctx.sessionManager.buildSessionContext();
	const conversation = truncateMiddle(serializeParentContext(ctx), MAX_CONTEXT_CHARS);
	if (built.messages.length === 0 || !conversation.trim()) {
		return { summary: "No prior conversation context was available.", fallback: false };
	}

	const sessionManager = SessionManager.inMemory(ctx.cwd);
	for (const message of built.messages) sessionManager.appendMessage(message);
	// Pi compaction retains a recent boundary. A synthetic final boundary lets the
	// compactor summarize all real parent messages even when the parent is small.
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Compaction boundary for delegated work." }],
		timestamp: Date.now(),
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 1 },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	let compactSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let abortCompaction: (() => void) | undefined;
	try {
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model: ctx.model,
			thinkingLevel: parentThinking(pi),
			modelRegistry: ctx.modelRegistry,
			resourceLoader,
			sessionManager,
			settingsManager,
			noTools: "all",
		});
		compactSession = created.session;
		abortCompaction = () => compactSession?.abortCompaction();
		ctx.signal?.addEventListener("abort", abortCompaction, { once: true });
		const result = await compactSession.compact(`Create context specifically for this delegated task:\n\n${task}\n\nPreserve relevant user requirements, constraints, decisions and rationale, exact file paths and symbols, commands and results, repository state, unresolved questions, and failures. Omit unrelated discussion. Do not solve the task or add a persona.`);
		return { summary: result.summary, fallback: false };
	} catch (error) {
		if (ctx.signal?.aborted) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		return {
			summary: `## Compaction fallback\nPi's targeted compact call failed (${reason}). The bounded parent transcript follows.\n\n${truncateMiddle(conversation, 60_000)}`,
			fallback: true,
		};
	} finally {
		if (abortCompaction) ctx.signal?.removeEventListener("abort", abortCompaction);
		compactSession?.dispose();
	}
}

function resolveRequestedModel(ctx: ExtensionContext, request: string): { model?: Model<any>; effort?: ThinkingLevel; error?: string } {
	const result = resolveCliModel({ cliModel: request, modelRegistry: ctx.modelRegistry });
	if (result.error || !result.model) return { error: result.error ?? `Model '${request}' was not found.` };
	if (!ctx.modelRegistry.hasConfiguredAuth(result.model)) {
		return { error: `Model '${result.model.provider}/${result.model.id}' is not authenticated.` };
	}
	return {
		model: result.model,
		...(result.thinkingLevel && THINKING_LEVELS.includes(result.thinkingLevel as ThinkingLevel)
			? { effort: result.thinkingLevel as ThinkingLevel }
			: {}),
	};
}

function parentFallback(pi: ExtensionAPI, ctx: ExtensionContext): Selection {
	if (!ctx.model) throw new Error("Cannot create a subagent because the parent has no selected model.");
	return {
		model: ctx.model,
		effort: clampThinkingLevel(parentThinking(pi), ctx.model as ModelLike),
		source: "fallback",
	};
}

async function selectModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	contextSummary: string,
	explicitModel?: string,
	explicitEffort?: ThinkingLevel,
): Promise<Selection> {
	let requestedModel: Model<any> | undefined;
	let suffixEffort: ThinkingLevel | undefined;
	if (explicitModel) {
		const resolved = resolveRequestedModel(ctx, explicitModel);
		if (!resolved.model) throw new Error(resolved.error);
		requestedModel = resolved.model;
		suffixEffort = resolved.effort;
	}
	const requestedEffort = explicitEffort ?? suffixEffort;
	if (requestedModel && requestedEffort) {
		return {
			model: requestedModel,
			effort: clampThinkingLevel(requestedEffort, requestedModel as ModelLike),
			source: "explicit",
		};
	}

	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) return parentFallback(pi, ctx);
	const catalog = formatModelCatalog(available as ModelLike[]);
	const fixedChoice = [
		requestedModel ? `model=${requestedModel.provider}/${requestedModel.id}` : undefined,
		requestedEffort ? `effort=${requestedEffort}` : undefined,
	].filter(Boolean).join(", ");
	const classifierPrompt = `Classify the difficulty and complexity of a delegated coding-agent task, then choose the best authenticated model and reasoning effort from the exact catalog below. Balance capability, reliability, context needs, latency, and cost. Hard architecture, debugging, security, or broad implementation work generally deserves a stronger model and higher effort; simple lookups and mechanical edits do not. ${fixedChoice ? `The user fixed ${fixedChoice}; preserve those values and classify only what is missing. ` : ""}Return one JSON object only: {"model":"provider/id","effort":"off|minimal|low|medium|high|xhigh|max","rationale":"one short sentence"}.

Task:
${task}

Task-targeted context the child will receive:
${truncateMiddle(contextSummary, MAX_CLASSIFIER_CONTEXT_CHARS)}

Available authenticated models:
${catalog}`;
	try {
		const raw = await utilityCompletion(pi, ctx, classifierPrompt, 1_024);
		const decision = parseClassifierDecision(raw);
		if (!decision) throw new Error("Classifier did not return valid JSON.");
		const classified = resolveRequestedModel(ctx, decision.model);
		if (!classified.model) throw new Error(classified.error);
		const model = requestedModel ?? classified.model;
		const effort = requestedEffort ?? decision.effort;
		return {
			model,
			effort: clampThinkingLevel(effort, model as ModelLike),
			source: requestedModel || requestedEffort ? "explicit" : "classified",
			...(decision.rationale ? { rationale: decision.rationale } : {}),
		};
	} catch (error) {
		if (ctx.signal?.aborted) throw error;
		const fallback = parentFallback(pi, ctx);
		const model = requestedModel ?? fallback.model;
		const effort = requestedEffort ?? fallback.effort;
		return {
			model,
			effort: clampThinkingLevel(effort, model as ModelLike),
			source: requestedModel || requestedEffort ? "explicit" : "fallback",
			rationale: `Classifier unavailable; inherited parent settings (${error instanceof Error ? error.message : String(error)}).`,
		};
	}
}

function resolvePiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function childEnvironment(depth: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_INTERCOM_")) delete env[key];
	}
	env[DEPTH_ENV] = String(depth);
	return env;
}

function shortId(): string {
	return randomUUID().replaceAll("-", "").slice(0, 10);
}

function snapshotSummary(snapshot: ChildSnapshot): Omit<ChildSnapshot, "transcriptTail" | "stderr"> & { transcriptPreview?: string; stderrPreview?: string } {
	const { transcriptTail, stderr, ...rest } = snapshot;
	return {
		...rest,
		...(transcriptTail.trim() ? { transcriptPreview: truncateMiddle(transcriptTail.trim(), 1_000) } : {}),
		...(stderr ? { stderrPreview: truncateMiddle(stderr, 500) } : {}),
	};
}

function formatSnapshot(snapshot: ChildSnapshot): string {
	const age = Math.max(0, Math.round((Date.now() - snapshot.startedAt) / 1000));
	const lines = [
		`Subagent ${snapshot.id} (${snapshot.name})`,
		`state=${snapshot.state} model=${snapshot.model} effort=${snapshot.effort} age=${age}s turns=${snapshot.turns} tools=${snapshot.toolCalls} queued=${snapshot.pendingMessages}`,
		`selection=${snapshot.classification}${snapshot.classificationRationale ? ` — ${snapshot.classificationRationale}` : ""}`,
		`task: ${snapshot.task}`,
	];
	if (snapshot.sessionFile) lines.push(`session: ${snapshot.sessionFile}`);
	if (snapshot.error) lines.push(`error: ${snapshot.error}`);
	if (snapshot.stderr) lines.push(`stderr:\n${truncateMiddle(snapshot.stderr, 4_000)}`);
	if (snapshot.transcriptTail.trim()) lines.push(`transcript tail:\n${truncateMiddle(snapshot.transcriptTail.trim(), MAX_STATUS_TEXT_CHARS)}`);
	else lines.push("transcript tail: (no output yet)");
	return lines.join("\n");
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const children = new Map<string, ManagedSubagent>();
	let shuttingDown = false;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Create and control isolated, asynchronous child Pi sessions. Use action=create whenever the user naturally asks to create a subagent, ask a subagent to do work, or delegate work. Preserve any user-requested model and effort. Creation task-compacts the current parent context for that task, automatically classifies model/effort when either is omitted, and returns immediately with an id. Use status to spy on a direct child's transcript, steer to interrupt its direction at the next turn boundary, follow_up to queue later work, interrupt to abort the current operation while retaining the session, and stop to terminate it. Each process can see and control only children it created; child results never enter the parent context unless status is explicitly requested.",
		promptSnippet: "Create, inspect, steer, queue messages for, interrupt, or stop isolated asynchronous child Pi sessions",
		promptGuidelines: [
			"Use subagent with action=create when the user asks in natural language to create, ask, launch, or delegate to a subagent; pass through any explicit model and reasoning effort.",
			"Use subagent status to inspect child work; child completion is intentionally not pushed into the parent conversation.",
		],
		parameters: SubagentParameters,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "create") {
				if (!params.task?.trim()) throw new Error("Creating a subagent requires a non-empty task.");
				const depth = currentDepth();
				if (depth >= MAX_DEPTH) throw new Error(`Subagent depth limit (${MAX_DEPTH}) reached.`);
				const active = [...children.values()].filter((child) => !["stopped", "failed"].includes(child.snapshot().state));
				if (active.length >= MAX_ACTIVE_CHILDREN) {
					throw new Error(`This session already has ${MAX_ACTIVE_CHILDREN} active direct children; stop one before creating another.`);
				}

				const task = params.task.trim();
				const compacted = await compactContextForTask(pi, ctx, task);
				const selection = await selectModel(pi, ctx, task, compacted.summary, params.model, params.effort);
				const id = shortId();
				const name = params.name?.trim() || `subagent-${id}`;
				const parentSessionId = ctx.sessionManager.getSessionId() || "ephemeral";
				const sessionDir = join(getAgentDir(), "subagents", parentSessionId, id);
				await mkdir(sessionDir, { recursive: true, mode: 0o700 });
				const args = [
					"--mode", "rpc",
					"--session-dir", sessionDir,
					"--name", name,
					"--model", `${selection.model.provider}/${selection.model.id}`,
					"--thinking", selection.effort,
					"--extension", SELF_EXTENSION_PATH,
					ctx.isProjectTrusted() ? "--approve" : "--no-approve",
				];
				const invocation = resolvePiInvocation(args);
				const child = new ManagedSubagent({
					id,
					name,
					task,
					model: `${selection.model.provider}/${selection.model.id}`,
					effort: selection.effort,
					contextSummary: compacted.summary,
					cwd: ctx.cwd,
					command: invocation.command,
					args: invocation.args,
					env: childEnvironment(depth + 1),
					classification: selection.source,
					...(selection.rationale ? { classificationRationale: selection.rationale } : {}),
				});
				children.set(id, child);
				try {
					await child.start();
				} catch (error) {
					await child.stop();
					throw error;
				}
				const warning = compacted.fallback ? " Targeted compaction fell back to a bounded transcript." : "";
				return {
					content: [{ type: "text", text: `Created ${id} (${name}) with ${selection.model.provider}/${selection.model.id} at ${selection.effort} effort.${warning} It is running asynchronously; use subagent status with id=${id} to spy on it.` }],
					details: { action: "create", child: snapshotSummary(child.snapshot()), compactionFallback: compacted.fallback },
				};
			}

			if (params.action === "list") {
				const snapshots = [...children.values()].map((child) => snapshotSummary(child.snapshot()));
				const text = snapshots.length
					? snapshots.map((child) => `${child.id} ${child.state} ${child.model} ${child.effort} — ${child.task}`).join("\n")
					: "No direct subagents have been created by this session.";
				return { content: [{ type: "text", text }], details: { action: "list", children: snapshots } };
			}

			if (!params.id) throw new Error(`${params.action} requires a direct child id.`);
			const child = children.get(params.id);
			if (!child) throw new Error(`Unknown direct child '${params.id}'. Use subagent list to see children owned by this session.`);

			if (params.action === "status") {
				await child.refresh();
				const snapshot = child.snapshot();
				return { content: [{ type: "text", text: formatSnapshot(snapshot) }], details: { action: "status", child: snapshot } };
			}
			if (params.action === "steer" || params.action === "follow_up") {
				if (!params.task?.trim()) throw new Error(`${params.action} requires a non-empty task/message.`);
				if (params.action === "steer") await child.steer(params.task.trim());
				else await child.followUp(params.task.trim());
				return {
					content: [{ type: "text", text: `${params.action === "steer" ? "Steered" : "Queued a follow-up for"} ${params.id}.` }],
					details: { action: params.action, child: snapshotSummary(child.snapshot()) },
				};
			}
			if (params.action === "interrupt") {
				await child.interrupt();
				return { content: [{ type: "text", text: `Interrupted ${params.id}; its isolated session remains available for steering or follow-up.` }], details: { action: "interrupt", child: snapshotSummary(child.snapshot()) } };
			}
			await child.stop();
			return { content: [{ type: "text", text: `Stopped ${params.id}.` }], details: { action: "stop", child: snapshotSummary(child.snapshot()) } };
		},

		renderCall(args, theme) {
			const target = args.id ? ` ${args.id}` : args.name ? ` ${args.name}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.action)}${theme.fg("muted", target)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const content = result.content.find((entry) => entry.type === "text");
			return new Text(theme.fg("toolOutput", content?.type === "text" ? content.text : "(no output)"), 0, 0);
		},
	});

	pi.on("session_shutdown", async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		await Promise.allSettled([...children.values()].map((child) => child.stop()));
		children.clear();
	});
}
