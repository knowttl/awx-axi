/**
 * Per-subcommand flag validation and the secret-name guard (design.md §5.3,
 * §9.4).
 *
 * Flag sets are declared per subcommand, not per noun, because `job list` and
 * `job stdout` share nothing.
 */
import { validationError } from "./errors.js";
import type { FlagSpec } from "./registry.js";

/**
 * A flag name matching this is refused at registration (§5.3).
 *
 * Secrets reach awx-axi through the environment or through a `0600` file, never
 * through `argv`, because `argv` is visible in `ps` output, shell history, and
 * agent transcripts. A path to a secret is not a secret, so `--*-file` passes.
 */
const SECRET_NAME = /(^|-)(tokens?|passwords?|secrets?|keys?|passphrases?)(-|$)/;

/** A path to a secret is not a secret, so `--credential-passwords-file` passes (§6.3). */
const SECRET_PATH_SUFFIX = /-file$/;

/**
 * The one universal flag (AXI §6). It never reaches a subcommand's flag set and
 * is never reported as unknown.
 */
const ALWAYS_ALLOWED: readonly string[] = ["--help"];

/** Renamed flags get a targeted hint rather than the generic list (§9.4). */
const RENAMED: Readonly<Record<string, string>> = {
  "--state": "--status",
  "--cancelled": "--canceled",
};

/**
 * Refuse a flag declaration whose name names a secret, at module load.
 *
 * This is what makes §5.3 structural rather than documented: a future
 * contributor cannot add `--token` without the CLI failing to import.
 */
export function assertNoSecretFlags(
  subcommand: string,
  flags: readonly FlagSpec[],
): void {
  for (const flag of flags) {
    if (
      SECRET_NAME.test(flag.name) &&
      !SECRET_PATH_SUFFIX.test(flag.name)
    ) {
      throw new Error(
        `\`${subcommand}\` declares --${flag.name}: a secret is never a command-line argument (design.md §5.3)`,
      );
    }
  }
}

/** A flag's value, or `true` for a boolean flag such as `--failed`. */
export type ParsedFlags = Readonly<Record<string, string | true>>;

export interface ParsedArgs {
  readonly args: readonly string[];
  readonly flags: ParsedFlags;
}

/**
 * Parse and validate one subcommand's arguments.
 *
 * An unknown flag is rejected **by name before any HTTP call**, with the
 * subcommand's valid flags inlined so the correction takes one turn (§9.4). A
 * dropped flag is worse than an error: the agent gets plausible-looking output
 * it believes is filtered.
 */
export function parseFlags(
  subcommand: string,
  argv: readonly string[],
  flags: readonly FlagSpec[],
): ParsedArgs {
  const known = new Map(flags.map((flag) => [`--${flag.name}`, flag]));
  const args: string[] = [];
  const parsed: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    if (ALWAYS_ALLOWED.includes(token)) {
      continue;
    }

    const separator = token.indexOf("=");
    const name = separator === -1 ? token : token.slice(0, separator);
    const spec = known.get(name);

    if (spec === undefined) {
      throw unknownFlag(name, subcommand, flags);
    }

    if (!spec.takesValue) {
      if (separator !== -1) {
        throw validationError(
          `${name} takes no value for \`${subcommand}\``,
          [`Run \`awx-axi ${subcommand} ${name}\` without a value`],
        );
      }
      parsed[spec.name] = true;
      continue;
    }

    const value =
      separator === -1 ? argv[(index += 1)] : token.slice(separator + 1);
    if (value === undefined) {
      throw validationError(`${name} needs a value for \`${subcommand}\``, [
        `valid flags for \`${subcommand}\`: ${flagList(flags)}`,
      ]);
    }
    parsed[spec.name] = value;
  }

  return { args, flags: parsed };
}

function unknownFlag(
  name: string,
  subcommand: string,
  flags: readonly FlagSpec[],
): Error {
  const renamed = RENAMED[name];
  const suggestion =
    renamed !== undefined && flags.some((flag) => `--${flag.name}` === renamed)
      ? renamed
      : nearest(name, flags);

  const help =
    suggestion === undefined
      ? [`valid flags for \`${subcommand}\`: ${flagList(flags)}`]
      : [
          `Did you mean ${suggestion}?`,
          `valid flags for \`${subcommand}\`: ${flagList(flags)}`,
        ];

  return validationError(`unknown flag ${name} for \`${subcommand}\``, help);
}

function flagList(flags: readonly FlagSpec[]): string {
  return flags.length === 0
    ? "none"
    : flags.map((flag) => `--${flag.name}`).join(", ");
}

/** Closest known flag within a two-edit budget, so the hint stays trustworthy. */
function nearest(name: string, flags: readonly FlagSpec[]): string | undefined {
  let best: { name: string; distance: number } | undefined;

  for (const flag of flags) {
    const candidate = `--${flag.name}`;
    const distance = editDistance(name, candidate);
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }

  return best?.name;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length] as number;
}
