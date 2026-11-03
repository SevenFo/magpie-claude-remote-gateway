#!/usr/bin/env python3
"""Reject accidentally included local state or credential material."""
from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
patterns=[re.compile(r"-----BEGIN "+r"(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
          re.compile(r"\b(?:ghp|gho|github_pat)_"+r"[A-Za-z0-9_]{24,}\b"),
          re.compile(r"\bsk-"+r"[A-Za-z0-9_-]{24,}\b"),
          re.compile(r"/(?:Users|home)/"+r"[A-Za-z0-9_.-]+/")]
errors=[]
for file in root.rglob("*"):
    if not file.is_file() or any(part in {".git","dist","__pycache__","node_modules",".playwright-cli","artifacts"} for part in file.relative_to(root).parts):continue
    if file.name in {"auth.json","config.toml","state.json"} or file.suffix in {".sqlite",".log",".pyc"}:
        errors.append(str(file.relative_to(root)));continue
    try:text=file.read_text()
    except UnicodeDecodeError:
        errors.append(str(file.relative_to(root)));continue
    if any(p.search(text) for p in patterns):errors.append(str(file.relative_to(root)))
if errors:raise SystemExit("Review before publishing: "+", ".join(errors))
print("Public source check passed")
