"""Strava provider — wraps the existing strava_oauth module.

This is the reference implementation for the WearableProvider pattern.
Strava OAuth was wired up in `app/strava_oauth.py` before the
abstraction layer existed; the wrapper preserves that working code
without forcing a rewrite.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from app.services.integrations.base import (
    SyncResult,
    TokenSet,
    WearableProvider,
)


class StravaProvider(WearableProvider):
    slug = "strava"
    display_name = "Strava"
    capabilities = ("activities", "heart_rate")

    @property
    def is_configured(self) -> bool:
        return bool(os.getenv("STRAVA_CLIENT_ID") and os.getenv("STRAVA_CLIENT_SECRET"))

    def authorize_url(self, state: str) -> str:
        from app.services.imports.strava_client import build_authorize_url
        url = build_authorize_url(state)
        if url is None:
            raise RuntimeError("strava authorize url unavailable")
        return url

    def exchange_code(self, code: str) -> TokenSet:
        from app.services.imports.strava_client import exchange_code_for_tokens
        raw = exchange_code_for_tokens(code)
        # Strava's response shape includes expires_at as epoch seconds.
        expires_at = None
        try:
            if raw.get("expires_at"):
                expires_at = datetime.fromtimestamp(int(raw["expires_at"]))
        except Exception:
            pass
        athlete = raw.get("athlete") or {}
        return TokenSet(
            access_token=raw.get("access_token") or "",
            refresh_token=raw.get("refresh_token"),
            expires_at=expires_at,
            external_user_id=str(athlete.get("id") or "") or None,
            extras={"scope": raw.get("scope")},
        )

    def refresh(self, refresh_token: str) -> TokenSet:
        # Strava client module exposes refresh via its OAuth helper.
        from app.services.imports.strava_client import refresh_tokens  # type: ignore
        raw = refresh_tokens(refresh_token)
        expires_at = None
        try:
            if raw.get("expires_at"):
                expires_at = datetime.fromtimestamp(int(raw["expires_at"]))
        except Exception:
            pass
        return TokenSet(
            access_token=raw.get("access_token") or "",
            refresh_token=raw.get("refresh_token"),
            expires_at=expires_at,
        )

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        # The Strava backfill pipeline already implements the full sync;
        # delegate to it so we don't duplicate the pagination logic.
        from app.services.imports.strava_pipeline import run_strava_backfill
        try:
            # Pipeline expects `days` rather than a since-cutoff; convert.
            from datetime import datetime as _dt, timezone as _tz
            days = max(1, (_dt.now(_tz.utc) - since).days)
            batch = run_strava_backfill(db, user_id=user_id, days=days)
            count = int(getattr(batch, "rows_imported", 0) or 0)
            return SyncResult(activities_imported=count)
        except Exception as e:
            return SyncResult(errors=1, error_messages=[str(e)])
