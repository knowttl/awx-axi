import { once } from "node:events";
import assert from "node:assert/strict";
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Env } from "../../src/core/profiles.js";

const compiled = process.argv[2]!;
const { HttpTransport, RecordedTransport } = await import(pathToFileURL(join(compiled, "core/transport.js")).href) as typeof import("../../src/core/transport.js");
const { authCommand } = await import(pathToFileURL(join(compiled, "commands/auth.js")).href) as typeof import("../../src/commands/auth.js");
const { PrivateFiles } = await import(pathToFileURL(join(compiled, "core/private-file.js")).href) as typeof import("../../src/core/private-file.js");
process.send!("ready");
const [input] = await once(process, "message") as [{ command: string; env: Env }];
if (input.command === "reclaim") {
  const path = join(input.env.XDG_STATE_HOME!, "reclamation");
  const files = new PrivateFiles();
  for (let index = 0; index < 20; index += 1) files.withLock(path, () => {
    const owner = JSON.parse(files.read(`${path}.lock`, true)!) as { pid: number; startTime: number };
    assert.equal(owner.pid, process.pid);
    assert.ok(Number.isFinite(owner.startTime));
    const marker = `${path}.active`;
    const fd = openSync(marker, "wx");
    try { files.write(path, `${files.read(path, true) ?? ""}${process.pid}\n`); }
    finally { closeSync(fd); rmSync(marker); }
  });
} else if (input.command === "journal") {
  const transport = new HttpTransport({
    baseUrl: "https://awx.example.com", apiBasePath: "/api/v2/", readOnly: false, env: input.env,
    fetch: async () => new globalThis.Response(null, { status: 204 }),
  });
  for (let index = 0; index < 20; index += 1) await transport.post("jobs/1/launch/");
} else if (input.command.startsWith("login:")) {
  const profile = input.command.slice("login:".length);
  const transport = new HttpTransport({
    baseUrl: "https://awx.example.com", apiBasePath: "/api/v2/", readOnly: false, env: input.env,
    fetch: async () => new globalThis.Response(JSON.stringify({ id: 1, token: `synthetic-pat-${profile}` }), { status: 201 }),
  });
  await authCommand(["login"], {
    env: input.env, selection: { profile },
    createTransport: () => transport, createBasicAuthTransport: () => transport,
  });
} else {
  for (let index = 0; index < 20; index += 1) {
    const profile = `${input.command}-${index}`;
    const transport = new RecordedTransport(input.command === "login"
      ? [{ status: 201, body: { id: index + 1, token: `synthetic-pat-${index}` } }]
      : [{ status: 204 }], { env: input.env });
    await authCommand([input.command], {
      env: input.env, selection: { profile },
      createTransport: () => transport, createBasicAuthTransport: () => transport,
    });
  }
}
process.disconnect!();
