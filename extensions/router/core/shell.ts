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

type ShellLex = { ok: true; entries: ParseEntry[] } | { ok: false; reason: string };

/** Raw-string rejections shared by single-command and compound-command classification. */
function lexShellCommand(command: string): ShellLex {
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
  try {
    return { ok: true, entries: parse(normalized) };
  } catch {
    return { ok: false, reason: "unparsable command" };
  }
}

export function tokenizeShellCommand(command: string): ShellTokenization {
  const lexed = lexShellCommand(command);
  if (!lexed.ok) return lexed;
  const entries = lexed.entries;
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

type ShellSegmentation = { ok: true; segments: readonly (readonly string[])[] } | { ok: false; reason: string };

/**
 * Operators that only sequence or connect commands. Each side is still classified on its own, so
 * `a && b` is exactly as safe as running `a` and then `b`, and `a | b` feeds `b` data it cannot
 * execute unless `b` itself is an executing binary, which the per-command allowlist refuses.
 */
const SEQUENCING_OPERATORS = new Set(["&&", "||", ";", "|"]);
const SILENCED_DESCRIPTOR = /^[12]$/;

/**
 * Split a compound command into simple commands at sequencing operators.
 *
 * Everything `tokenizeShellCommand` rejects on the raw string is still rejected. The only
 * redirections accepted are the ones that cannot create or change a file: output discarded to
 * `/dev/null`, and one standard descriptor duplicated onto the other (`2>&1`). Background `&`,
 * `|&`, subshells, process substitution, input redirection, and every other file redirection stay
 * refused.
 */
function segmentShellCommand(command: string): ShellSegmentation {
  const lexed = lexShellCommand(command);
  if (!lexed.ok) return lexed;
  const entries = lexed.entries;
  const segments: string[][] = [];
  let current: string[] = [];
  // A harmless redirection consumes its target word, which is then skipped.
  let skipThrough = 0;
  for (const [index, entry] of entries.entries()) {
    if (index < skipThrough) continue;
    if (typeof entry === "string") {
      current.push(entry);
      continue;
    }
    if ("op" in entry && entry.op === "glob") {
      current.push(entry.pattern);
      continue;
    }
    if ("op" in entry && SEQUENCING_OPERATORS.has(entry.op)) {
      if (current.length === 0) return { ok: false, reason: `shell operator ${entry.op} has no command before it` };
      segments.push(current);
      current = [];
      continue;
    }
    if ("op" in entry && (entry.op === ">" || entry.op === ">>" || entry.op === ">&")) {
      const target = entries[index + 1];
      const harmless =
        typeof target === "string" && (entry.op === ">&" ? SILENCED_DESCRIPTOR.test(target) : target === "/dev/null");
      if (!harmless) return { ok: false, reason: rejectedStructure(entry) };
      // `2>/dev/null` lexes as the word `2` followed by the redirection, but so does
      // `git branch 2 > /dev/null`, where `2` is a branch name: the lexer drops the whitespace that
      // tells them apart. The digit therefore stays an argument, so a descriptor can only make a
      // command look less read-only, never more.
      skipThrough = index + 2;
      continue;
    }
    return { ok: false, reason: rejectedStructure(entry) };
  }
  if (current.length === 0) {
    return { ok: false, reason: segments.length === 0 ? "no command word" : "command ends with a shell operator" };
  }
  segments.push(current);
  return { ok: true, segments };
}

/**
 * What a single read-only binary is allowed to be told to do.
 *
 * The policy is a closed allowlist rather than a denylist of dangerous options, because the failure
 * modes are asymmetric: a missing allowlist entry blocks a legitimate inspection and the model is
 * told why, whereas a missing denylist entry silently permits a write. `find`'s `-fprintf`,
 * `-fprint0`, and `-fls` were exactly that kind of denylist gap.
 */
type BinaryPolicy = {
  /** When present, the first argument must be one of these, preceded only by `preSubcommandFlags`. */
  readonly subcommands?: readonly string[];
  /** The only options permitted before a subcommand, because they reduce rather than add side effects. */
  readonly preSubcommandFlags?: readonly string[];
  /** Pre-subcommand options whose value is the following argument. */
  readonly preSubcommandValueFlags?: readonly string[];
  /**
   * Subcommands that are read-only only in some forms. The rule receives every argument after the
   * subcommand and replaces the shared option check for that subcommand.
   */
  readonly subcommandRules?: Readonly<Record<string, (args: readonly string[]) => string | undefined>>;
  /** Permitted `--long` options, without any `=value` suffix. */
  readonly longFlags: readonly string[];
  /** Permitted single-dash words, such as `find`'s predicates. */
  readonly singleDashWords?: readonly string[];
  /** Permitted single-letter options, usable individually or in a cluster. */
  readonly shortLetters?: string;
  /** Options whose value is the following argument, so that value is not classified as an option. */
  readonly valueFlags?: readonly string[];
  /** Single letters whose value may follow inline (`-n5`) or as the next argument. */
  readonly valueLetters?: string;
  /** Whether `-5` style numeric shorthand is accepted, as `head`/`tail`/`git log` accept it. */
  readonly numericShorthand?: boolean;
};

// `git branch` lists, creates, renames, and deletes through the same entry point. Only listing
// options are permitted, and a branch-name operand only where git treats it as a list pattern or a
// commit filter; `git branch name` with no such option creates a branch and is refused.
const GIT_BRANCH_LIST_LONG_FLAGS = [
  "--all",
  "--color",
  "--column",
  "--contains",
  "--format",
  "--ignore-case",
  "--list",
  "--merged",
  "--no-color",
  "--no-column",
  "--no-contains",
  "--no-merged",
  "--points-at",
  "--remotes",
  "--show-current",
  "--sort",
  "--verbose",
];
const GIT_BRANCH_OPERAND_FLAGS = ["--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"];

function gitBranchRejection(args: readonly string[]): string | undefined {
  let operandsAllowed = false;
  let operandSeen = false;
  for (const token of args) {
    if (token === "--") return "git branch -- is not a read-only listing form";
    if (token.startsWith("--")) {
      const flag = optionName(token).flag;
      if (!GIT_BRANCH_LIST_LONG_FLAGS.includes(flag)) return `git branch ${flag} is not a read-only listing option`;
      if (GIT_BRANCH_OPERAND_FLAGS.includes(flag)) operandsAllowed = true;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      for (const letter of token.slice(1)) {
        if (!"arvli".includes(letter)) return `git branch -${letter} is not a read-only listing option`;
        if (letter === "l") operandsAllowed = true;
      }
      continue;
    }
    operandSeen = true;
  }
  return operandSeen && !operandsAllowed
    ? "git branch with a branch name creates a branch; use --list or -l to filter"
    : undefined;
}

function gitStashRejection(args: readonly string[]): string | undefined {
  const [action, ...rest] = args;
  if (action !== "list" && action !== "show") return `git stash ${action ?? ""} is not a read-only stash form`.trim();
  return optionRejection(rest, GIT_POLICY);
}

function gitRemoteRejection(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.every((token) => token === "-v" || token === "--verbose")) return undefined;
  if (args[0] === "get-url" && args.slice(1).every((token) => !token.startsWith("-") || token === "--all")) {
    return undefined;
  }
  return "git remote is read-only only as a listing or get-url";
}

