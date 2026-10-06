import { readFileSync } from "node:fs";
import { join } from "node:path";

const registry = "https://code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/";
const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const requested = process.env.npm_config_registry;
const tag = process.env.npm_config_tag;
if (
  manifest.publishConfig?.registry !== registry ||
  requested !== registry ||
  !/^\d+\.\d+\.\d+-alpha\.\d+$/.test(manifest.version) ||
  tag !== "alpha" ||
  process.env.PI_CODEARTIFACT_PUBLISH !== "1"
) {
  console.error(
    "Refusing publish: require the approved CodeArtifact registry, an alpha version, --tag alpha and PI_CODEARTIFACT_PUBLISH=1.",
  );
  process.exitCode = 1;
}
