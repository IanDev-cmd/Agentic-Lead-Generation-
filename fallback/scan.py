"""Read-only scan of this repository. Values of secrets are never recorded."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

SKIP_DIRS = {"node_modules", "output", ".git", "__pycache__", ".venv", "venv"}
TEXT_SUFFIXES = {".js", ".gs", ".py", ".json", ".md", ".example", ".env", ".toml", ".yml", ".yaml"}
ENV_KEY = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
DB_PATTERNS = (
    ("database_url", re.compile(r"\bDATABASE_URL\b", re.I)),
    ("mongodb", re.compile(r"\bmongodb(?:\+srv)?://", re.I)),
    ("postgres", re.compile(r"\bpostgres(?:ql)?://", re.I)),
    ("mysql", re.compile(r"\bmysql://", re.I)),
    ("sqlite", re.compile(r"\bsqlite3?\b", re.I)),
    ("prisma", re.compile(r"\bprisma\b", re.I)),
    ("mongoose", re.compile(r"\bmongoose\b", re.I)),
)


@dataclass
class RepoScan:
    root: str
    env_files: list[str] = field(default_factory=list)
    env_key_names: list[str] = field(default_factory=list)
    logic_files: list[str] = field(default_factory=list)
    database_hits: list[dict[str, str]] = field(default_factory=list)
    paid_entrypoint: bool = False
    key_name_present: bool = False
    active_flags: dict[str, bool] = field(default_factory=dict)

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")


def scan_repo(root: Path, active_flags: dict[str, bool]) -> RepoScan:
    scan = RepoScan(root=str(root), active_flags=dict(active_flags))
    index_text = ""
    for path in _files(root):
        relative = path.relative_to(root).as_posix()
        if path.name in {".env", ".env.example"} or path.suffix == ".env":
            scan.env_files.append(relative)
            scan.env_key_names.extend(_env_key_names(path))
        if path.name in {"index.js", "Code.gs", "package.json", "appsscript.json"}:
            scan.logic_files.append(relative)
        if path.name == "index.js":
            index_text = path.read_text(encoding="utf-8", errors="ignore")
        if path.name != "scan.py" and path.suffix.lower() in TEXT_SUFFIXES and path.name != ".env":
            scan.database_hits.extend(_database_hits(path, relative))
    scan.env_key_names = sorted(set(scan.env_key_names))
    scan.key_name_present = "GEMINI_API_KEY" in scan.env_key_names
    scan.paid_entrypoint = "interactions.create" in index_text and "deep-research" in index_text
    return scan


def _files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.stat().st_size > 1_000_000:
            continue
        yield path


def _env_key_names(path: Path) -> list[str]:
    names = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = ENV_KEY.match(raw)
        if match:
            names.append(match.group(1))
    return names


def _database_hits(path: Path, relative: str) -> list[dict[str, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    hits = []
    for name, pattern in DB_PATTERNS:
        if pattern.search(text):
            hits.append({"file": relative, "kind": name})
    return hits
