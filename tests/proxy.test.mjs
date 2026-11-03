import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { createProxy } from "../proxy.mjs";

test("transparent HTTPS transport, streaming, policy checks, and upstream restart", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-https-test-"));
  let upstream, front;
  const received = [];
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=magpie.internal", "-addext", "subjectAltName=DNS:magpie.internal",
      "-keyout", path.join(temp, "key"), "-out", path.join(temp, "cert")], { stdio: "ignore" });
    const cert = fs.readFileSync(path.join(temp, "cert"));
    upstream = http.createServer((req, res) => {
      const body = [];
      req.on("data", c => body.push(c));
      req.on("end", () => {
        received.push({ path: req.url, headers: req.headers, body: Buffer.concat(body).toString() });
        if (req.url === "/error") { res.writeHead(503); return res.end('{"error":"fixture"}'); }
        if (req.url === "/compressed") {
          const b = zlib.gzipSync("fixture compressed body");
          res.writeHead(200, { "content-encoding": "gzip", "content-length": b.length });
          return res.end(b);
        }
        if (req.url === "/stream") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: first\n\n");
          return setTimeout(() => res.end("data: last\n\n"), 500);
        }
        res.end("OK");
      });
    });
    upstream.on("connection", (s) => s.setNoDelay(true));
    await new Promise(r => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = upstream.address().port;
    front = createProxy({ cert, key: fs.readFileSync(path.join(temp, "key")), upstream: `http://127.0.0.1:${upstreamPort}` });
    await new Promise(r => front.listen(0, "127.0.0.1", r));
    const ask = (url, headers = {}, body = "", onData = () => {}) => new Promise((resolve, reject) => {
      const req = https.request({ hostname: "127.0.0.1", port: front.address().port, servername: "magpie.internal", agent: false,
        ca: cert, method: body ? "POST" : "GET", path: url,
        headers: { host: "magpie.internal:3443", authorization: "Bearer fixture", ...headers } }, res => {
        const chunks = [];
        res.on("data", c => { chunks.push(c); onData(c); });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject); req.end(body);
    });
    const one = await ask("/v1/messages?q=1", { "x-forwarded-for": "192.0.2.1", "anthropic-beta": "fixture-beta" }, '{"fixture":true}');
    assert.equal(one.status, 200);
    assert.equal(received[0].path, "/v1/messages?q=1");
    assert.equal(received[0].body, '{"fixture":true}');
    assert.equal(received[0].headers["x-forwarded-for"], "192.0.2.1");
    assert.equal(received[0].headers["anthropic-beta"], "fixture-beta");
    assert.equal(received[0].headers.host, `127.0.0.1:${upstreamPort}`);
    assert.equal((await ask("/error")).status, 503);
    const compressed = await ask("/compressed");
    assert.equal(zlib.gunzipSync(compressed.body).toString(), "fixture compressed body");
    let first = 0;
    const start = Date.now();
    const streamed = await ask("/stream", {}, "", () => { first ||= Date.now() - start; });
    assert.ok(first < 400, `SSE buffered for ${first}ms`);
    assert.match(streamed.body.toString(), /last/);
    assert.equal((await ask("/api/settings")).status, 403);
    assert.equal((await ask("/v1/messages", { authorization: "" })).status, 401);
    assert.equal((await ask("/v1/messages", { origin: "https://evil.example" })).status, 403);
    assert.equal((await ask("/v1/messages", { host: "evil.example" })).status, 421);
    assert.equal((await ask("/healthz")).status, 200);
    await new Promise(r => upstream.close(r));
    assert.equal((await ask("/v1/messages")).status, 502);
    await new Promise(r => upstream.listen(upstreamPort, "127.0.0.1", r));
    assert.equal((await ask("/v1/messages")).status, 200);
  } finally {
    if (front) await new Promise(r => front.close(r));
    if (upstream) await new Promise(r => upstream.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
