import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { localRepoKey, normalizeGitRemoteUrl, parseStartMode, resolveStartMode } from "./start-mode.ts";

describe("parseStartMode", () => {
  it("accepts the three modes plus last and rejects anything else", () => {
    assert.equal(parseStartMode("off"), "off");
    assert.equal(parseStartMode("shadow"), "shadow");
    assert.equal(parseStartMode("active"), "active");
    assert.equal(parseStartMode("last"), "last");
    assert.equal(parseStartMode("ACTIVE"), undefined);
    assert.equal(parseStartMode("enabled"), undefined);
    assert.equal(parseStartMode(true), undefined);
    assert.equal(parseStartMode(undefined), undefined);
  });
});

describe("resolveStartMode", () => {
  it("defaults to the last recorded mode so routing stays enabled across sessions", () => {
    const resolution = resolveStartMode({ lastKnownMode: "active" });
    assert.deepEqual(resolution, {
      mode: "active",
      preference: "last",
      source: "default",
      lastKnownMode: "active",
    });
  });

  it("falls back to shadow when no mode was ever recorded", () => {
    assert.equal(resolveStartMode({}).mode, "shadow");
    assert.equal(resolveStartMode({ lastKnownMode: "enabled" }).mode, "shadow");
  });

  it("prefers the environment, then the repository entry, then the global file", () => {
    assert.deepEqual(
      resolveStartMode({
        envMode: "off",
        repoStartMode: "active",
        globalStartMode: "shadow",
        lastKnownMode: "active",
      }),
      { mode: "off", preference: "off", source: "env", lastKnownMode: "active" },
    );
    assert.deepEqual(resolveStartMode({ repoStartMode: "active", globalStartMode: "off", lastKnownMode: "shadow" }), {
      mode: "active",
      preference: "active",
      source: "repo",
      lastKnownMode: "shadow",
    });
    assert.deepEqual(resolveStartMode({ globalStartMode: "off", lastKnownMode: "active" }), {
      mode: "off",
      preference: "off",
      source: "global",
      lastKnownMode: "active",
    });
  });

  it("ignores malformed configuration instead of letting it decide enablement", () => {
    const resolution = resolveStartMode({
      envMode: "on",
      repoStartMode: 3,
      globalStartMode: null,
      lastKnownMode: "off",
    });
    assert.deepEqual(resolution, { mode: "off", preference: "last", source: "default", lastKnownMode: "off" });
  });

  it("lets a repository entry ask for the last recorded mode explicitly", () => {
    assert.deepEqual(resolveStartMode({ repoStartMode: "last", globalStartMode: "off", lastKnownMode: "active" }), {
      mode: "active",
      preference: "last",
      source: "repo",
      lastKnownMode: "active",
    });
  });
});

describe("normalizeGitRemoteUrl", () => {
  it("maps every spelling of one remote to a single repository identity", () => {
    const expected = "github.com:teamupstart/pi-buildout";
    assert.equal(normalizeGitRemoteUrl("git@github.com:teamupstart/pi-buildout.git"), expected);
    assert.equal(normalizeGitRemoteUrl("https://github.com/teamupstart/pi-buildout"), expected);
    assert.equal(normalizeGitRemoteUrl("https://GitHub.com/teamupstart/pi-buildout.git"), expected);
    assert.equal(normalizeGitRemoteUrl("ssh://git@github.com/teamupstart/pi-buildout.git"), expected);
    assert.equal(normalizeGitRemoteUrl("git+https://github.com/teamupstart/pi-buildout.git"), expected);
  });

  it("returns nothing for missing or unusable remotes", () => {
    assert.equal(normalizeGitRemoteUrl(undefined), undefined);
    assert.equal(normalizeGitRemoteUrl("   "), undefined);
    assert.equal(normalizeGitRemoteUrl("git@github.com:"), undefined);
    assert.equal(normalizeGitRemoteUrl("not a url"), undefined);
  });
});

describe("localRepoKey", () => {
  it("prefers a home-relative key and falls back to the absolute root", () => {
    assert.equal(localRepoKey("/home/dev/repos/tool", "/home/dev"), "local:~/repos/tool");
    assert.equal(localRepoKey("/srv/tool", "/home/dev"), "local:/srv/tool");
    assert.equal(localRepoKey("/home/dev", "/home/dev"), "local:/home/dev");
    assert.equal(localRepoKey(undefined, "/home/dev"), undefined);
  });
});
