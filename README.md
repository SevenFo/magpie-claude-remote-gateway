# Claude Desktop HTTPS for Magpie

Claude Desktop refuses a plain `http://127.0.0.1:3425` gateway for remote SSH
sessions. This plugin gives Desktop an `https://magpie.internal:3443` front
without forking or rebuilding Magpie:

- `proxy.mjs` is a transparent HTTPS front on `127.0.0.1:3443` forwarding to
  the local gateway on `127.0.0.1:3425`. It never writes Claude files, has no
  configuration watcher, blocks `/api` management routes, foreign Hosts and
  cross-origin requests, and preserves forwarding headers.
- `index.mjs` (the plugin main) starts the front as a **child of Magpie's
  plugin host** with a lifetime stdin pipe (`--parent-lifetime`): when Magpie
  (or its plugin host) stops, reloads or is killed, the pipe closes and the
  front exits with it. A successor retries the bind briefly, so restarts hand
  the port over cleanly. Magpie may run several plugin hosts; the extra fronts
  park as standbys behind the serving one (checked by its /healthz identity)
  and take the port over if it dies. A crashed front is respawned with
  backoff, at most 10 times per host life. There is no launchd/systemd
  service since v0.4.
- The **built-in** `claude-desktop` agent stays connected the normal way
  (`magpie claude-desktop provider magpie`), keeping its full settings UI
  (tiers, subagent model/effort). The plugin then patches only
  `inferenceGatewayBaseUrl` in Magpie's own Desktop profile from
  `http://127.0.0.1:3425` to `https://magpie.internal:3443`, once per plugin
  host start. Magpie's drift check accepts that address as a reverse proxy in
  front of its gateway (`reachesMagpie`, #1985), so nothing reports drift and
  no core patch or binary replacement is needed. A manual reconnect in the UI
  writes the plain URL back; the next Magpie start patches it again.

## Installation

Requires Node 18+, an existing `magpie.internal` hosts entry pointing at
`127.0.0.1`, and trusted certificate files under
`~/.config/magpie/claude-remote-tls/host/` (`server.crt`, `server.key`).
Certificates and keys are not plugin source and must not be committed.

```
python3 manage.py set-node /absolute/path/to/node   # recorded in installed.json
magpie plugin add /absolute/path/to/this/plugin
magpie claude-desktop provider magpie               # macOS only
```

Restart Magpie (or wait for the plugin host to start) and reopen Desktop.
Upgrading from v0.3: run `python3 manage.py remove-legacy` to drop the old
standalone launchd/systemd service; `python3 manage.py status` shows both the
legacy unit state and the recorded Node runtime. Linux machines (remote SSH
targets) need only the front: the Desktop patch is a no-op there.

## Tests

```
node --test tests/*.test.mjs      # transport, policy, lifecycle, profile patch
python3 tests/native_fixture.py   # Magpie's real writer in a disposable HOME
```

No Codex account, model, history or authentication files are changed. Logs go
to `~/.config/magpie/claude-remote-tls/service/` only.
