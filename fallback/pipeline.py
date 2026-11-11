"""Free Flash loop: plan three searches, ground them, review, emit the lead table.

Search uses the official Gemini Google Search tool. This module does not browse
social sites, inject session cookies, or send messages.
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from fallback.config import Settings, is_placeholder
from fallback.quota import GroundingQuota, QuotaExceeded

log = logging.getLogger("fallback.pipeline")

TABLE_HEADER = (
    "| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email "
    "| Pain Point | Hook | Priority | Source |"
)
LEAD_KEYS = (
    "company",
    "domain",
    "hqAddress",
    "contactName",
    "contactTitle",
    "contactEmail",
    "painPoint",
    "hook",
    "priority",
    "source",
)


class PipelineError(RuntimeError):
    pass


def run_demo(settings: Settings) -> dict:
    payload = json.loads((settings.root / "fallback" / "demo_leads.json").read_text(encoding="utf-8"))
    leads = payload.get("leads") or []
    if not leads:
        raise PipelineError("fallback/demo_leads.json has no leads.")
    markdown = render_markdown(leads)
    record = _record(settings, "demo-cache", f"demo-{_stamp()}", "demo cache", markdown)
    finish(settings, record)
    return record


def run_free(settings: Settings) -> dict:
    if not settings.offering or is_placeholder(settings.offering) or not settings.industry or is_placeholder(settings.industry):
        raise PipelineError("Set SELLER_OFFERING and TARGET_INDUSTRY before a free-tier research run.")
    quota = GroundingQuota(
        settings.root / "output" / "grounding-quota.json",
        settings.model,
        settings.grounding_calls_per_run,
    )
    log.info("%s", quota.limits.note)
    client = _client(settings)
    strategies = plan_searches(client, settings)
    findings = search_strategies(client, settings, quota, strategies)
    extra = review_findings(client, settings, findings)
    if extra and quota.allow():
        log.info("Reviewer requested %s validation search(es).", len(extra))
        findings.extend(search_strategies(client, settings, quota, extra))
    elif extra:
        log.warning("Skipping validation searches because the free grounding cap is reached.")
    if not any(item.get("text") for item in findings):
        raise PipelineError("Google Search grounding returned no usable text.")
    markdown = synthesize(client, settings, findings)
    if not _has_lead_table(markdown):
        log.warning("Synthesis missed the lead table. Asking Flash to repair the markdown.")
        markdown = repair_table(client, settings, markdown)
    record = _record(settings, settings.model, f"free-{_stamp()}", _query_summary(settings), markdown)
    finish(settings, record)
    return record


def _focus_line(settings: Settings) -> str:
    if not settings.research_company:
        return ""
    domain = f" ({settings.research_domain})" if settings.research_domain else ""
    return f"\nFocus this run on one company: {settings.research_company}{domain}. Use public sources about that company."


def plan_searches(client, settings: Settings) -> list[str]:
    prompt = f"""
Break this ideal-customer search into exactly 3 public web search queries.
Industry: {settings.industry}
Region: {settings.region}
Offering: {settings.offering}
Ideal customer: {settings.icp}{_focus_line(settings)}

Return only JSON of the form {{"strategies": ["query 1", "query 2", "query 3"]}}.
Each query looks for companies and a public operating problem. Do not search for personal email addresses, phone numbers, or private profiles.
""".strip()
    try:
        raw = _generate(client, settings, prompt, grounded=False, max_tokens=800, temperature=0.2)
        parsed = _parse_json(raw)
        queries = [str(item).strip() for item in parsed.get("strategies", []) if str(item).strip()]
    except (PipelineError, json.JSONDecodeError, TypeError, AttributeError) as exc:
        log.warning("Planner output was unusable (%s). Using three local queries.", exc)
        queries = []
    queries = [query for query in queries if not _looks_like_contact_harvest(query)][:3]
    if len(queries) < 3:
        queries = _local_queries(settings)
    log.info("Search strategies: %s", queries)
    return queries[:3]


def search_strategies(client, settings: Settings, quota: GroundingQuota, queries: list[str]) -> list[dict]:
    findings = []
    for query in queries:
        if not quota.allow():
            log.warning("Stopping search. Free grounding cap reached (%s this run).", quota.used_this_run)
            break
        prompt = (
            "Use Google Search to find public company information for this query. "
            "Summarize only companies a member of the public could identify. "
            "If a fact is not on the open web, say unknown. Do not invent email addresses. "
            f"Return at most {settings.max_leads} companies.\n\nQuery: {query}"
        )
        try:
            text, sources = _grounded_generate(client, settings, quota, prompt)
        except QuotaExceeded as exc:
            log.warning("%s", exc)
            break
        except PipelineError as exc:
            log.warning("Search failed for %r: %s", query, exc)
            continue
        findings.append({"query": query, "text": text, "sources": sources})
    return findings


def review_findings(client, settings: Settings, findings: list[dict]) -> list[str]:
    if not findings:
        return []
    prompt = f"""
