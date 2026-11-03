import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import https from "node:https";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

function makeCerts(dir) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=magpie.internal", "-addext", "subjectAltName=DNS:magpie.internal",
    "-keyout", path.join(dir, "server.key"), "-out", path.join(dir, "server.crt")], { stdio: "ignore" });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function health(port, ca) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", port, servername: "magpie.internal", ca,
      path: "/healthz", headers: { host: "magpie.internal:3443" }, timeout: 1000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { return await fn(); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw last || new Error("timed out");
}

function startChild(dir, port) {
  return spawn(process.execPath, [path.join(ROOT, "proxy.mjs"), dir, "--parent-lifetime"],
    { env: { ...process.env, MAGPIE_CLAUDE_HTTPS_PORT: String(port) }, stdio: ["pipe", "ignore", "pipe"] });
}

const exited = (child) => new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));

test("front follows the parent pipe: EOF stops it, a successor takes the port", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-lifecycle-"));
  try {
    makeCerts(dir);
    const ca = fs.readFileSync(path.join(dir, "server.crt"));
    const port = await freePort();
    const first = startChild(dir, port);
    const info = await until(() => health(port, ca));
    assert.equal(info.pid, first.pid);
    // Parent lifetime ends: stdin EOF, no signal — the front exits and frees the port.
    first.stdin.end();
    const gone = await exited(first);
    assert.equal(gone.code, 0);
    const second = startChild(dir, port);
    const next = await until(() => health(port, ca));
    assert.equal(next.pid, second.pid);
    // Overlap during a plugin-host reload: a third front retries the bind
    // until the second one dies with its own parent pipe.
    const third = startChild(dir, port);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(third.exitCode, null, "the retrying front must stay alive while the port is taken");
    second.stdin.end();
    await exited(second);
    const after = await until(() => health(port, ca));
    assert.equal(after.pid, third.pid);
    third.stdin.end();
    await exited(third);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("EOF before the port is free still stops a waiting front", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-lifecycle-wait-"));
  const blocker = net.createServer();
  try {
    makeCerts(dir);
    const port = await freePort();
    await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
    const waiting = startChild(dir, port);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(waiting.exitCode, null);
    waiting.stdin.end();
    const gone = await exited(waiting);
    assert.equal(gone.code, 0);
  } finally {
    await new Promise((r) => blocker.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a second host's front stands by behind a long-lived sibling, then takes over", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-lifecycle-sibling-"));
  try {
    makeCerts(dir);
    const ca = fs.readFileSync(path.join(dir, "server.crt"));
    const port = await freePort();
    const winner = startChild(dir, port);
    await until(() => health(port, ca));
    const standby = spawn(process.execPath, [path.join(ROOT, "proxy.mjs"), dir, "--parent-lifetime"],
      { env: { ...process.env, MAGPIE_CLAUDE_HTTPS_PORT: String(port),
        MAGPIE_CLAUDE_HTTPS_SIBLING_MS: "1000", MAGPIE_CLAUDE_HTTPS_STANDBY_MS: "500" },
        stdio: ["pipe", "ignore", "pipe"] });
    const noise = [];
    standby.stderr.on("data", (c) => noise.push(c));
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(standby.exitCode, null, "the standby must stay parked");
    assert.match(Buffer.concat(noise).toString(), /standing by/);
    assert.equal((await health(port, ca)).pid, winner.pid, "the sibling keeps serving");
    // The winner's host dies first: the standby takes the port over.
    winner.stdin.end();
    await exited(winner);
    const next = await until(() => health(port, ca));
    assert.equal(next.pid, standby.pid, "the standby must take over");
    standby.stdin.end();
    await exited(standby);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
