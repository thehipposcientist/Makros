"""JSON structured logging + request-ID context.

Configured once at app startup. Every log line includes timestamp, level,
logger name, optional request_id, and optional user_id — easy to parse and
query in CloudWatch Logs Insights. Request-scoped fields live in a
contextvar so loggers pick them up automatically.

Usage:
    from app.logging_setup import get_logger
    logger = get_logger(__name__)
    logger.info("user_login", extra={"user_id": u.id, "outcome": "ok"})
"""
from __future__ import annotations

import json
import logging
import os
import sys
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any


_request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
_user_id_var: ContextVar[int | str | None] = ContextVar("user_id", default=None)


def set_request_context(request_id: str | None = None, user_id: int | str | None = None) -> None:
    """Populate the request-scoped log context. Called from middleware
    and optionally from auth routes once we know who the caller is."""
    if request_id is not None:
        _request_id_var.set(request_id)
    if user_id is not None:
        _user_id_var.set(user_id)


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]


class _JsonFormatter(logging.Formatter):
    """Emit one JSON object per log record. Keeps keys small + stable."""

    _RESERVED = {
        "args", "asctime", "created", "exc_info", "exc_text", "filename",
        "funcName", "levelname", "levelno", "lineno", "message", "module",
        "msecs", "msg", "name", "pathname", "process", "processName",
        "relativeCreated", "stack_info", "thread", "threadName", "taskName",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "t": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "lvl": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = _request_id_var.get()
        uid = _user_id_var.get()
        if rid:
            payload["req"] = rid
        if uid is not None:
            payload["user"] = uid
        # Merge any structured extras the caller passed via `extra={...}`.
        for k, v in record.__dict__.items():
            if k in self._RESERVED or k.startswith("_"):
                continue
            if k in payload:
                continue
            try:
                json.dumps(v)  # only include JSON-serializable values
                payload[k] = v
            except TypeError:
                payload[k] = repr(v)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: str | None = None) -> None:
    """Install the JSON formatter on the root logger. Idempotent — safe
    to call multiple times. Respects LOG_LEVEL env var, defaulting to INFO."""
    lvl_name = (level or os.getenv("LOG_LEVEL", "INFO")).upper()
    lvl = getattr(logging, lvl_name, logging.INFO)
    root = logging.getLogger()
    root.setLevel(lvl)
    # Remove any handlers the default Python config or uvicorn installed so
    # we don't double-log. Keep stdout only — CloudWatch captures it.
    for h in list(root.handlers):
        root.removeHandler(h)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root.addHandler(handler)

    # Quiet some chatty loggers that would otherwise drown structured logs.
    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Convenience helper — returns a namespaced logger. Use this
    everywhere instead of `logging.getLogger(...)` so imports stay consistent."""
    return logging.getLogger(name)