You are reviewing public research notes for a lead list.
Decide whether the notes already contain enough distinct companies to stop, or whether one or two more public searches are required.
Maximum companies wanted: {settings.max_leads}

Notes:
{_notes(findings)}

Return only JSON: {{"enough": true, "validation_queries": []}}
Use at most 2 validation queries. Leave the array empty when enough is true.
Do not request searches for personal emails or private profiles.
""".strip()
    try:
        raw = _generate(client, settings, prompt, grounded=False, max_tokens=600, temperature=0.2)
        parsed = _parse_json(raw)
    except (PipelineError, json.JSONDecodeError, TypeError, AttributeError) as exc:
        log.warning("Reviewer output was unusable (%s). Stopping after the first searches.", exc)
        return []
    if parsed.get("enough") is True:
        log.info("Reviewer accepted the research notes.")
        return []
    queries = [str(item).strip() for item in parsed.get("validation_queries") or [] if str(item).strip()]
    return [query for query in queries if not _looks_like_contact_harvest(query)][:2]


def synthesize(client, settings: Settings, findings: list[dict]) -> str:
    prompt = f"""
Turn these public research notes into a lead list for this offering: {settings.offering}
Ideal customer: {settings.icp}{_focus_line(settings)}
Maximum rows: {settings.max_leads}

Notes:
{_notes(findings)}

Rules:
- Use only facts present in the notes. If a field is missing, write exactly "unknown".
- Never invent an email address, phone number, or quotation.
- Mark Priority as High only when both the pain point and the hook are tied to a public source in the notes. Otherwise use Medium or Low.

Start with this GitHub-flavored table and no prose before it:
{TABLE_HEADER}