// Deliberately excluded from `git`: every other top-level option (`-c`, `--exec-path`,
// `--paginate`), `--output`/`-o` (writes a file), and `--ext-diff`/`--textconv` (run external
// programs). `-C <dir>` is permitted because it is exactly `cd <dir> && git ...`.
const GIT_POLICY: BinaryPolicy = {
  subcommands: [
    "diff",
    "status",
    "show",
    "log",
    "rev-parse",
    "ls-files",
    "merge-base",
    "rev-list",
    "branch",
    "stash",
    "remote",
  ],
  // `git status` and `git diff` may refresh the index and start a pager or fsmonitor. Neither changes
  // tracked content, so they stay permitted, but the two options that suppress those effects are
  // allowed in the one position git accepts them.
  preSubcommandFlags: ["--no-optional-locks", "--no-pager"],
  preSubcommandValueFlags: ["-C"],
  subcommandRules: { branch: gitBranchRejection, stash: gitStashRejection, remote: gitRemoteRejection },
  longFlags: [
    "--abbrev",
    "--abbrev-commit",
    "--abbrev-ref",
    "--all",
    "--author",
    "--binary",
    "--branch",
    "--branches",
    "--cached",
    "--check",
    "--color",
    "--count",
    "--date",
    "--decorate",
    "--deleted",
    "--diff-algorithm",
    "--diff-filter",
    "--dirstat",
    "--exclude-standard",
    "--exit-code",
    "--find-copies",
    "--find-renames",
    "--first-parent",
    "--follow",
    "--format",
    "--full-index",
    "--function-context",
    "--git-dir",
    "--graph",
    "--grep",
    "--histogram",
    "--ignore-all-space",
    "--ignore-space-change",
    "--ignored",
    "--is-inside-work-tree",
    "--max-count",
    "--merges",
    "--minimal",
    "--modified",
    "--name-only",
    "--name-status",
    "--no-abbrev-commit",
    "--no-color",
    "--no-decorate",
    "--no-ext-diff",
    "--no-merges",
    "--no-patch",
    "--no-renames",
    "--no-textconv",
    "--numstat",
    "--oneline",
    "--others",
    "--patch",
    "--patience",
    "--porcelain",
    "--pretty",
    "--raw",
    "--relative",
    "--remotes",
    "--reverse",
    "--short",
    "--shortstat",
    "--show-toplevel",
    "--since",
    "--skip",
    "--stage",
    "--stat",
    "--staged",
    "--summary",
    "--symbolic-full-name",
    "--tags",
    "--text",
    "--unified",
    "--until",
    "--untracked-files",
    "--verify",
    "--word-diff",
  ],
  shortLetters: "bBcCdDgilmMprRstuvwz123",
  valueFlags: ["--author", "--date", "--diff-algorithm", "--format", "--grep", "--pretty", "--since", "--until"],
  valueLetters: "nUSGLO",
  numericShorthand: true,
};

