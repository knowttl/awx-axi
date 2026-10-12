import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, type request } from "node:https";

import { describe, expect, it } from "vitest";

import { createTlsFetch } from "../src/core/tls-fetch.js";

describe("request-scoped TLS", () => {
  it("sends plain HTTP to a synthetic loopback controller without following redirects", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "https://other.example.com" });
      response.end("synthetic HTTP response");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const response = await createTlsFetch(true)(`http://127.0.0.1:${address.port}/api/v2/me/`, { method: "GET", headers: {} });
      expect(response.status).toBe(302);
      expect(await response.text()).toBe("synthetic HTTP response");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("keeps verified and unverified requests isolated and does not follow redirects", async () => {
    const agents: Agent[] = [];
    const send = ((_url: string, options: { agent: Agent }, callback: (response: IncomingMessage) => void) => {
      agents.push(options.agent);
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.end = (() => {
        const incoming = new EventEmitter() as IncomingMessage;
        incoming.headers = { location: "https://other.example.com" };
        incoming.statusCode = 302;
        callback(incoming);
        incoming.emit("data", Buffer.from("redirect"));
        incoming.emit("end");
        return outgoing;
      }) as ClientRequest["end"];
      return outgoing;
    }) as unknown as typeof request;
    const insecure = await createTlsFetch(false, send)("https://awx.example.com", { method: "GET", headers: {} });
    const secure = await createTlsFetch(true, send)("https://awx.example.com", { method: "GET", headers: {} });
    expect(insecure.status).toBe(302);
    expect(secure.status).toBe(302);
    expect(agents).toHaveLength(2);
    expect(agents[0]?.options.rejectUnauthorized).toBe(false);
    expect(agents[1]?.options.rejectUnauthorized).toBe(true);
    expect(agents[0]).not.toBe(agents[1]);
  });
});
