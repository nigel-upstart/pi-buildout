import { parse } from "shell-quote";
import type { ParseEntry } from "shell-quote";
import { split } from "shlex";

/**
 * Tokenization of a `bash` tool command into a single simple command's argv.
 *
 * The read-only gate this feeds cannot be expressed safely as a regex over raw command text: a
 * pattern either under-matches (`-fprint` missing `-fprintf`) or over-matches quoted data
 * (`grep -e '-exec' .`). So the command is lexed first and every policy question is then asked about
 * argv, where a flag is a flag and a quoted string is data.
 *
 * Two libraries are used deliberately, because each covers a gap in the other:
 *   - `shell-quote`'s `parse` classifies control operators, globs, and comments as structured
 *     entries, which is what makes "contains no shell operator" decidable. It silently accepts
 *     unbalanced quotes.
 *   - `shlex`'s `split` throws on unbalanced quotes, which is the malformed-input signal
 *     `shell-quote` lacks.
 *
 * Both treat a newline as ordinary whitespace, so `ls\nrm -rf /` lexes to a single argv list. That
 * would hide a second command behind an allowed first word, so control characters are rejected on
 * the raw string before either lexer runs. `$` and backticks are rejected for the same reason:
 * `shell-quote` expands `$FOO` to an empty token rather than reporting a substitution.
 */
export type ShellTokenization = { ok: true; argv: readonly string[] } | { ok: false; reason: string };

const SUBSTITUTION = /[$`]/;
const TAB = 0x09;
const DELETE = 0x7f;
const FIRST_PRINTABLE = 0x20;

/** Tab is the only control character that is plain whitespace inside a single command. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === TAB) continue;
    if (code < FIRST_PRINTABLE || code === DELETE) return true;
  }
  return false;
}

function rejectedStructure(entry: Exclude<ParseEntry, string>): string {
  if ("comment" in entry) return "commands with comments are not classifiable";
  return `shell operator ${entry.op} is not allowed in a read-only command`;
}

export function tokenizeShellCommand(command: string): ShellTokenization {
  const normalized = command.trim();
  if (normalized.length === 0) return { ok: false, reason: "empty command" };
  if (hasControlCharacter(normalized)) {
    return { ok: false, reason: "control characters can hide a second command" };
  }
  if (SUBSTITUTION.test(normalized)) {
    return { ok: false, reason: "command or parameter substitution is not allowed" };
  }
  try {
    split(normalized);
  } catch {
    return { ok: false, reason: "malformed quoting" };
  }
  let entries: ParseEntry[];
  try {
    entries = parse(normalized);
  } catch {
    return { ok: false, reason: "unparsable command" };
  }
  const argv: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      argv.push(entry);
      continue;
    }
    // A glob is expanded by the shell into arguments of this same command, so it stays data.
    if ("op" in entry && entry.op === "glob") {
      argv.push(entry.pattern);
      continue;
    }
    return { ok: false, reason: rejectedStructure(entry) };
  }
  if (argv.length === 0) return { ok: false, reason: "no command word" };
  return { ok: true, argv };
}
