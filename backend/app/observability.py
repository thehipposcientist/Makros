"""Backend Sentry + per-route timing.

Wiring (when you're ready):

  1. `pip install sentry-sdk[fastapi]` (add to requirements.txt)
  2. Set `SENTRY_DSN=https://...@sentry.io/...` in backend/.env
  3. The `init_observability()` call in main.py picks it up.

Until either of those is true this module no-ops — same shape as the
client-side `observability.ts` so the rest of the codebase can call
`capture_exception()` freely without breaking when Sentry isn't
installed.

Per-route latency: the `LatencyLoggerMiddleware` logs slow requests
to the existing app logger. We instrument a small set of hot paths
(`/meals/score`, `/workouts/weekly-review`, `/ai/fitness/composite-score`)
with tighter thresholds because they're the most expensive and the most
user-visible. Other routes use a softer ceiling.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger("app.observability")

_sentry_initialized = False
_sentry_sdk: Any = None


def _load_sentry() -> Any:
    """Try-import sentry_sdk. Returns the module or None."""
    global _sentry_sdk
    if _sentry_sdk is not None:
        return _sentry_sdk
    try:
        import sentry_sdk as mod
        _sentry_sdk = mod
        return mod
    except ImportError:
        return None


def init_observability(app: Any) -> None:
    """Initialize Sentry + attach latency middleware. Safe to call when
    sentry_sdk isn't installed or SENTRY_DSN isn't set — does nothing.
    """
    global _sentry_initialized
    if _sentry_initialized:
        return
    _sentry_initialized = True

    dsn = os.getenv("SENTRY_DSN")
    if dsn:
        sdk = _load_sentry()
        if sdk is None:
            logger.warning("SENTRY_DSN is set but sentry-sdk is not installed; skipping init")
        else:
            try:
                # FastAPI integration is auto-detected when sentry_sdk[fastapi]
                # is the install extras. We pass tracesSampleRate small in prod
                # so we don't pay for full-trace ingest on every request.
                sdk.init(
                    dsn=dsn,
                    environment=os.getenv("APP_ENV", "production"),
                    release=os.getenv("APP_VERSION") or None,
                    traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.05")),
                    send_default_pii=False,
                )
                logger.info("sentry_initialized")
            except Exception as e:  # pragma: no cover — defensive only
                logger.warning("sentry_init_failed: %s", e)

    # Always attach the latency middleware — even without Sentry it
    # writes to the app logger so you can grep "slow_route" in logs.
    try:
        app.add_middleware(LatencyLoggerMiddleware)
    except Exception as e:
        logger.warning("latency_middleware_attach_failed: %s", e)


def capture_exception(err: BaseException, **ctx: Any) -> None:
    """Capture an unexpected exception. No-op when Sentry isn't installed."""
    sdk = _load_sentry()
    if sdk is None:
        # Useful in dev: log what would be captured.
        logger.debug("would_capture: %s ctx=%s", err, ctx)
        return
    try:
        if ctx:
            with sdk.push_scope() as scope:
                for k, v in ctx.items():
                    scope.set_extra(k, v)
                sdk.capture_exception(err)
        else:
            sdk.capture_exception(err)
    except Exception:
        pass  # never let Sentry break a request


def capture_message(msg: str, level: str = "info") -> None:
    """Capture a non-error event."""
    sdk = _load_sentry()
    if sdk is None:
        return
    try:
        sdk.capture_message(msg, level=level)
    except Exception:
        pass


# ─── Per-route latency budgets ──────────────────────────────────────────────
#
# Routes that touch many tables / call OpenAI tend to dominate p99
# latency. Logging anything over the budget gives us a "slow_route"
# searchable in app logs without per-route hand-instrumentation.

# (path_prefix, budget_ms). Order matters — first match wins.
_LATENCY_BUDGETS_MS: tuple[tuple[str, int], ...] = (
    ("/meals/score", 800),
    ("/workouts/weekly-review", 1500),
    ("/ai/fitness/composite-score", 1500),
    ("/ai/", 3000),
    ("/coach/", 3000),
    ("/meals/", 600),
    ("/workouts/", 600),
)
_DEFAULT_BUDGET_MS = 1200


def _budget_for_path(path: str) -> int:
    for prefix, budget in _LATENCY_BUDGETS_MS:
        if path.startswith(prefix):
            return budget
    return _DEFAULT_BUDGET_MS


class LatencyLoggerMiddleware:
    """ASGI middleware. Logs `slow_route` for any route that exceeds its
    budget. Quietly times every request; the logger filter you ship in
    prod decides what to keep.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "") or ""
        method = scope.get("method", "GET")
        start = time.perf_counter()
        status_code = 500
        # Wrap `send` so we can read the status without re-handling the body.
        async def _send(message: dict) -> None:
            nonlocal status_code
            if message.get("type") == "http.response.start":
                status_code = int(message.get("status", 500))
            await send(message)
        try:
            await self.app(scope, receive, _send)
        finally:
            ms = int((time.perf_counter() - start) * 1000)
            budget = _budget_for_path(path)
            if ms >= budget:
                logger.warning(
                    "slow_route path=%s method=%s status=%s ms=%s budget_ms=%s",
                    path, method, status_code, ms, budget,
                )
