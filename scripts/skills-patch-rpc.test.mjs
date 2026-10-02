import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { applyPatchFile } from "./build-pi-patch.mjs";
import { findCleanPackage, patchDirectoryFor } from "./skills-patch-packages.mjs";

async function rpcSkills(entrypoint, args, { cwd, agentDir, home }) {
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
  for (const key of Object.keys(env).filter((key) => key.startsWith("GIT_"))) delete env[key];
  const child = spawn(process.execPath, [entrypoint, ...args, "--no-session", "--no-extensions"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timed out: ${stderr}`)), 20000);
      const finish = (error, commands) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(commands);
      };
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(new Error(`RPC exited ${code}: ${stderr}`)));
      lines.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id !== "skills-probe") return;
          assert.equal(response.success, true, JSON.stringify(response));
          finish(
            undefined,
            response.data.commands.filter((command) => command.source === "skill").map((command) => command.name),
          );
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.end(JSON.stringify({ id: "skills-probe", type: "get_commands" }) + "\n");
    });
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await closed;
    }
  }
}

test("pi 1.0.0: published CLI and RPC export preserve opt-in skills and explicit --skill with --no-skills", async (t) => {
  const { packageRoot, problem } = await findCleanPackage("1.0.0");
  if (!packageRoot) {
    t.skip(problem);
    return;
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-skills-rpc-"));
  try {
    const target = join(temporaryRoot, "package");
    const cwd = join(temporaryRoot, "project");
    const agentDir = join(temporaryRoot, "agent");
    const home = join(temporaryRoot, "home");
    await mkdir(target);
    await mkdir(cwd);
    await mkdir(home);
    await Promise.all([
      cp(join(packageRoot, "dist"), join(target, "dist"), { recursive: true }),
      cp(join(packageRoot, "docs"), join(target, "docs"), { recursive: true }),
      cp(join(packageRoot, "package.json"), join(target, "package.json")),
      symlink(join(packageRoot, "node_modules"), join(target, "node_modules"), "dir"),
    ]);
    assert.equal(applyPatchFile(join(patchDirectoryFor("1.0.0"), "skills.patch"), target), 0);
    for (const name of ["active", "catalog", "session"]) {
      const directory = join(agentDir, "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: RPC fixture ${name}\n---\n\n# ${name}\n`,
      );
    }
    await writeFile(join(agentDir, "skills.json"), JSON.stringify({ enabled: ["active"] }));
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    for (const [entrypoint, modeArgs] of [
      [manifest.bin.pi, ["--mode", "rpc"]],
      [manifest.exports["./rpc-entry"].import, []],
    ]) {
      const context = { cwd, agentDir, home };
      assert.deepEqual(await rpcSkills(join(target, entrypoint), modeArgs, context), ["skill:active"], entrypoint);
      assert.deepEqual(
        await rpcSkills(join(target, entrypoint), [...modeArgs, "--no-skills"], context),
        [],
        entrypoint,
      );
      assert.deepEqual(
        await rpcSkills(
          join(target, entrypoint),
          [...modeArgs, "--no-skills", "--skill", join(agentDir, "skills", "session")],
          context,
        ),
        ["skill:session"],
        entrypoint,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
