// Must typecheck: names this extension owns, plus a runtime-chosen name from the
// extensibility API.
import { createLogChannelEmitter } from "../../src/otel/logs.js";

const emitLog = createLogChannelEmitter(() => {});

emitLog({ eventName: "pi.session.start", severity: "info", body: "started" });
emitLog({ eventName: "pi.session.end", severity: "info", body: "ended" });

const fromAnotherPackage: string = "some-package.something";
emitLog({ eventName: fromAnotherPackage, body: "forwarded" });