// Deliberately excluded from `rg`: `--pre`, `--pre-glob`, and `--hostname-bin`, which execute a
// program the model names. `--no-config` is permitted so a caller can also neutralize a `--pre`
// arriving from an ambient RIPGREP_CONFIG_PATH; it is not required, because this module classifies
// commands rather than issuing them, and setting that variable needs an assignment prefix or an
// export this gate already refuses.
const RIPGREP_POLICY: BinaryPolicy = {
  longFlags: [
    "--no-config",
    "--after-context",
    "--before-context",
    "--case-sensitive",
    "--color",
    "--column",
    "--context",
    "--count",
    "--count-matches",
    "--files",
    "--files-with-matches",
    "--files-without-match",
    "--fixed-strings",
    "--glob",
    "--heading",
    "--hidden",
    "--iglob",
    "--ignore-case",
    "--invert-match",
    "--json",
    "--line-number",
    "--max-columns",
    "--max-count",
    "--max-depth",
    "--multiline",
    "--no-heading",
    "--no-ignore",
    "--no-line-number",
    "--no-messages",
    "--only-matching",
    "--pretty",
    "--regexp",
    "--smart-case",
    "--sort",
    "--stats",
    "--trim",
    "--type",
    "--type-not",
    "--vimgrep",
    "--with-filename",
    "--word-regexp",
  ],
  shortLetters: "cFHiLlNnoPsSTuvwxz",
  valueFlags: [
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--iglob",
    "--max-columns",
    "--max-count",
    "--max-depth",
    "--regexp",
    "--sort",
    "--type",
    "--type-not",
  ],
  valueLetters: "ABCegmt",
};

