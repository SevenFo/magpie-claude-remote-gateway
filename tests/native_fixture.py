"""Exercise Magpie's real built-in Desktop writer in a disposable HOME, then the
plugin's profile patch on top of it. Never touches the real profile."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parents[1]
MAGPIE = Path.home() / ".local/bin/magpie"
BUILTIN = "00000000-0000-4000-8000-6d6167706965"

with tempfile.TemporaryDirectory(prefix="magpie-native-https-") as temp:
    home = Path(temp)
    config = home / ".config/magpie"
    config.mkdir(parents=True)
    (config / "plugins.json").write_text(json.dumps({"plugins": [{"spec": str(SOURCE)}]}))
    if sys.platform == "darwin":
        library = home / "Library/Application Support/Claude-3p/configLibrary"
    else:
        library = home / ".config/Claude-3p/configLibrary"
    library.mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CODEX_", "MULTICODEX_", "MAGPIE_"))}
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"), XDG_CACHE_HOME=str(home / ".cache"),
               CODEX_HOME=str(home / ".codex"), CLAUDE_CONFIG_DIR=str(home / ".claude"), MAGPIE_NO_ACCOUNTS="1")

    def command(*args):
        r = subprocess.run([str(MAGPIE), *args], env=env, capture_output=True, text=True, timeout=20)
        assert r.returncode == 0, (args, r.stderr[:500])
        return r.stdout

    def patch():
        r = subprocess.run([os.environ.get("NODE", "node"), "-e",
                            "import(process.argv[1]).then(m => console.log(m.ensureDesktopProfile(process.argv[2])))",
                            str(SOURCE / "desktop.mjs"), str(library)], env=env, capture_output=True, text=True, timeout=20)
        assert r.returncode == 0, r.stderr[:500]
        return r.stdout.strip()

    profile = library / (BUILTIN + ".json")
    for round_ in range(2):
        command("claude-desktop", "provider", "magpie")
        data = json.loads(profile.read_text())
        assert data["inferenceGatewayBaseUrl"] == "http://127.0.0.1:3425", data
        assert json.loads((library / "_meta.json").read_text())["appliedId"] == BUILTIN
        assert patch().startswith("patched"), "first patch must rewrite the URL"
        data = json.loads(profile.read_text())
        assert data["inferenceGatewayBaseUrl"] == "https://magpie.internal:3443"
        assert data["inferenceProvider"] == "gateway"
        assert data["disableDeploymentModeChooser"] is True
        assert patch().startswith("ok"), "second patch must be a no-op"
        # Magpie's own drift check must accept the front as a reverse proxy.
        shown = command("claude-desktop")
        assert "no longer" not in shown and "not magpie's gateway" not in shown, shown
        command("claude-desktop", "default")
        assert not profile.exists() or json.loads(profile.read_text()).get("inferenceProvider") != "gateway"
    print("PASS: built-in connect + plugin patch twice; disconnect restores; zero inference")
