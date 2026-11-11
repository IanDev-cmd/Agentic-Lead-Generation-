"""Choose paid Deep Research, the free Flash loop, or the local demo cache.

Google's API does not return a billing-account boolean for an AI Studio key.
BILLING_ENABLED is the explicit opt-in for the paid agent. A short Flash call can
veto that opt-in when the key is rejected or the error says billing is required.
It cannot prove that Deep Research is prepaid.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fallback.config import Settings, is_placeholder
from fallback.scan import RepoScan

log = logging.getLogger("fallback.decide")


class RouteError(RuntimeError):
    pass


@dataclass(frozen=True)
class Decision:
    route: str
    reasons: list[str]


def decide(settings: Settings, scan: RepoScan) -> Decision:
    reasons: list[str] = []
    if settings.demo_mode:
        reasons.append("DEMO_MODE=true. Loading the local JSON lead cache and skipping Gemini.")
        return Decision("demo", reasons)

    _require_key(settings)

    if settings.force_free or not scan.paid_entrypoint or not settings.billing_enabled:
        if settings.force_free:
            reasons.append("FORCE_FREE_TIER=true.")
        if not scan.paid_entrypoint:
            reasons.append("The Deep Research interactions.create path was not found in index.js.")
        if not settings.billing_enabled:
            reasons.append("BILLING_ENABLED is not true, so the paid agent is not selected.")
        return Decision("free", reasons)

    if settings.verify_billing:
        status = probe_key(settings)
        reasons.append(f"Key probe returned {status}.")
        if status == "billing_blocked":
            reasons.append("The API reported a billing block. Falling back to Flash.")
            return Decision("free", reasons)
        if status == "invalid_key":
            raise RouteError("GEMINI_API_KEY was rejected by the Gemini API.")
        if status == "error":
            reasons.append("The billing probe failed. Falling back to Flash instead of starting Deep Research.")
            return Decision("free", reasons)
        if status == "sdk_missing":
            reasons.append("Python google-genai is not installed. The paid path will use the Node SDK.")

    reasons.append("BILLING_ENABLED=true and index.js still contains the Deep Research path.")
    return Decision("paid", reasons)


def _require_key(settings: Settings) -> None:
    if settings.key_usable:
        return
    if not settings.api_key or is_placeholder(settings.api_key):
        raise RouteError("Set GEMINI_API_KEY in .env, or set DEMO_MODE=true to use the local lead cache.")
    raise RouteError("GEMINI_API_KEY is empty.")


def probe_key(settings: Settings) -> str:
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        log.warning("google-genai is not installed; skipping the Python billing probe.")
        return "sdk_missing"
    try:
        client = genai.Client(api_key=settings.api_key)
        client.models.generate_content(
            model=settings.model,
            contents="Reply with the single word ok.",
            config=types.GenerateContentConfig(max_output_tokens=16, temperature=0),
        )
        return "ok"
    except Exception as exc:  # noqa: BLE001 - the SDK raises several error types
        text = str(exc).lower()
        log.warning("Key probe failed: %s", _redact(text, settings.api_key))
        if any(token in text for token in ("api key", "api_key", "invalid", "unauthorized", "401", "permission denied")):
            if "billing" not in text:
                return "invalid_key"
        if any(token in text for token in ("billing", "prepay", "payment required", "quota")):
            return "billing_blocked"
        return "error"


def _redact(text: str, secret: str) -> str:
    if secret:
        text = text.replace(secret, "[redacted]")
    return text[:300]
