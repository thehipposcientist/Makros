"""Oura Ring provider.

Status: **OAuth scaffold ready, sync stubbed.** Oura supports both
OAuth 2.0 (for consumer apps) and a Personal Access Token (for
self-use). PAT is much simpler; we wire it as the primary path and
leave OAuth 2.0 for the formal partner integration.

Setup once you have credentials:
  1. Set `OURA_CLIENT_ID` + `OURA_CLIENT_SECRET` in backend/.env
  2. Register the callback URL at https://cloud.ouraring.com/v2/
  3. Frontend "Connect Oura" button lights up.

What ships from Oura (in priority order):
  - Daily readiness score → DailyHealthSnapshot.readiness_score
  - Sleep score + stages → SleepLog
  - HRV night summary → DailyHealthSnapshot.hrv_avg
  - Resting heart rate → DailyHealthSnapshot.resting_hr
  - Activity score → DailyHealthSnapshot
  - VO2 max estimate → DailyHealthSnapshot.vo2_max
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


_OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize"
_OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token"
_OURA_SCOPE = "daily heartrate workout session readiness sleep"


class OuraProvider(WearableProvider):
    slug = "oura"
    display_name = "Oura Ring"
    capabilities = ("sleep", "readiness", "heart_rate", "vo2_max")

    @property
    def is_configured(self) -> bool:
        return bool(os.getenv("OURA_CLIENT_ID") and os.getenv("OURA_CLIENT_SECRET"))

    def authorize_url(self, state: str) -> str:
        client_id = os.getenv("OURA_CLIENT_ID", "")
        redirect_uri = os.getenv("OURA_REDIRECT_URI", "")
        from urllib.parse import urlencode
        return f"{_OURA_AUTHORIZE_URL}?" + urlencode({
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": _OURA_SCOPE,
            "state": state,
        })

    def exchange_code(self, code: str) -> TokenSet:
        # TODO: POST to _OURA_TOKEN_URL with grant_type=authorization_code
        # plus the client_id/client_secret/redirect_uri/code params.
        # Oura returns access_token, refresh_token, expires_in.
        raise NotImplementedError("Oura token exchange not implemented yet — credentials required")

    def refresh(self, refresh_token: str) -> TokenSet:
        raise NotImplementedError("Oura token refresh not implemented yet")

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        # TODO: GET /v2/usercollection/daily_readiness, daily_sleep,
        # daily_hrv since `since`. Map into DailyHealthSnapshot rows.
        raise NotImplementedError("Oura sync not implemented yet — credentials required")
