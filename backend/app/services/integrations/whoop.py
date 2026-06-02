"""WHOOP provider.

Status: **OAuth scaffold ready, sync stubbed.** WHOOP uses OAuth 2.0
with developer credentials gated on a partner agreement.

Setup once you have credentials:
  1. Set `WHOOP_CLIENT_ID` + `WHOOP_CLIENT_SECRET` in backend/.env
  2. Set `WHOOP_REDIRECT_URI` (e.g. https://<api>/integrations/whoop/callback)
  3. Register at https://developer.whoop.com/
  4. Frontend "Connect WHOOP" lights up.

What ships from WHOOP:
  - Daily recovery → DailyHealthSnapshot.recovery_score
  - Daily strain → DailyHealthSnapshot.strain (new field — or
    `extra_metrics` JSON)
  - Sleep performance → SleepLog
  - HRV + RHR → DailyHealthSnapshot
  - Per-workout cycles → WorkoutCompletion
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

from app.services.integrations.base import (
    SyncResult,
    TokenSet,
    WearableProvider,
)


_WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
_WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
_WHOOP_SCOPE = "read:recovery read:cycles read:workout read:sleep read:profile"


class WhoopProvider(WearableProvider):
    slug = "whoop"
    display_name = "WHOOP"
    capabilities = ("sleep", "readiness", "strain", "heart_rate")

    @property
    def is_configured(self) -> bool:
        return bool(os.getenv("WHOOP_CLIENT_ID") and os.getenv("WHOOP_CLIENT_SECRET"))

    def authorize_url(self, state: str) -> str:
        return f"{_WHOOP_AUTHORIZE_URL}?" + urlencode({
            "client_id": os.getenv("WHOOP_CLIENT_ID", ""),
            "redirect_uri": os.getenv("WHOOP_REDIRECT_URI", ""),
            "response_type": "code",
            "scope": _WHOOP_SCOPE,
            "state": state,
        })

    def exchange_code(self, code: str) -> TokenSet:
        raise NotImplementedError("WHOOP token exchange not implemented yet — credentials required")

    def refresh(self, refresh_token: str) -> TokenSet:
        raise NotImplementedError("WHOOP token refresh not implemented yet")

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        # TODO: WHOOP API v1 endpoints for recovery / cycle / sleep / workout
        # since `since`. Map recovery score into DailyHealthSnapshot.
        raise NotImplementedError("WHOOP sync not implemented yet — credentials required")