const GREP_POLICY: BinaryPolicy = {
  longFlags: [
    "--after-context",
    "--before-context",
    "--byte-offset",
    "--color",
    "--colour",
    "--context",
    "--count",
    "--exclude",
    "--exclude-dir",
    "--extended-regexp",
    "--fixed-strings",
    "--include",
    "--ignore-case",
    "--invert-match",
    "--line-number",
    "--files-with-matches",
    "--files-without-match",
    "--max-count",
    "--no-filename",
    "--no-messages",
    "--only-matching",
    "--recursive",
    "--regexp",
    "--with-filename",
    "--word-regexp",
  ],
  shortLetters: "abcEFGHhIiLlnoqRrsvwxz",
  valueFlags: [
    "--after-context",
    "--before-context",
    "--context",
    "--exclude",
    "--exclude-dir",
    "--include",
    "--max-count",
    "--regexp",
  ],
  valueLetters: "ABCem",
};

// `find` is the reason this module exists: its action predicates run commands (`-exec`, `-execdir`,
// `-ok`, `-okdir`), delete files (`-delete`), or write files (`-fprint`, `-fprintf`, `-fprint0`,
// `-fls`). None of them appear below, and anything not listed is refused.
const FIND_POLICY: BinaryPolicy = {
  longFlags: [],
  singleDashWords: [
    "-a",
    "-and",
    "-depth",
    "-empty",
    "-executable",
    "-false",
    "-follow",
    "-group",
    "-iname",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-links",
    "-ls",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mtime",
    "-name",
    "-newer",
    "-newermt",
    "-nogroup",
    "-not",
    "-nouser",
    "-o",
    "-or",
    "-path",
    "-perm",
    "-print",
    "-print0",
    "-prune",
    "-quit",
    "-readable",
    "-regex",
    "-regextype",
    "-size",
    "-true",
    "-type",
    "-user",
    "-wholename",
    "-writable",
    "-xdev",
  ],
  valueFlags: [
    "-group",
    "-iname",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-links",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mtime",
    "-name",
    "-newer",
    "-newermt",
    "-path",
    "-perm",
    "-regex",
    "-regextype",
    "-size",
    "-type",
    "-user",
    "-wholename",
  ],
};

const READ_ONLY_BINARIES: Readonly<Record<string, BinaryPolicy>> = {
  git: GIT_POLICY,
  rg: RIPGREP_POLICY,
  grep: GREP_POLICY,
  find: FIND_POLICY,
  ls: {
    longFlags: ["--all", "--almost-all", "--color", "--human-readable", "--recursive", "--reverse", "--sort"],
    shortLetters: "1aAcCdfFghHilLnoprRStuU",
    valueFlags: ["--sort"],
  },
  pwd: { longFlags: ["--logical", "--physical"], shortLetters: "LP" },
  wc: { longFlags: ["--bytes", "--chars", "--lines", "--max-line-length", "--words"], shortLetters: "clLmw" },
  head: {
    longFlags: ["--bytes", "--lines", "--quiet", "--verbose"],
    shortLetters: "qv",
    valueLetters: "cn",
    valueFlags: ["--bytes", "--lines"],
    numericShorthand: true,
  },
  tail: {
    longFlags: ["--bytes", "--lines", "--quiet", "--verbose"],
    shortLetters: "qv",
    valueLetters: "cn",
    valueFlags: ["--bytes", "--lines"],
    numericShorthand: true,
  },
  file: { longFlags: ["--brief", "--mime", "--mime-encoding", "--mime-type", "--dereference"], shortLetters: "bhiL" },
};

function optionName(token: string): { flag: string; hasInlineValue: boolean } {
  const separator = token.indexOf("=");
  return separator === -1
    ? { flag: token, hasInlineValue: false }
    : { flag: token.slice(0, separator), hasInlineValue: true };
}

