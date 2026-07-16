import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { extractTextContent, appendBoundedTail, type ThinkingLevel } from "./helpers.ts";

const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_STDERR_CHARS = 64_000;
const REQUEST_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 3_000;

export type ChildState = "starting" | "running" | "idle" | "interrupting" | "stopped" | "failed";

export interface ChildLaunchOptions {
	id: string;
	name: string;
	task: string;
	model: string;
	effort: ThinkingLevel;
	contextSummary: string;
	cwd: string;
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	classification: "explicit" | "classified" | "fallback";
	classificationRationale?: string;
}

export interface ChildSnapshot {
	id: string;
	name: string;
	task: string;
	state: ChildState;
	model: string;
	effort: ThinkingLevel;
	classification: ChildLaunchOptions["classification"];
	classificationRationale?: string;
	pid?: number;
	startedAt: number;
	updatedAt: number;
	turns: number;
	toolCalls: number;
	pendingMessages: number;
	sessionFile?: string;
	lastAssistantText?: string;
	transcriptTail: string;
	stderr?: string;
	error?: string;
}

interface PendingRequest {
	command: string;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class ManagedSubagent {
	readonly id: string;
	readonly name: string;
	readonly task: string;
	readonly model: string;
	readonly effort: ThinkingLevel;
	readonly classification: ChildLaunchOptions["classification"];
	readonly classificationRationale?: string;
	readonly startedAt = Date.now();

	private readonly proc: ChildProcessWithoutNullStreams;
	private state: ChildState = "starting";
	private updatedAt = Date.now();
	private transcript = "";
	private stderr = "";
	private error?: string;
	private lastAssistantText?: string;
	private sessionFile?: string;
	private pendingMessages = 0;
	private turns = 0;
	private toolCalls = 0;
	private requestSequence = 0;
	private pending = new Map<string, PendingRequest>();
	private stdoutBytes = 0;
	private stdoutLine = "";
	private stoppedIntentionally = false;
	private readonly options: ChildLaunchOptions;

	constructor(options: ChildLaunchOptions) {
		this.options = options;
		this.id = options.id;
		this.name = options.name;
		this.task = options.task;
		this.model = options.model;
		this.effort = options.effort;
		this.classification = options.classification;
		this.classificationRationale = options.classificationRationale;
		this.proc = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.attachStreams();
	}

	async start(): Promise<void> {
		const kickoff = [
			"Task-targeted compacted context from the requesting session:",
			"<context>",
			this.options.contextSummary.trim() || "No prior context was relevant.",
			"</context>",
			"",
			"Task:",
			this.task,
		].join("\n");
		await this.request({ type: "prompt", message: kickoff });
		if (this.state === "starting") this.state = "running";
		this.touch();
	}

	async steer(message: string): Promise<void> {
		this.assertControllable();
		if (this.state === "running" || this.state === "interrupting") {
			await this.request({ type: "steer", message });
		} else {
			await this.request({ type: "prompt", message });
			this.state = "running";
		}
		this.touch();
	}

	async followUp(message: string): Promise<void> {
		this.assertControllable();
		if (this.state === "running" || this.state === "interrupting") {
			await this.request({ type: "follow_up", message });
		} else {
			await this.request({ type: "prompt", message });
			this.state = "running";
		}
		this.touch();
	}

	async interrupt(): Promise<void> {
		this.assertControllable();
		this.state = "interrupting";
		this.touch();
		await this.request({ type: "abort" });
	}

	async refresh(): Promise<void> {
		if (this.state === "stopped" || this.state === "failed") return;
		try {
			const response = await this.request({ type: "get_state" }, 3_000);
			const data = response.data as Record<string, unknown> | undefined;
			if (!data) return;
			this.pendingMessages = typeof data.pendingMessageCount === "number" ? data.pendingMessageCount : this.pendingMessages;
			this.sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : this.sessionFile;
			if (data.isStreaming === true) this.state = "running";
			else if (this.state !== "starting") this.state = "idle";
			this.touch();
		} catch {
			// Cached state remains useful if a refresh races process shutdown.
		}
	}

	async stop(): Promise<void> {
		if (this.state === "stopped") return;
		this.stoppedIntentionally = true;
		try {
			if (this.state !== "failed") await this.request({ type: "abort" }, 1_000);
		} catch {
			// Process termination below is authoritative.
		}
		this.proc.kill("SIGTERM");
		const timer = setTimeout(() => {
			if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
		}, FORCE_KILL_DELAY_MS);
		timer.unref();
		this.state = "stopped";
		this.touch();
	}

	snapshot(): ChildSnapshot {
		return {
			id: this.id,
			name: this.name,
			task: this.task,
			state: this.state,
			model: this.model,
			effort: this.effort,
			classification: this.classification,
			...(this.classificationRationale ? { classificationRationale: this.classificationRationale } : {}),
			...(this.proc.pid ? { pid: this.proc.pid } : {}),
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
			turns: this.turns,
			toolCalls: this.toolCalls,
			pendingMessages: this.pendingMessages,
			...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
			...(this.lastAssistantText ? { lastAssistantText: this.lastAssistantText } : {}),
			transcriptTail: this.transcript,
			...(this.stderr.trim() ? { stderr: this.stderr.trim() } : {}),
			...(this.error ? { error: this.error } : {}),
		};
	}

	private assertControllable(): void {
		if (this.state === "stopped" || this.state === "failed") {
			throw new Error(`Subagent ${this.id} is ${this.state} and cannot accept messages.`);
		}
	}

	private touch(): void {
		this.updatedAt = Date.now();
	}

	private appendTranscript(text: string): void {
		this.transcript = appendBoundedTail(this.transcript, text, MAX_TRANSCRIPT_CHARS);
		this.touch();
	}

	private request(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
		if (this.proc.stdin.destroyed || this.proc.exitCode !== null) {
			return Promise.reject(new Error(`Subagent ${this.id} process is not running.`));
		}
		const id = `${this.id}-${++this.requestSequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for subagent RPC command ${String(command.type)}.`));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, { command: String(command.type), resolve, reject, timer });
			this.proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(error);
			});
		});
	}

	private attachStreams(): void {
		const decoder = new StringDecoder("utf8");
		this.proc.stdout.on("data", (chunk: Buffer) => {
			const text = decoder.write(chunk);
			for (const char of text) {
				if (char === "\n") {
					const line = this.stdoutLine.endsWith("\r") ? this.stdoutLine.slice(0, -1) : this.stdoutLine;
					this.stdoutLine = "";
					this.stdoutBytes = 0;
					if (line) this.handleLine(line);
					continue;
				}
				this.stdoutLine += char;
				this.stdoutBytes += Buffer.byteLength(char);
				if (this.stdoutBytes > MAX_JSONL_LINE_BYTES) {
					this.fail("Child RPC output exceeded the 4 MiB JSONL line limit.");
					this.proc.kill("SIGTERM");
					return;
				}
			}
		});
		this.proc.stdout.on("end", () => {
			const final = this.stdoutLine + decoder.end();
			if (final.trim()) this.handleLine(final.endsWith("\r") ? final.slice(0, -1) : final);
		});
		this.proc.stderr.on("data", (chunk: Buffer) => {
			this.stderr = appendBoundedTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_CHARS);
			this.touch();
		});
		this.proc.on("error", (error) => this.fail(error.message));
		this.proc.on("close", (code, signal) => {
			if (this.stoppedIntentionally) this.state = "stopped";
			else if (this.state !== "failed") this.fail(`Child process exited (${signal ?? code ?? "unknown"}).`);
			this.rejectPending(new Error(this.error ?? "Subagent process closed."));
			this.touch();
		});
		this.proc.stdin.on("error", () => {
			// Pending requests and process close report actionable errors.
		});
	}

	private handleLine(line: string): void {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.appendTranscript(`\n[rpc parse error] ${line.slice(0, 500)}\n`);
			return;
		}
		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(event.id);
			if (event.success === false) pending.reject(new Error(typeof event.error === "string" ? event.error : `${pending.command} failed.`));
			else pending.resolve(event);
			return;
		}
		if (event.type === "extension_ui_request" && typeof event.id === "string") {
			const method = event.method;
			if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
				this.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
				this.appendTranscript(`\n[extension dialog cancelled: ${String(method)}]\n`);
			}
			return;
		}
		this.handleEvent(event);
	}

	private handleEvent(event: Record<string, unknown>): void {
		switch (event.type) {
			case "agent_start":
				this.state = "running";
				break;
			case "agent_settled":
				if (this.state !== "failed" && this.state !== "stopped") this.state = "idle";
				break;
			case "turn_end":
				this.turns++;
				break;
			case "queue_update": {
				const steering = Array.isArray(event.steering) ? event.steering.length : 0;
				const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
				this.pendingMessages = steering + followUp;
				break;
			}
			case "message_update": {
				const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
				if (delta?.type === "text_delta" && typeof delta.delta === "string") this.appendTranscript(delta.delta);
				break;
			}
			case "message_end": {
				const message = event.message as Record<string, unknown> | undefined;
				if (message?.role === "assistant") {
					const text = extractTextContent(message.content);
					if (text) this.lastAssistantText = appendBoundedTail("", text, MAX_TRANSCRIPT_CHARS);
					if (message.stopReason === "error") {
						this.fail(typeof message.errorMessage === "string" ? message.errorMessage : "Child model returned an error.");
					}
				}
				break;
			}
			case "tool_execution_start":
				this.toolCalls++;
				this.appendTranscript(`\n→ ${String(event.toolName ?? "tool")} ${JSON.stringify(event.args ?? {}).slice(0, 500)}\n`);
				break;
			case "tool_execution_end":
				this.appendTranscript(`\n← ${String(event.toolName ?? "tool")}${event.isError === true ? " (error)" : ""}\n`);
				break;
			case "extension_error":
				this.appendTranscript(`\n[extension error] ${String(event.error ?? "unknown")}\n`);
				break;
		}
		this.touch();
	}

	private fail(message: string): void {
		this.state = "failed";
		this.error = message;
		this.touch();
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
}
