import { validationError } from "./errors.js";
import { detailOutput } from "./output.js";
import type { FlagSpec } from "./registry.js";
import type { RiskTier } from "./transport.js";

/** Shared safety and preview helpers for declarative management commands. */
export const MUTATION_FLAGS: readonly FlagSpec[] = [
  { name: "confirm", description: "confirm live execution", takesValue: false },
  { name: "dry-run", description: "preview without mutating", takesValue: false },
];

export function isLive(flags: Readonly<Record<string, string | true>>): boolean {
  return flags.confirm === true && flags["dry-run"] !== true;
}

export function dryRun(
  action: string,
  type: string,
  target: Record<string, unknown>,
  wouldSend: string,
  payload?: Record<string, unknown>,
) {
  return detailOutput({
    label: "dry_run",
    fields: {
      action,
      type,
      ...target,
      would_send: wouldSend,
      ...(payload === undefined ? {} : { payload }),
    },
    help: [`Re-run with --confirm to ${action}`],
  });
}

export function accepted(status: number, ...expected: number[]): boolean {
  return expected.includes(status);
}

export function parseInteger(
  raw: string,
  flagName: string,
  minimum: number,
  maximum?: number,
): number {
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    const range = maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
    throw validationError(`${flagName} must be an integer ${range}`);
  }
  return value;
}

export function parseJsonObject(raw: string, flagName: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // translated below
  }
  throw validationError(`${flagName} must be a JSON object`);
}

export function associationBody(id: number, remove: boolean): Record<string, unknown> {
  return remove ? { id, disassociate: true } : { id };
}

export function associationTag(kind: "security" | "config" | "operational"): RiskTier {
  return kind;
}
