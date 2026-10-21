// Module resolution hook for the scheduled Pi contract canary. Loaded with `--import`, it resolves every
// Pi package and Pi's own `typebox` from the isolated fixture prefix named by PI_CONTRACT_FIXTURE, as a
// Pi host would supply them to an extension. Repository development dependencies therefore cannot
// shadow the Pi version under test. Resolution inside the fixture itself is left unchanged.
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = process.env.PI_CONTRACT_FIXTURE;
if (!prefix) throw new Error("PI_CONTRACT_FIXTURE must name the isolated Pi fixture prefix");
const fixtureModules = pathToFileURL(join(resolve(prefix), "node_modules") + "/").href;
const anchor = new URL("@earendil-works/pi-coding-agent/package.json", fixtureModules).href;
const hostProvided = /^(?:@earendil-works\/[^/]+|typebox)(?:\/|$)/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!hostProvided.test(specifier) || context.parentURL?.startsWith(fixtureModules))
      return nextResolve(specifier, context);
    return nextResolve(specifier, { ...context, parentURL: anchor });
  },
});