/** Returns undefined when the token is accepted, or the reason it is not. */
function rejectOption(token: string, policy: BinaryPolicy): string | undefined {
  const { flag } = optionName(token);
  if (token.startsWith("--")) {
    return policy.longFlags.includes(flag) ? undefined : `option ${flag} is not a permitted read-only option`;
  }
  if (policy.singleDashWords?.includes(flag)) return undefined;
  if (policy.numericShorthand && /^-\d+$/.test(token)) return undefined;
  // A binary whose short options are words (`find`) has no letter clusters to walk, so report the
  // whole predicate rather than its first letter.
  const shortLetters = policy.shortLetters;
  if (shortLetters === undefined) return `option ${flag} is not a permitted read-only option`;
  for (const letter of flag.slice(1)) {
    if (policy.valueLetters?.includes(letter)) return undefined; // any remainder is this option's value
    if (!shortLetters.includes(letter)) return `option -${letter} is not a permitted read-only option`;
  }
  return undefined;
}

function consumesFollowingValue(token: string, policy: BinaryPolicy): boolean {
  const { flag, hasInlineValue } = optionName(token);
  if (hasInlineValue) return false;
  if (policy.valueFlags?.includes(flag)) return true;
  if (token.startsWith("--")) return false;
  const last = flag.slice(-1);
  return Boolean(policy.valueLetters?.includes(last)) && flag.length >= 2;
}

/**
 * Whether a `bash` command is read-only enough to run inside a review, preflight, or advisory phase.
 *
 * Every question is asked about lexed argv: the binary must be allowlisted, `git` must name an
 * allowlisted subcommand with no top-level option before it, and every option must appear in that
 * binary's allowlist. Operands (paths, patterns, revisions) are unrestricted because the binary
 * cannot write through them.
 */
export function readOnlyShellCommandRejection(command: string): string | undefined {
  const segmented = segmentShellCommand(command);
  if (!segmented.ok) return segmented.reason;
  for (const argv of segmented.segments) {
    const rejection = simpleCommandRejection(argv);
    if (rejection) return rejection;
  }
  return undefined;
}

/** `cd` only changes where later segments of the same command run, which they are classified for. */
function cdRejection(args: readonly string[]): string | undefined {
  const option = args.find((token) => token.startsWith("-") && token !== "-");
  if (option) return `cd option ${option} is not permitted`;
  if (args.length > 1) return "cd accepts a single directory";
  return undefined;
}

function simpleCommandRejection(argv: readonly string[]): string | undefined {
  const [binary, ...rest] = argv;
  if (binary === undefined) return "no command word";
  if (binary === "cd") return cdRejection(rest);
  // `FOO=bar cmd` would run cmd with a modified environment, so the assignment is never a binary.
  const policy = READ_ONLY_BINARIES[binary];
  if (!policy) return `${binary} is not a read-only command`;
  let args: readonly string[] = rest;
  if (policy.subcommands) {
    for (;;) {
      if (policy.preSubcommandFlags?.includes(args[0] ?? "")) args = args.slice(1);
      else if (policy.preSubcommandValueFlags?.includes(args[0] ?? "") && args.length > 1) args = args.slice(2);
      else break;
    }
    const subcommand = args[0];
    if (subcommand === undefined) return `${binary} requires a read-only subcommand`;
    if (!policy.subcommands.includes(subcommand)) {
      return `${binary} ${subcommand} is not a read-only subcommand`;
    }
    args = args.slice(1);
    const rule = policy.subcommandRules?.[subcommand];
    if (rule) return rule(args);
  }
  return optionRejection(args, policy);
}

function optionRejection(args: readonly string[], policy: BinaryPolicy): string | undefined {
  let expectValue = false;
  let endOfOptions = false;
  for (const token of args) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (endOfOptions || !token.startsWith("-") || token === "-") continue;
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    const rejection = rejectOption(token, policy);
    if (rejection) return rejection;
    expectValue = consumesFollowingValue(token, policy);
  }
  return undefined;
}

export function isReadOnlyShellCommand(command: string): boolean {
  return readOnlyShellCommandRejection(command) === undefined;
}
