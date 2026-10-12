import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent, request } from "node:https";

import type { FetchLike } from "./transport.js";

/** A scoped agent never changes TLS verification for another transport. */
export function createTlsFetch(verifySsl: boolean, send?: typeof request): FetchLike {
  return (url, init) => new Promise((resolve, reject) => {
  const plainHttp = new URL(url).protocol === "http:";
  const agent = plainHttp ? new HttpAgent() : new Agent({ rejectUnauthorized: verifySsl });
  const outgoing = (send ?? (plainHttp ? httpRequest : request))(url, { method: init.method, headers: init.headers, agent }, (incoming) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("error", (error) => { agent.destroy(); reject(error); });
    incoming.on("end", () => {
      agent.destroy();
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const status = incoming.statusCode ?? 500;
      resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
    });
  });
  outgoing.on("error", (error) => { agent.destroy(); reject(error); });
  outgoing.end(init.body);
  });
}
