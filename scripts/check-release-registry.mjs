import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { REGISTRY, validateReleaseManifest } from "./release-packages.mjs";

const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const requested = process.env.npm_config_registry;
const tag = process.env.npm_config_tag;
try {
  validateReleaseManifest(basename(process.cwd()).replace(/^pi-/, ""), manifest);
  if (requested !== REGISTRY || tag !== "alpha" || process.env.PI_CODEARTIFACT_PUBLISH !== "1") {
    throw new Error("require the approved CodeArtifact registry, --tag alpha and PI_CODEARTIFACT_PUBLISH=1");
  }
} catch (error) {
  console.error(`Refusing publish: ${error.message}`);
  process.exitCode = 1;
}
