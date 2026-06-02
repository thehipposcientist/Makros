"""Fitbit provider.

Status: **OAuth scaffold ready, sync stubbed.** Fitbit uses OAuth 2.0
with PKCE. Self-serve developer registration at dev.fitbit.com makes
this the easiest non-Strava provider to bring up.

Setup:
  1. Register an app at https://dev.fitbit.com/apps/new
  2. Set `FITBIT_CLIENT_ID` + `FITBIT_CLIENT_SECRET` in backend/.env
  3. Set `FITBIT_REDIRECT_URI`
  4. Frontend "Connect Fitbit" lights up.

What ships from Fitbit:
  - Daily steps + active minutes → DailyHealthSnapshot
  - Sleep score + stages → SleepLog
  - HR zone minutes → enriches WorkoutCompletion.hr_summary
  - Cardio fitness score → DailyHealthSnapshot.vo2_max
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


_FITBIT_AUTHORIZE_URL = "https://www.fitbit.com/oauth2/authorize"
_FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token"
_FITBIT_SCOPE = "activity heartrate sleep profile cardio_fitness"


class FitbitProvider(WearableProvider):
    slug = "fitbit"
    display_name = "Fitbit"
    capabilities = ("activities", "heart_rate", "sleep", "vo2_max")

    @property
    def is_configured(self) -> bool:
        return bool(os.getenv("FITBIT_CLIENT_ID") and os.getenv("FITBIT_CLIENT_SECRET"))

    def authorize_url(self, state: str) -> str:
        return f"{_FITBIT_AUTHORIZE_URL}?" + urlencode({
            "client_id": os.getenv("FITBIT_CLIENT_ID", ""),
            "redirect_uri": os.getenv("FITBIT_REDIRECT_URI", ""),
            "response_type": "code",
            "scope": _FITBIT_SCOPE,
            "state": state,
        })

    def exchange_code(self, code: str) -> TokenSet:
        raise NotImplementedError("Fitbit token exchange not implemented yet — credentials required")

    def refresh(self, refresh_token: str) -> TokenSet:
        raise NotImplementedError("Fitbit token refresh not implemented yet")

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        # TODO: GET /1/user/-/activities/list.json + /1.2/user/-/sleep/list.json
        # since `since`. Aggregate HR zones into hr_summary.
        raise NotImplementedError("Fitbit sync not implemented yet — credentials required")
