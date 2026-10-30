import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

let streaming = false;
let prompts = 0;
let activeOperation = 0;
let abortFails = false;
let lateFinal = false;
let holdAbort = false;
/** @type {{ id: unknown } | undefined} */
let heldAbort;

/** @param {unknown} value */
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Prompt markers that make the mock die after writing a stderr diagnostic. */
const UNEXPECTED_EXITS = [
  { marker: "EXIT_UNEXPECTED", stderr: "mock child fatal diagnostic\n", exit: () => process.exit(17) },
  {
    marker: "SIGNAL_UNEXPECTED",
    stderr: "mock child signal diagnostic\n",
    exit: () => process.kill(process.pid, "SIGKILL"),
  },
];

/** @param {{ id: unknown }} command */
function handleAbort(command) {
  if (lateFinal) {
    // Deliver the completed operation before either abort outcome, without relying on timers.
    streaming = false;
    activeOperation++;
    send({ type: "agent_start" });
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "late-answer" }], stopReason: "stop" },
    });
    send({ type: "agent_settled" });
  }
  if (holdAbort) {
    heldAbort = command;
    return;
  }
  if (abortFails) {
    send({ id: command.id, type: "response", command: "abort", success: false, error: "mock abort failure" });
    return;
  }
  streaming = false;
  activeOperation++;
  send({ id: command.id, type: "response", command: "abort", success: true });
  send({ type: "agent_settled" });
}

/** @param {{ type: string, id: unknown, events?: unknown[], success?: boolean }} command */
function handleAbortTestControl(command) {
  if (command.type === "emit_events") {
    for (const event of command.events ?? []) send(event);
    send({ id: command.id, type: "response", success: true });
    return true;
  }
  if (command.type === "release_abort") {
    if (heldAbort) {
      send({
        id: heldAbort.id,
        type: "response",
        command: "abort",
        success: command.success,
        error: "mock abort failure",
      });
      heldAbort = undefined;
    }
    send({ id: command.id, type: "response", success: true });
    return true;
  }
  return false;
}

/** @param {{ type: string, id: unknown, message?: unknown }} command */
function handleQueue(command) {
  const message = String(command.message);
  if (message.includes("HOLD_QUEUE")) return;
  if (message.includes("REJECT_QUEUE")) {
    send({ id: command.id, type: "response", command: command.type, success: false, error: "mock queue rejection" });
    return;
  }
  if (message.includes("EXPAND_QUEUE")) {
    // Pi announces the transformed queue entry before acknowledging the request.
    const queued = [`expanded: ${message}`];
    send({
      type: "queue_update",
      steering: command.type === "steer" ? queued : [],
      followUp: command.type === "follow_up" ? queued : [],
    });
  }
  send({ id: command.id, type: "response", command: command.type, success: true, data: { disposition: "queued" } });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "extension_ui_response" || handleAbortTestControl(command)) return;
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { isStreaming: streaming, pendingMessageCount: 0, sessionFile: "/tmp/mock-child.jsonl" },
    });
    return;
  }
  if (command.type === "get_session_stats") {
    send({
      id: command.id,
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        tokens: { input: 100, output: 25, cacheRead: 50, cacheWrite: 0, total: 175 },
        cost: 0.0123,
        contextUsage: { tokens: 2_000, contextWindow: 100_000, percent: 2 },
      },
    });
    return;
  }
  if (command.type === "abort") {
    handleAbort(command);
    return;
  }
  if (command.type === "steer" || command.type === "follow_up") {
    handleQueue(command);
    return;
  }
  if (command.type === "timeout") {
    process.stderr.write("mock timeout diagnostic\n");
    return;
  }
  if (command.type === "prompt") {
    const unexpectedExit = UNEXPECTED_EXITS.find(({ marker }) => String(command.message).includes(marker));
    if (unexpectedExit) {
      process.stderr.write(unexpectedExit.stderr, unexpectedExit.exit);
      return;
    }
    prompts++;
    const promptNumber = prompts;
    const operation = ++activeOperation;
    streaming = true;
    abortFails = String(command.message).includes("ABORT_FAIL");
    lateFinal = String(command.message).includes("LATE_FINAL");
    holdAbort = String(command.message).includes("HOLD_ABORT");
    send({ id: command.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    if (String(command.message).includes("SLOW_WAIT")) {
      send({ type: "tool_execution_start", toolCallId: "slow-tool", toolName: "bash", args: { command: "sleep" } });
    }
    setTimeout(
      () => {
        if (operation !== activeOperation || !streaming || String(command.message).includes("HOLD_RUNNING")) return;
        if (String(command.message).includes("ABORTED_COMPACT")) {
          // An aborted compaction must not count toward the compaction total.
          send({ type: "compaction_end", aborted: true, result: undefined });
        } else if (String(command.message).includes("COMPACT")) {
          send({ type: "compaction_end", aborted: false, result: { tokensBefore: 10_000 } });
        }
        if (String(command.message).includes("LARGE_RPC_LINE")) {
          const text = `large:${"x".repeat(5 * 1024 * 1024)}`;
          send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
          send({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "large response accepted" }],
              stopReason: "stop",
            },
          });
          send({ type: "turn_end" });
        } else if (String(command.message).includes("SPAWN_DESCENDANT")) {
          const port = process.env.PI_TEST_DESCENDANT_PORT;
          const token = process.env.PI_TEST_DESCENDANT_TOKEN;
          if (!port || !token) throw new Error("Missing descendant test observer");
          const descendant = spawn(
            process.execPath,
            [fileURLToPath(new URL("./mock-rpc-descendant.mjs", import.meta.url)), port, token],
            { stdio: ["ignore", "ignore", "ignore", "ipc"] },
          );
          descendant.once("message", () => {
            const text = `descendant:${descendant.pid}`;
            send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
            send({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
            });
            send({ type: "turn_end" });
            streaming = false;
            send({ type: "agent_settled" });
          });
          return;
        } else if (String(command.message).includes("FAIL_MODEL")) {
          send({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "error", errorMessage: "mock model failure" },
          });
        } else if (String(command.message).includes("WORKING_THEN_EMPTY")) {
          send({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "working-note" }], stopReason: "toolUse" },
          });
          send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
          send({ type: "turn_end" });
        } else if (String(command.message).includes("EMPTY_LENGTH")) {
          send({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "length" },
          });
        } else {
          send({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: `answer-${promptNumber}` },
          });
          send({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `answer-${promptNumber}` }],
              stopReason: "stop",
            },
          });
          send({ type: "turn_end" });
        }
        if (String(command.message).includes("SLOW_WAIT")) {
          send({ type: "tool_execution_end", toolCallId: "slow-tool", toolName: "bash", isError: false });
        }
        streaming = false;
        send({ type: "agent_settled" });
      },
      String(command.message).includes("SLOW_WAIT") ? 150 : 15,
    );
  }
});
