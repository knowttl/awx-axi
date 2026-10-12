import { once } from "node:events";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const compiled = process.argv[2];
const { HttpTransport, RecordedTransport } = await import(pathToFileURL(join(compiled, "core/transport.js")));
const { authCommand } = await import(pathToFileURL(join(compiled, "commands/auth.js")));
process.send("ready");
const [input] = await once(process, "message");
if (input.command === "journal") {
  const transport = new HttpTransport({
    baseUrl: "https://awx.example.com", apiBasePath: "/api/v2/", readOnly: false, env: input.env,
    fetch: async () => new globalThis.Response(null, { status: 204 }),
  });
  for (let index = 0; index < 20; index += 1) await transport.post("jobs/1/launch/");
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
process.disconnect();
