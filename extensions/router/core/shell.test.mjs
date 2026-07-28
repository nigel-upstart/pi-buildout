import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReadOnlyShellCommand, readOnlyShellCommandRejection, tokenizeShellCommand } from "./shell.ts";

function reason(command) {
  const result = tokenizeShellCommand(command);
  assert.equal(result.ok, false, `expected ${JSON.stringify(command)} to be rejected`);
  return result.reason;
}

function argv(command) {
  const result = tokenizeShellCommand(command);
  assert.equal(result.ok, true, `expected ${JSON.stringify(command)} to tokenize`);
  return result.argv;
}

describe("tokenizeShellCommand", () => {
  it("rejects empty input", () => {
    assert.match(reason(""), /empty command/);
    assert.match(reason("   \t "), /empty command/);
  });

  it("rejects control characters that could hide a second command", () => {
    // Both lexers treat a newline as ordinary whitespace, so "ls\nrm -rf /" would otherwise lex to
    // one argv list whose first word is allowed.
    assert.match(reason("ls\nrm -rf /"), /control characters/);
    assert.match(reason("ls\rrm"), /control characters/);
    assert.match(reason("ls\u0000rm"), /control characters/);
    assert.deepEqual(argv("ls\tsrc"), ["ls", "src"], "a tab is plain whitespace");
  });

  it("rejects substitution before the lexer can silently expand it", () => {
    assert.match(reason("cat $(ls)"), /substitution/);
    assert.match(reason("echo `whoami`"), /substitution/);
    assert.match(reason("ls $HOME"), /substitution/);
    assert.match(reason("ls ${HOME}"), /substitution/);
  });

  it("rejects malformed quoting", () => {
    assert.match(reason('grep "unbalanced'), /malformed quoting/);
    assert.match(reason("grep 'unbalanced"), /malformed quoting/);
  });

  it("rejects every shell control operator", () => {
    for (const command of [
      "ls > out.txt",
      "ls >> out.txt",
      "wc -l < file",
      "grep foo file && rm -rf /",
      "grep foo file || true",
      "ls | xargs rm",
      "ls; rm -rf /",
      "ls &",
      "(ls)",
    ]) {
      assert.match(reason(command), /shell operator/, command);
    }
  });

  it("rejects comments rather than classifying a truncated command", () => {
    assert.match(reason("git diff # then rm -rf /"), /comments/);
    assert.match(reason("ls #x"), /comments/);
  });

  it("keeps quoted words, escapes, and globs as single arguments", () => {
    assert.deepEqual(argv("ls 'a b'"), ["ls", "a b"]);
    assert.deepEqual(argv('grep -e "-exec" .'), ["grep", "-e", "-exec", "."]);
    assert.deepEqual(argv("wc -l *.ts"), ["wc", "-l", "*.ts"], "a glob stays an argument of this command");
    assert.deepEqual(argv("ls \\; rm"), ["ls", ";", "rm"], "an escaped semicolon is data, not an operator");
    assert.deepEqual(argv("git log --format=%H"), ["git", "log", "--format=%H"]);
  });

  it("preserves an environment-assignment prefix as its own token for policy to reject", () => {
    assert.deepEqual(argv("FOO=bar ls"), ["FOO=bar", "ls"]);
  });
});

