"""Route a lead run to paid Deep Research, the free Flash loop, or the demo cache."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from fallback.config import Settings
from fallback.decide import RouteError, decide
from fallback.pipeline import PipelineError, run_demo, run_free
from fallback.scan import scan_repo

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("fallback")
    if os.environ.get("LEADGEN_ROUTE") == "paid":
        log.error("Refusing to route again from inside the paid Deep Research process.")
        return 1
    try:
        settings = Settings.from_env(ROOT)
        scan = scan_repo(
            ROOT,
            {
                "DEMO_MODE": settings.demo_mode,
                "BILLING_ENABLED": settings.billing_enabled,
                "FORCE_FREE_TIER": settings.force_free,
                "VERIFY_BILLING": settings.verify_billing,
            },
        )
        scan.write(ROOT / "output" / "repo-scan.json")
        log.info(
            "Scan: paid_entrypoint=%s env_files=%s database_hits=%s key_name_present=%s",
            scan.paid_entrypoint,
            len(scan.env_files),
            len(scan.database_hits),
            scan.key_name_present,
        )
        decision = decide(settings, scan)
        for reason in decision.reasons:
            log.info("Route %s: %s", decision.route, reason)
        if decision.route == "paid":
            return _run_paid()
        if decision.route == "demo":
            run_demo(settings)
            return 0
        run_free(settings)
        return 0
    except (RouteError, PipelineError) as exc:
        log.error("%s", exc)
        return 1


def _run_paid() -> int:
    node = shutil.which("node")
    if not node:
        logging.getLogger("fallback").error("node was not found on PATH. The paid path is index.js.")
        return 1
    env = os.environ.copy()
    env["LEADGEN_ROUTE"] = "paid"
    completed = subprocess.run([node, "index.js"], cwd=ROOT, env=env, check=False)
    return int(completed.returncode or 0)


if __name__ == "__main__":
    sys.exit(main())
