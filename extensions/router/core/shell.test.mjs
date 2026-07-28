import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenizeShellCommand } from "./shell.ts";

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
