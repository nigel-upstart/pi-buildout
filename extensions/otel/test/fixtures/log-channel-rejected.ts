// Must NOT typecheck: both names are emitted by SpanTracker when the span ends,
// so emitting them here would record the same failure twice.
import { createLogChannelEmitter } from "../../src/otel/logs.js";

const emitLog = createLogChannelEmitter(() => {});

emitLog({ eventName: "pi.tool.error", severity: "error", body: "duplicate" });
emitLog({ eventName: "pi.llm_request.error", severity: "error", body: "duplicate" });