After the table, for every High priority company, add:
## Briefing: {{Company}}
Three short paragraphs: what the company does, the sourced pain point, and the public hook.
""".strip()
    return _generate(client, settings, prompt, grounded=False, max_tokens=4096, temperature=0.2)


def repair_table(client, settings: Settings, markdown: str) -> str:
    prompt = (
        "Rewrite the following as the required lead table. Do not add companies or emails that are not already present. "
        "Missing fields stay unknown.\n\n"
        f"{TABLE_HEADER}\n\n{markdown[:12000]}"
    )
    return _generate(client, settings, prompt, grounded=False, max_tokens=4096, temperature=0)


def finish(settings: Settings, record: dict) -> str:
    output = settings.output_dir
    output.mkdir(parents=True, exist_ok=True)
    markdown_path = output / "last-report.md"
    meta_path = output / "last-report.json"
    markdown_path.write_text(record["markdown"], encoding="utf-8")
    meta_path.write_text(
        json.dumps(
            {
                "interactionId": record["interactionId"],
                "agent": record["agent"],
                "generatedAt": record["generatedAt"],
                "query": record["query"],
                "seller": {"name": settings.seller_name, "offering": settings.offering},
                "route": record["agent"],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    log.info("Saved report (%s chars) to %s", len(record["markdown"]), markdown_path)
    if not _has_lead_table(record["markdown"]):
        raise PipelineError("Report has no lead table. The webhook was not called.")
    if settings.webhook_url and not is_placeholder(settings.webhook_url):
        post_webhook(settings, record)
    else:
        reason = (
            "GOOGLE_WEBHOOK_URL is still a placeholder. Nothing was written to Sheets."
            if settings.webhook_url
            else "GOOGLE_WEBHOOK_URL is empty. Nothing was written to Sheets."
        )
        _write_webhook_result(settings, {"ok": False, "synced": False, "error": reason})
        log.info(reason)
    return str(markdown_path)


def _write_webhook_result(settings: Settings, payload: dict) -> None:
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    safe = {key: value for key, value in payload.items() if key != "secret"}
    (settings.output_dir / "last-webhook.json").write_text(json.dumps(safe, indent=2), encoding="utf-8")


class _ManualRedirect(urllib.request.HTTPRedirectHandler):
    """Leave 3xx responses in place so the caller can POST again with the same body."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

    def http_error_302(self, req, fp, code, msg, headers):
        return fp

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _open_request(opener, request, timeout: int) -> tuple[int, str, str]:
    try:
        with opener.open(request, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            raw = response.read().decode("utf-8", errors="replace")
            location = response.headers.get("Location") or ""
            return status, raw, location
    except urllib.error.HTTPError as exc:
        location = exc.headers.get("Location") if exc.headers else ""
        return exc.code, exc.read().decode("utf-8", errors="replace"), location or ""


def _json_ok(raw: str) -> bool:
    try:
        return json.loads(raw).get("ok") is True
    except (json.JSONDecodeError, AttributeError, TypeError):
        return False


def _is_json(raw: str) -> bool:
    try:
        json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return False
    return True


def _post_preserving_redirect(url: str, body: bytes, headers: dict, timeout: int, hops: int = 5) -> tuple[int, str]:
    del hops
    opener = urllib.request.build_opener(_ManualRedirect)
    status, raw, location = _open_request(
        opener,
        urllib.request.Request(url, data=body, headers=headers, method="POST"),
        timeout,
    )
    if status not in (301, 302, 303, 307, 308):
        return status, raw
    if not location:
        raise PipelineError("Apps Script redirected without a new address.")
    echo = urllib.parse.urljoin(url, location)
    get_status, get_raw, _get_location = _open_request(
        opener,
        urllib.request.Request(echo, method="GET"),
        timeout,
    )
    if _json_ok(get_raw):
        return get_status, get_raw
    post_status, post_raw, _post_location = _open_request(
        opener,
        urllib.request.Request(echo, data=body, headers=headers, method="POST"),
        timeout,
    )
    if _json_ok(post_raw) or _is_json(post_raw):
        return post_status, post_raw
    if _is_json(get_raw):
        return get_status, get_raw
    return post_status, post_raw


def post_webhook(settings: Settings, record: dict) -> None:
    if not settings.webhook_url.startswith("https://") or is_placeholder(settings.webhook_url):
        raise PipelineError("GOOGLE_WEBHOOK_URL must be the https Apps Script /exec URL.")
    if len(settings.webhook_secret) < 16 or is_placeholder(settings.webhook_secret):
        raise PipelineError("Set WEBHOOK_SECRET to at least 16 characters before posting.")
    body = json.dumps(
        {
            "interactionId": record["interactionId"],
            "agent": record["agent"],
            "generatedAt": record["generatedAt"],
            "query": record["query"],
            "seller": {"name": settings.seller_name, "offering": settings.offering},
            "markdown": record["markdown"],
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-Webhook-Secret": settings.webhook_secret}
    delay = 1.0
    last_error: Exception | None = None
    for attempt in range(1, 5):
        try:
            status, raw = _post_preserving_redirect(
                settings.webhook_url,
                body,
                headers,
                settings.request_timeout_seconds,
            )
            payload = json.loads(raw)
            if status >= 400 or payload.get("ok") is False:
                raise PipelineError(str(payload.get("error") or f"Webhook failed with HTTP {status}"))
            _write_webhook_result(
                settings,
                {"ok": True, "synced": True, "interactionId": record["interactionId"], "appsScript": payload},
            )
            log.info("Webhook accepted the report: %s", json.dumps({k: payload[k] for k in payload if k != "secret"}))
            return
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, PipelineError) as exc:
            last_error = exc
            retryable = _retryable(exc)
            if not retryable or attempt == 4:
                break
            log.warning("Webhook attempt %s failed: %s", attempt, exc)
            time.sleep(delay)
            delay = min(16.0, delay * 2)
    _write_webhook_result(settings, {"ok": False, "synced": False, "error": f"Webhook failed: {last_error}"})
    raise PipelineError(f"Webhook failed: {last_error}")


def render_markdown(leads: list[dict]) -> str:
    lines = [TABLE_HEADER, "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    briefings = []
    for lead in leads:
        lines.append("| " + " | ".join(_cell(lead.get(key, "")) for key in LEAD_KEYS) + " |")
        briefing = str(lead.get("briefing") or "").strip()
        priority = str(lead.get("priority") or "")
        company = str(lead.get("company") or "").strip()
        if briefing and priority.lower().startswith("high") and company:
            briefings.append(f"## Briefing: {company}\n\n{briefing}")
    return "\n".join(lines + ([""] if briefings else []) + briefings).strip() + "\n"


def _client(settings: Settings):
    try:
        from google import genai
    except ImportError as exc:
        raise PipelineError(
            "Install the free-tier SDK with: py -m pip install -r fallback/requirements.txt"
        ) from exc
    return genai.Client(api_key=settings.api_key)


def _generate(client, settings: Settings, prompt: str, *, grounded: bool, max_tokens: int, temperature: float) -> str:
    from google.genai import types

    config_kwargs = {"max_output_tokens": max_tokens, "temperature": temperature}
    if grounded:
        config_kwargs["tools"] = [types.Tool(google_search=types.GoogleSearch())]
        config_kwargs["temperature"] = 1.0
    delay = 2.0
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            response = client.models.generate_content(
                model=settings.model,
                contents=prompt,
                config=types.GenerateContentConfig(**config_kwargs),
            )
            text = (getattr(response, "text", None) or "").strip()
            if not text:
                raise PipelineError("The model returned an empty response.")
            return text
        except PipelineError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if not _retryable(exc) or attempt == 3:
                break
            log.warning("Model call failed (%s). Retrying in %.0fs.", exc, delay)
            time.sleep(delay)
            delay = min(20.0, delay * 2)
    raise PipelineError(str(last_error or "model call failed"))


def _grounded_generate(client, settings: Settings, quota: GroundingQuota, prompt: str) -> tuple[str, list[str]]:
    from google.genai import types

    delay = 2.0
    last_error: Exception | None = None
    for attempt in range(1, 4):
        if not quota.allow():
            raise QuotaExceeded(quota.limits.note)
        try:
            response = client.models.generate_content(
                model=settings.model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    tools=[types.Tool(google_search=types.GoogleSearch())],
                    temperature=1.0,
                    max_output_tokens=2048,
                ),
            )
            quota.commit()
            text = (getattr(response, "text", None) or "").strip()
            if not text:
                raise PipelineError("Grounded search returned an empty response.")
            return text, _sources(response)
        except QuotaExceeded:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if _quota_exhausted(exc):
                quota.exhaust_today()
                raise QuotaExceeded(str(exc)) from exc
            if not _retryable(exc) or attempt == 3:
                break
            log.warning("Grounded search failed (%s). Retrying in %.0fs.", exc, delay)
            time.sleep(delay)
            delay = min(20.0, delay * 2)
    raise PipelineError(str(last_error or "grounded search failed"))


def _sources(response) -> list[str]:
    urls: list[str] = []
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return urls
    metadata = getattr(candidates[0], "grounding_metadata", None)
    chunks = getattr(metadata, "grounding_chunks", None) or []
    for chunk in chunks:
        web = getattr(chunk, "web", None)
        uri = getattr(web, "uri", None)
        if uri:
            urls.append(str(uri))
    return urls[:8]


def _parse_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not match:
            raise
        value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise PipelineError("Model JSON was not an object.")
    return value


def _notes(findings: list[dict]) -> str:
    blocks = []
    for item in findings:
        sources = ", ".join(item.get("sources") or []) or "none returned"
        blocks.append(f"Query: {item.get('query')}\nSources: {sources}\n{item.get('text')}")
    return "\n\n".join(blocks)[:24000]


def _local_queries(settings: Settings) -> list[str]:
    return [
        f"{settings.industry} companies in {settings.region} operations challenges",
        f"{settings.industry} {settings.region} hiring operations or revenue operations",
        f"{settings.icp} {settings.region} public case study",
    ]


def _looks_like_contact_harvest(query: str) -> bool:
    lowered = query.lower()
    return any(token in lowered for token in ("email list", "personal email", "phone list", "scrape emails"))


def _cell(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip() or "unknown"
    return text.replace("|", "\\|")


def _has_lead_table(markdown: str) -> bool:
    return any("|" in line and "company" in line.lower() and "pain" in line.lower() for line in markdown.splitlines())


def _record(settings: Settings, agent: str, interaction_id: str, query: str, markdown: str) -> dict:
    return {
        "interactionId": interaction_id,
        "agent": agent,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "query": query,
        "markdown": markdown if markdown.endswith("\n") else markdown + "\n",
        "seller": settings.seller_name,
    }


def _query_summary(settings: Settings) -> str:
    return f"{settings.industry} | {settings.region} | {settings.icp}"


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def _retryable(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(token in text for token in ("429", "500", "502", "503", "504", "timeout", "unavailable", "connection"))


def _quota_exhausted(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(token in text for token in ("resource exhausted", "quota exceeded", "rate limit"))
