"""Ordered free-tier Gemini models.

A 404, 429, or 503 retries the same request on the next model. Any other HTTP
status stops the chain. A fallback model that rejects Google Search or another
tool with 400 is retried once without that tool.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

log = logging.getLogger("fallback.models")

FREE_TIER_MODELS = (
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemma-4-27b-it",
)

PRIMARY_MODEL = FREE_TIER_MODELS[0]
FALLBACK_STATUSES = {404, 429, 503}
STATUS_NAMES = {
    "BAD_REQUEST": 400,
    "INVALID_ARGUMENT": 400,
    "FAILED_PRECONDITION": 400,
    "UNAUTHENTICATED": 401,
    "PERMISSION_DENIED": 403,
    "NOT_FOUND": 404,
    "RESOURCE_EXHAUSTED": 429,
    "UNAVAILABLE": 503,
    "OVERLOADED": 503,
}


def model_chain(preferred: str | None = None) -> list[str]:
    if preferred is None:
        requested = os.environ.get("FREE_MODEL", "").strip()
    else:
        requested = str(preferred).strip()
    if requested in FREE_TIER_MODELS:
        start = FREE_TIER_MODELS.index(requested)
        if start > 0:
            return list(FREE_TIER_MODELS[start:])
    return list(FREE_TIER_MODELS)


def http_status(exc: BaseException) -> int:
    for attr in ("status", "status_code", "code"):
        status = _normalize_status(getattr(exc, attr, None))
        if status:
            return status
    response = getattr(exc, "response", None)
    status = _normalize_status(getattr(response, "status_code", None))
    if status:
        return status
    text = str(exc)
    match = re.search(r'"code"\s*:\s*(\d{3})', text)
    if match:
        return int(match.group(1))
    named = re.search(r'"status"\s*:\s*"([A-Z_]+)"', text)
    if named and named.group(1) in STATUS_NAMES:
        return STATUS_NAMES[named.group(1)]
    return 0


def generate_with_fallback(client: Any, *, contents: Any, config: Any, model: str | None = None, models: list[str] | None = None) -> Any:
    chain = list(models) if models is not None else model_chain(model)
    if not chain:
        raise RuntimeError("No Gemini model is configured.")
    last_error: BaseException | None = None
    for index, name in enumerate(chain):
        try:
            return client.models.generate_content(model=name, contents=contents, config=config)
        except Exception as exc:  # noqa: BLE001 - the SDK raises several error types
            last_error = exc
            status = http_status(exc)
            if index > 0 and status == 400 and _has_tools(config):
                log.warning("Gemini model %s rejected a tool or grounding feature (HTTP 400). Retrying without tools.", name)
                try:
                    return client.models.generate_content(
                        model=name,
                        contents=contents,
                        config=_without_tools(config),
                    )
                except Exception as stripped:  # noqa: BLE001
                    last_error = stripped
                    stripped_status = http_status(stripped)
                    if stripped_status in FALLBACK_STATUSES and index < len(chain) - 1:
                        _warn_switch(name, stripped_status)
                        continue
                    raise
            if status in FALLBACK_STATUSES and index < len(chain) - 1:
                _warn_switch(name, status)
                continue
            raise
    if last_error is None:
        raise RuntimeError("No Gemini model is configured.")
    raise last_error


def _warn_switch(model: str, status: int) -> None:
    log.warning(
        "Gemini model %s failed with HTTP %s. Retrying the same request on the next free-tier model.",
        model,
        status,
    )


def _normalize_status(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and 400 <= value <= 599:
        return value
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed.isdigit() and len(trimmed) == 3:
            code = int(trimmed)
            if 400 <= code <= 599:
                return code
        if trimmed in STATUS_NAMES:
            return STATUS_NAMES[trimmed]
    return 0


def _has_tools(config: Any) -> bool:
    if config is None:
        return False
    if isinstance(config, dict):
        return bool(config.get("tools"))
    return bool(getattr(config, "tools", None))


def _without_tools(config: Any) -> Any:
    if isinstance(config, dict):
        rest = {key: value for key, value in config.items() if key != "tools"}
        return rest or None
    if hasattr(config, "model_copy"):
        return config.model_copy(update={"tools": None})
    return config