describe("isReadOnlyShellCommand", () => {
  it("permits the read-only inspection commands agents actually use", () => {
    for (const command of [
      "git diff --stat HEAD",
      "git diff --no-ext-diff --unified=1 HEAD --",
      "git diff --cached --name-only",
      "git status --porcelain",
      "git log --oneline -n 20",
      "git log -20 --format=%H",
      "git log --since '2 days ago' --author 'nobody'",
      "git show HEAD:extensions/router/index.ts",
      "git rev-parse --abbrev-ref HEAD",
      "git ls-files --others --exclude-standard",
      "rg -n 'safetyFingerprint' extensions",
      "rg --files -g '*.ts'",
      "rg -tpy pattern",
      "rg -C 2 --json pattern src",
      "grep -rn foo .",
      "grep -e '-exec' file",
      "grep --include=*.ts -R pattern .",
      "find . -name '*.ts' -maxdepth 3",
      "find . -type f -newermt '2026-01-01' -print0",
      "ls -la extensions/router",
      "pwd",
      "wc -l extensions/router/index.ts",
      "head -c 100 file",
      "head -20 file",
      "tail -n 5 file",
      "file extensions/router/index.ts",
      "wc -l *.ts",
    ]) {
      assert.equal(readOnlyShellCommandRejection(command), undefined, command);
      assert.equal(isReadOnlyShellCommand(command), true, command);
    }
  });

  it("refuses every option the previous denylist regex enumerated", () => {
    for (const command of [
      "git diff --output /tmp/leak",
      "git diff --output=/tmp/leak",
      "git diff --ext-diff",
      "git log --stat --ext-diff",
      "git diff --textconv",
      "rg --pre ./evil.sh pattern",
      "find . -delete",
      "find . -exec rm {} +",
      "find . -execdir rm {} +",
      "find . -ok rm {} +",
      "find . -okdir rm {} +",
      "find . -fprint out",
      "find . -fprintf out %p",
      "find . -fprint0 out",
      "find . -fls out",
      "find . -name x -delete -print",
      "head --output /tmp/leak file",
      "file --compile -m magic",
    ]) {
      assert.notEqual(readOnlyShellCommandRejection(command), undefined, command);
      assert.equal(isReadOnlyShellCommand(command), false, command);
    }
  });

  it("refuses write-capable options the denylist regex never enumerated", () => {
    // Each of these passed the old prefix+denylist gate because it neither matched a banned literal
    // nor introduced a shell metacharacter.
    for (const command of [
      "rg --hostname-bin /tmp/evil pattern",
      "rg --pre-glob '*.ts' pattern",
      "git log --name-only --output-indicator-new X",
      "git diff --exec-path=/tmp/evil",
      "ls --dired --hide=x",
      "tail -f /var/log/system.log",
    ]) {
      assert.equal(isReadOnlyShellCommand(command), false, command);
    }
  });

  it("refuses any binary, subcommand, or environment prefix outside the allowlist", () => {
    assert.match(readOnlyShellCommandRejection("cat file"), /cat is not a read-only command/);
    assert.match(readOnlyShellCommandRejection("npm test"), /npm is not a read-only command/);
    assert.match(readOnlyShellCommandRejection("FOO=bar ls"), /FOO=bar is not a read-only command/);
    assert.match(readOnlyShellCommandRejection("git commit -m x"), /git commit is not a read-only subcommand/);
    assert.match(readOnlyShellCommandRejection("git checkout main"), /git checkout is not a read-only subcommand/);
    assert.match(readOnlyShellCommandRejection("git"), /git requires a read-only subcommand/);
    // Top-level git options run before the subcommand is known, so none of them are permitted.
    assert.match(readOnlyShellCommandRejection("git -c core.pager=/tmp/x log"), /not a read-only subcommand/);
    assert.match(readOnlyShellCommandRejection("git -C /tmp diff"), /not a read-only subcommand/);
  });

  it("treats an option value as data rather than as another option", () => {
    assert.equal(isReadOnlyShellCommand("grep -e -delete file"), true, "-delete is grep's pattern here");
    assert.equal(isReadOnlyShellCommand("find . -name -fprintf"), true, "-fprintf is find's name pattern here");
    assert.equal(isReadOnlyShellCommand("find . -name x -fprintf out %p"), false, "but a real action is still refused");
    assert.equal(isReadOnlyShellCommand("rg -e --pre pattern"), true);
  });

  it("stops classifying options after a -- terminator", () => {
    assert.equal(isReadOnlyShellCommand("git diff -- --output"), true);
    assert.equal(isReadOnlyShellCommand("grep -n pattern -- -weird-file"), true);
  });

  it("inherits every tokenizer rejection", () => {
    for (const command of ["", "git diff && rm -rf /", "git diff | tee out", "ls\nrm -rf /", "git diff $(evil)"]) {
      assert.equal(isReadOnlyShellCommand(command), false, command);
    }
  });
});
