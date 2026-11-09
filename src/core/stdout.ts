import { validationError } from "./errors.js";
import type { TextResponse } from "./transport.js";

const ANSI_ESCAPE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * AWX has no tail parameter and its `txt` renderer ignores line ranges, so a
 * tail is cut here from a ranged `json` read. Colour codes are removed unless
 * the caller asked to keep them.
 */
export function presentStdout(
  text: TextResponse,
  options: { readonly tail?: number | undefined; readonly keepAnsi?: boolean | undefined },
): TextResponse {
  const content = options.keepAnsi === true ? text.content : stripAnsi(text.content);
  if (options.tail === undefined) return { ...text, content };

  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length <= options.tail) return { ...text, content };
  const kept = lines.slice(-options.tail);
  return {
    ...text,
    content: kept.length === 0 ? "" : `${kept.join("\n")}\n`,
    rangeStart: text.rangeEnd - kept.length,
  };
}

export function parseTail(raw: string, command: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw validationError(`malformed --tail "${raw}" for \`${command}\``, [
      `Run \`awx-axi ${command} <id> --tail 200\` to read the last 200 lines`,
    ]);
  }
  return Number(raw);
}
