"""Local counter for Gemini Search grounding so one run cannot spend the free allotment.

Published Gemini Developer API limits (confirm on the pricing page before raising them):
- gemini-2.5-flash and Flash-Lite share 500 grounded requests per day on the free tier.
- Gemini 3 and newer models share 5,000 grounded requests per month, with a 1,500 request daily cap.
gemini-1.5-flash is treated with the stricter daily cap. This file cannot see usage from other apps.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

QUOTA_TZ = ZoneInfo("America/Los_Angeles")


class QuotaExceeded(RuntimeError):
    pass


@dataclass
class ModelQuota:
    daily_cap: int
    monthly_cap: int | None
    note: str


def limits_for(model: str) -> ModelQuota:
    name = model.lower()
    if "gemini-3" in name:
        return ModelQuota(
            daily_cap=1500,
            monthly_cap=5000,
            note="Gemini 3 free grounding is 5,000 requests per month and 1,500 per day, shared across Gemini 3 models.",
        )
    return ModelQuota(
        daily_cap=500,
        monthly_cap=None,
        note="gemini-2.5-flash free grounding is 500 requests per day, shared with Flash-Lite. The 5,000/month figure is for Gemini 3 and newer, so it is not applied here.",
    )


class GroundingQuota:
    def __init__(self, path: Path, model: str, per_run_cap: int) -> None:
        self.path = path
        self.model = model
        self.limits = limits_for(model)
        self.per_run_cap = per_run_cap
        self.used_this_run = 0
        self._load()

    def allow(self) -> bool:
        under_month = self.limits.monthly_cap is None or self.month_count < self.limits.monthly_cap
        return self.used_this_run < self.per_run_cap and self.day_count < self.limits.daily_cap and under_month

    def commit(self) -> None:
        if not self.allow():
            raise QuotaExceeded(self.limits.note)
        self.used_this_run += 1
        self.day_count += 1
        self.month_count += 1
        self._save()

    def exhaust_today(self) -> None:
        self.day_count = self.limits.daily_cap
        self._save()

    def _load(self) -> None:
        now = datetime.now(QUOTA_TZ)
        self.day_key = now.strftime("%Y-%m-%d")
        self.month_key = now.strftime("%Y-%m")
        self.day_count = 0
        self.month_count = 0
        if not self.path.is_file():
            return
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if saved.get("day") == self.day_key:
            self.day_count = int(saved.get("day_count") or 0)
        if saved.get("month") == self.month_key:
            self.month_count = int(saved.get("month_count") or 0)

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(
                {
                    "model": self.model,
                    "day": self.day_key,
                    "day_count": self.day_count,
                    "month": self.month_key,
                    "month_count": self.month_count,
                    "daily_cap": self.limits.daily_cap,
                    "monthly_cap": self.limits.monthly_cap,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
