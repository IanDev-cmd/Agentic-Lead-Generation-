"""Environment loading. Existing process variables win over .env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip('"').strip("'")


def flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}


def clean_text(value: str, limit: int) -> str:
    return " ".join(value.replace("\r", " ").replace("\n", " ").split())[:limit]


def is_placeholder(value: str) -> bool:
    lowered = value.lower()
    return any(token in lowered for token in ("your-", "paste-", "changeme"))


@dataclass(frozen=True)
class Settings:
    root: Path
    api_key: str
    webhook_url: str
    webhook_secret: str
    billing_enabled: bool
    force_free: bool
    verify_billing: bool
    demo_mode: bool
    model: str
    industry: str
    region: str
    offering: str
    seller_name: str
    icp: str
    research_company: str
    research_domain: str
    max_leads: int
    grounding_calls_per_run: int
    request_timeout_seconds: int
    output_dir: Path

    @property
    def key_usable(self) -> bool:
        return bool(self.api_key) and not is_placeholder(self.api_key)

    @classmethod
    def from_env(cls, root: Path) -> "Settings":
        load_dotenv(root / ".env")
        try:
            max_leads = int(os.environ.get("MAX_LEADS", "8"))
        except ValueError:
            max_leads = 8
        try:
            per_run = int(os.environ.get("FREE_GROUNDING_CALLS_PER_RUN", "5"))
        except ValueError:
            per_run = 5
        try:
            timeout = int(os.environ.get("REQUEST_TIMEOUT_MS", "120000")) // 1000
        except ValueError:
            timeout = 120
        return cls(
            root=root,
            api_key=os.environ.get("GEMINI_API_KEY", "").strip(),
            webhook_url=os.environ.get("GOOGLE_WEBHOOK_URL", "").strip(),
            webhook_secret=os.environ.get("WEBHOOK_SECRET", "").strip(),
            billing_enabled=flag("BILLING_ENABLED"),
            force_free=flag("FORCE_FREE_TIER"),
            verify_billing=flag("VERIFY_BILLING") if "VERIFY_BILLING" in os.environ else True,
            demo_mode=flag("DEMO_MODE"),
            model=os.environ.get("FREE_MODEL", "gemini-3.8-flash").strip() or "gemini-3.8-flash",
            industry=clean_text(os.environ.get("TARGET_INDUSTRY", ""), 200),
            region=clean_text(os.environ.get("TARGET_REGION", ""), 200) or "any region",
            offering=clean_text(os.environ.get("SELLER_OFFERING", ""), 500),
            seller_name=clean_text(os.environ.get("SELLER_NAME", ""), 120),
            icp=clean_text(os.environ.get("IDEAL_CUSTOMER_PROFILE", ""), 500)
            or "Operating companies with a public signal of the problem this offering addresses",
            research_company=clean_text(os.environ.get("RESEARCH_COMPANY", ""), 200),
            research_domain=clean_text(os.environ.get("RESEARCH_DOMAIN", ""), 200),
            max_leads=min(15, max(1, max_leads)),
            grounding_calls_per_run=min(8, max(3, per_run)),
            request_timeout_seconds=min(180, max(15, timeout)),
            output_dir=Path(os.environ.get("LEADGEN_OUTPUT_DIR") or (root / "output")),
        )
