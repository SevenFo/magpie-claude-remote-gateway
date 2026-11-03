import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATEWAY_HTTP = "http://127.0.0.1:3425";
const GATEWAY_HTTPS = "https://magpie.internal:3443";
const BUILTIN_PROFILE = "00000000-0000-4000-8000-6d6167706965";

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJSON(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Claude Desktop's configLibrary folders, as Magpie's desktopdir finds them.
export function desktopLibraries() {
  const home = os.homedir();
  const dirs = process.platform === "darwin"
    ? [path.join(home, "Library/Application Support/Claude-3p/configLibrary")]
    : [path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude-3p/configLibrary")];
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// The patch Magpie's own writer undoes on a manual reconnect: put the HTTPS
// front's address back into the *built-in* Desktop profile. Magpie accepts it
// as a reverse proxy in front of the gateway (its reachesMagpie check), so the
// built-in agent keeps its whole settings UI and reports no drift. Runs once
// per plugin-host start; nothing is watched.
export function ensureDesktopProfile(library) {
  const meta = readJSON(path.join(library, "_meta.json"));
  if (!meta || meta.appliedId !== BUILTIN_PROFILE) return "skip: built-in profile is not applied";
  if (!Array.isArray(meta.entries) || !meta.entries.some((e) => e && e.id === BUILTIN_PROFILE)) return "skip: built-in profile is not wired";
  const file = path.join(library, BUILTIN_PROFILE + ".json");
  const profile = readJSON(file);
  if (!profile || profile.inferenceProvider !== "gateway") return "skip: profile is not a gateway profile";
  const base = String(profile.inferenceGatewayBaseUrl || "").replace(/\/+$/, "");
  if (base === GATEWAY_HTTPS) return "ok: already on the HTTPS front";
  if (base !== GATEWAY_HTTP) return `skip: unexpected gateway URL ${base}`;
  profile.inferenceGatewayBaseUrl = GATEWAY_HTTPS;
  writeJSON(file, profile);
  return "patched: built-in profile now uses the HTTPS front";
}
