import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureDesktopProfile, desktopLibraries } from "./desktop.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = () => path.join(os.homedir(), ".config/magpie/claude-remote-tls");

function log(line) {
  try {
    const file = path.join(STATE(), "service", "plugin.log");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + ".old"); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {}
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function nodeRuntime() {
  const installed = readJSON(path.join(STATE(), "service", "installed.json"));
  const candidates = [installed && installed.node, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const c of candidates) {
    try { if (c && fs.statSync(c).isFile()) return c; } catch {}
  }
  return process.execPath; // Bun can run the plain node:https front as a last resort.
}

const supervisor = { child: null, attempts: 0, startedAt: 0 };

function startProxy() {
  const certs = path.join(STATE(), "host");
  for (const name of ["server.crt", "server.key"]) {
    if (!fs.existsSync(path.join(certs, name))) { log(`missing TLS file ${name}; HTTPS front not started`); return; }
  }
  const logDir = path.join(STATE(), "service");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(logDir, "stdout.log"), "a");
  const err = fs.openSync(path.join(logDir, "stderr.log"), "a");
  const env = { ...process.env };
  for (const key of ["CODEX_HOME", "CXI_ROOT", "MULTICODEX_API_KEY", "MAGPIE_ADDR", "MAGPIE_TLS_CERT", "MAGPIE_TLS_KEY"]) delete env[key];
  let child;
  try {
    // stdin is a pipe this host keeps open: when the plugin host exits or is
    // killed, the OS closes it and the front exits with it (--parent-lifetime).
    child = spawn(nodeRuntime(), [path.join(ROOT, "proxy.mjs"), certs, "--parent-lifetime"], { env, stdio: ["pipe", out, err] });
  } catch (e) {
    log(`spawn failed: ${e.message}`);
    fs.closeSync(out); fs.closeSync(err);
    return;
  }
  fs.closeSync(out); fs.closeSync(err);
  supervisor.child = child;
  supervisor.startedAt = Date.now();
  child.stdin.on("error", () => {});
  child.stdin.unref?.();
  child.unref();
  child.on("error", (e) => log(`proxy child error: ${e.message}`));
  child.on("exit", (code, signal) => {
    if (supervisor.child !== child) return;
    supervisor.child = null;
    if (Date.now() - supervisor.startedAt > 60_000) supervisor.attempts = 0;
    log(`proxy child exited (code ${code}, signal ${signal})`);
    if (code === 0) return; // clean exit: parent pipe EOF or yielded to a sibling front
    if (supervisor.attempts >= 10) { log("proxy child kept failing; giving up until the next Magpie start"); return; }
    supervisor.attempts += 1;
    setTimeout(startProxy, Math.min(30_000, 1000 * 2 ** supervisor.attempts)).unref();
  });
  log(`proxy child started (pid ${child.pid})`);
}

export const ClaudeRemoteGateway = async () => {
  if (process.env.MAGPIE_DRY_PROVIDERS) return {};
  const flag = Symbol.for("magpie-claude-remote-gateway/started");
  if (globalThis[flag]) return {};
  globalThis[flag] = true;
  try {
    startProxy();
    for (const library of desktopLibraries()) log(`desktop profile: ${ensureDesktopProfile(library)} (${library})`);
  } catch (e) {
    log(`initialisation failed: ${e.message}`);
  }
  return {};
};
