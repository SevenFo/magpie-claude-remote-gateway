"""Operator helpers for the HTTPS front. Since v0.4 the front is a child of
Magpie's plugin host (started by index.mjs with a lifetime stdin pipe), so no
launchd/systemd service exists any more. This script only removes the legacy
v0.3 services and records which Node runtime the plugin should use."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

LABEL = "com.sevenfo.magpie-claude-https"
UNIT = "magpie-claude-https.service"
HOME = Path.home()
STATE = HOME / ".config/magpie/claude-remote-tls/service"


def run(args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=12)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())
        temp = Path(f.name)
    temp.chmod(0o600)
    os.replace(temp, path)


def set_node(node):
    node = Path(node)
    if not node.is_file():
        raise RuntimeError("Not an executable file: " + str(node))
    data = {}
    installed = STATE / "installed.json"
    if installed.exists():
        data = json.loads(installed.read_text())
    data.update(node=str(node), version="0.4.0")
    data.pop("unit", None)
    save(installed, data)
    print("Recorded Node runtime:", node)


def remove_legacy():
    if sys.platform == "darwin":
        target = "gui/" + str(os.getuid()) + "/" + LABEL
        run(["launchctl", "bootout", target], False)
        plist = HOME / "Library/LaunchAgents" / (LABEL + ".plist")
        if plist.exists():
            plist.unlink()
            print("Removed", plist)
    else:
        run(["systemctl", "--user", "disable", "--now", UNIT], False)
        unit = HOME / ".config/systemd/user" / UNIT
        if unit.exists():
            unit.unlink()
            print("Removed", unit)
        run(["systemctl", "--user", "daemon-reload"], False)
    installed = STATE / "installed.json"
    if installed.exists():
        data = json.loads(installed.read_text())
        data.pop("unit", None)
        data["version"] = "0.4.0"
        save(installed, data)
    print("Legacy standalone service removed; the plugin host now owns the front")


def status():
    if sys.platform == "darwin":
        r = run(["launchctl", "print", "gui/" + str(os.getuid()) + "/" + LABEL], False)
        print("legacy launchd unit:", "loaded (remove it!)" if r.returncode == 0 else "absent")
    else:
        r = run(["systemctl", "--user", "is-active", UNIT], False)
        print("legacy systemd unit:", r.stdout.strip() or "absent")
    installed = STATE / "installed.json"
    print("installed.json:", installed.read_text().strip() if installed.exists() else "missing")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["status", "remove-legacy", "set-node"])
    p.add_argument("node", nargs="?")
    args = p.parse_args()
    if args.action == "set-node":
        set_node(args.node or "")
    elif args.action == "remove-legacy":
        remove_legacy()
    else:
        status()


if __name__ == "__main__":
    main()
