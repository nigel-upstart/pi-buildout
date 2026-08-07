import { relative, sep } from "node:path";
import type { RouterMode } from "./lease.ts";

/**
 * The mode the router should be in when a session starts with no router state of its own.
 *
 * `last` means "whatever mode the router was in when it last stopped", which is the default because
 * an operator who turned routing on expects it to still be on after `/clear`, `/compact`, or the next
 * `pi` launch. The explicit modes exist for machines that must always start in a known state.
 */
export type RouterStartMode = RouterMode | "last";

const ROUTER_MODES: readonly RouterMode[] = ["off", "shadow", "active"];
const ROUTER_START_MODES: readonly RouterStartMode[] = [...ROUTER_MODES, "last"];

/** The mode used when the preference is `last` but nothing was ever recorded. */
export const UNKNOWN_LAST_MODE: RouterMode = "shadow";

export function parseRouterMode(value: unknown): RouterMode | undefined {
  return typeof value === "string" && ROUTER_MODES.includes(value as RouterMode) ? (value as RouterMode) : undefined;
}

export function parseStartMode(value: unknown): RouterStartMode | undefined {
  return typeof value === "string" && ROUTER_START_MODES.includes(value as RouterStartMode)
    ? (value as RouterStartMode)
    : undefined;
}

type StartModeSource = "env" | "repo" | "global" | "default";

export type StartModeInputs = {
  /** `PI_ROUTER_MODE`; malformed values are ignored rather than treated as an enablement request. */
  envMode?: unknown;
  /** `startMode` from the repository-scoped configuration entry for this repository. */
  repoStartMode?: unknown;
  /** `startMode` from the global configuration file. */
  globalStartMode?: unknown;
  /** The mode recorded the last time the router stopped, if any. */
  lastKnownMode?: unknown;
};

export type StartModeResolution = {
  mode: RouterMode;
  preference: RouterStartMode;
  source: StartModeSource;
  lastKnownMode: RouterMode | undefined;
};

/**
 * Resolves the session start mode from configuration and the recorded exit mode.
 *
 * Precedence is environment, then repository-scoped configuration, then global configuration, then
 * the built-in `last` default. Nothing here reads the filesystem so the precedence rule stays
 * testable independently of where the files live.
 */
export function resolveStartMode(inputs: StartModeInputs): StartModeResolution {
  const lastKnownMode = parseRouterMode(inputs.lastKnownMode);
  const candidates: readonly { preference: RouterStartMode | undefined; source: StartModeSource }[] = [
    { preference: parseStartMode(inputs.envMode), source: "env" },
    { preference: parseStartMode(inputs.repoStartMode), source: "repo" },
    { preference: parseStartMode(inputs.globalStartMode), source: "global" },
  ];
  const chosen = candidates.find((candidate) => candidate.preference !== undefined);
  const preference = chosen?.preference ?? "last";
  const source = chosen?.source ?? "default";
  return {
    preference,
    source,
    lastKnownMode,
    mode: preference === "last" ? (lastKnownMode ?? UNKNOWN_LAST_MODE) : preference,
  };
}

/**
 * Normalizes a git remote URL to a stable `host:path` identity so `git@github.com:org/repo.git`,
 * `https://github.com/org/repo`, and `ssh://git@github.com/org/repo.git` all key the same
 * configuration entry. Mirrors the repository-identity rule used by this repository's pi skills
 * patch so operators only have to learn one key format.
 */
export function normalizeGitRemoteUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  const url = rawUrl.trim().replace(/^git\+/, "");
  if (!url) return undefined;
  const scpLike = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(url);
  const scpHost = scpLike?.[1];
  const scpPath = scpLike?.[2];
  if (scpHost && scpPath && !url.includes("://")) {
    const repoPath = scpPath.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    return repoPath ? `${scpHost.toLowerCase()}:${repoPath}` : undefined;
  }
  try {
    const parsed = new URL(url);
    const repoPath = parsed.pathname.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    return parsed.hostname && repoPath ? `${parsed.hostname.toLowerCase()}:${repoPath}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fallback identity for a repository with no usable remote: the repository root, expressed relative
 * to the home directory when it lives under it so the key stays readable in configuration files.
 */
export function localRepoKey(root: string | undefined, home: string): string | undefined {
  if (!root) return undefined;
  const path = relative(home, root).split(sep).join("/");
  return path && !path.startsWith("..") && path !== "." ? `local:~/${path}` : `local:${root}`;
}
