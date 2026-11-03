import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCAL_PORT = Number(process.env.MAGPIE_CLAUDE_HTTPS_PORT || 3443);
const AUTHORITY = "magpie.internal:3443";
const UPSTREAM = "http://127.0.0.1:3425";
const BIND_RETRY_MS = 500;
const BIND_RETRY_LIMIT = 120; // a plugin-host reload may hold the port for a moment
// Magpie may run several plugin hosts at once; each starts a front and the
// losers park as standbys once the winner has clearly outlived a restart
// handover, taking the port over if the winner's host ever goes first.
const SIBLING_GRACE_MS = Number(process.env.MAGPIE_CLAUDE_HTTPS_SIBLING_MS || 15_000);
const STANDBY_RETRY_MS = Number(process.env.MAGPIE_CLAUDE_HTTPS_STANDBY_MS || 10_000);
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function endToEnd(headers) {
  const dropped = new Set(HOP);
  for (const name of String(headers.connection || "").split(",")) dropped.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name.toLowerCase())));
}

export function createProxy({ cert, key, upstream = UPSTREAM, authority = AUTHORITY }) {
  const target = new URL(upstream);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw new Error("Upstream must be the local HTTP gateway");
  const server = https.createServer({ cert, key }, (request, response) => {
    const error = (status, message) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "https_front", message } }));
    };
    if (request.headers.host !== authority) return error(421, "Unexpected Host");
    const origin = request.headers.origin;
    if (origin && origin !== `https://${authority}`) return error(403, "Cross-origin requests are not allowed");
    const url = request.url || "/";
    if (url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ service: "magpie-claude-remote-gateway", version: VERSION, pid: process.pid }));
    }
    if (!url.startsWith("/") || url.startsWith("//") || /^\/api(?:\/|\?|$)/.test(url)) return error(403, "Management routes are not exposed");
    if (url !== "/" && !request.headers.authorization && !request.headers["x-api-key"]) return error(401, "A gateway credential is required");
    const headers = { ...endToEnd(request.headers), host: target.host };
    // Preserve forwarding headers: do not bypass Magpie's shared-gateway policy.
    const outgoing = http.request({ hostname: target.hostname, port: target.port || 80, method: request.method, path: url, headers }, (incoming) => {
      response.writeHead(incoming.statusCode || 502, endToEnd(incoming.headers));
      incoming.pipe(response);
      incoming.on("aborted", () => response.destroy());
      incoming.on("error", () => response.destroy());
    });
    outgoing.on("error", (err) => {
      if (response.headersSent) response.destroy();
      else error(502, err.code === "ECONNREFUSED" ? "Magpie is restarting or unavailable" : "Local gateway connection failed");
    });
    outgoing.setTimeout(300_000, () => outgoing.destroy(new Error("Gateway idle timeout")));
    request.on("aborted", () => outgoing.destroy());
    response.on("close", () => { if (!response.writableEnded) outgoing.destroy(); });
    request.pipe(outgoing);
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  return server;
}

// siblingServing: the port is held by another instance of this front (not an
// unrelated process), checked by its /healthz identity over TLS on loopback.
function siblingServing() {
  return new Promise((resolve) => {
    const req = https.request({ hostname: "127.0.0.1", port: LOCAL_PORT, path: "/healthz",
      servername: "magpie.internal", rejectUnauthorized: false, timeout: 1500,
      headers: { host: AUTHORITY } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString());
          resolve(info.service === "magpie-claude-remote-gateway" && info.pid !== process.pid);
        } catch { resolve(false); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const parentLifetime = args.includes("--parent-lifetime");
  if (parentLifetime) args.splice(args.indexOf("--parent-lifetime"), 1);
  const directory = args[0];
  if (!directory) throw new Error("Usage: node proxy.mjs <certificate directory> [--parent-lifetime]");
  const server = createProxy({ cert: fs.readFileSync(path.join(directory, "server.crt")), key: fs.readFileSync(path.join(directory, "server.key")) });
  let listening = false;
  let closing = false;
  let tries = 0;
  const contendedSince = { at: 0 };
  const close = (why) => {
    if (closing) return;
    closing = true;
    if (why) console.error(`HTTPS front stopping: ${why}`);
    if (listening) server.close();
    setTimeout(() => process.exit(0), 1500).unref();
    // Idle keep-alive sockets would otherwise hold the port for the next front.
    server.closeAllConnections?.();
  };
  const listen = () => {
    if (closing) return;
    server.listen(LOCAL_PORT, "127.0.0.1");
  };
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !listening && ++tries < BIND_RETRY_LIMIT) {
      contendedSince.at ||= Date.now();
      if (Date.now() - contendedSince.at > SIBLING_GRACE_MS) {
        // Past a restart handover: a healthy sibling front owns the port, so
        // this one parks as a standby and takes over if the sibling ever goes.
        siblingServing().then((sibling) => {
          if (sibling) {
            if (!contendedSince.standby) console.error("another front of this plugin is serving; standing by");
            contendedSince.standby = true;
            tries = 1; // a standby never exhausts the bind budget
            setTimeout(listen, STANDBY_RETRY_MS).unref();
          } else setTimeout(listen, BIND_RETRY_MS).unref();
        });
        return;
      }
      setTimeout(listen, BIND_RETRY_MS).unref();
      return;
    }
    console.error(`HTTPS front failed: ${err.code || err.message}`);
    close("listen error");
    process.exitCode = 1;
  });
  server.on("listening", () => {
    listening = true;
    console.log(`HTTPS front ready on loopback :${LOCAL_PORT} -> ${UPSTREAM}`);
  });
  // The plugin host holds the writing end of stdin. EOF means it reloaded or
  // exited (even by SIGKILL), so this front goes with it instead of outliving
  // Magpie. No files are watched for this.
  if (parentLifetime) {
    process.stdin.on("end", () => close("plugin host closed the lifetime pipe"));
    process.stdin.on("error", () => close("plugin host lifetime pipe failed"));
    process.stdin.resume();
  }
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  listen();
}
