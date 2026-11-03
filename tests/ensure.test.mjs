import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDesktopProfile } from "../desktop.mjs";

const BUILTIN = "00000000-0000-4000-8000-6d6167706965";

function fixture(meta, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-ensure-"));
  if (meta) fs.writeFileSync(path.join(dir, "_meta.json"), JSON.stringify(meta));
  if (profile) fs.writeFileSync(path.join(dir, BUILTIN + ".json"), JSON.stringify(profile));
  return dir;
}

const wired = { appliedId: BUILTIN, entries: [{ id: BUILTIN, name: "magpie" }] };

test("patches only the wired built-in gateway profile, preserving every other key", () => {
  const dir = fixture(wired, {
    inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:3425",
    inferenceGatewayApiKey: "sealed-fixture", sshHostAllowlist: ["*"], claudeAiImport: { enabled: true }
  });
  assert.match(ensureDesktopProfile(dir), /^patched/);
  const after = JSON.parse(fs.readFileSync(path.join(dir, BUILTIN + ".json")));
  assert.equal(after.inferenceGatewayBaseUrl, "https://magpie.internal:3443");
  assert.equal(after.inferenceGatewayApiKey, "sealed-fixture");
  assert.deepEqual(after.sshHostAllowlist, ["*"]);
  assert.deepEqual(after.claudeAiImport, { enabled: true });
  assert.match(ensureDesktopProfile(dir), /^ok/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("leaves foreign setups alone", () => {
  const cases = [
    [fixture(null, null), /skip/],
    [fixture({ appliedId: "someone-else", entries: [{ id: BUILTIN }] },
      { inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:3425" }), /not applied/],
    [fixture({ appliedId: BUILTIN, entries: [] },
      { inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:3425" }), /not wired/],
    [fixture(wired, { inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://192.0.2.8:3425" }), /unexpected gateway URL/],
    [fixture(wired, { inferenceProvider: "bedrock", inferenceGatewayBaseUrl: "http://127.0.0.1:3425" }), /not a gateway profile/]
  ];
  for (const [dir, want] of cases) {
    const before = fs.existsSync(path.join(dir, BUILTIN + ".json")) ? fs.readFileSync(path.join(dir, BUILTIN + ".json"), "utf8") : null;
    assert.match(ensureDesktopProfile(dir), want);
    const after = fs.existsSync(path.join(dir, BUILTIN + ".json")) ? fs.readFileSync(path.join(dir, BUILTIN + ".json"), "utf8") : null;
    assert.equal(after, before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
