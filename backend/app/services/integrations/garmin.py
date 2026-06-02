"""Garmin Connect provider.

Status: **OAuth scaffold ready, sync stubbed.** Garmin uses a non-
standard OAuth 1.0a flow via their Health API. You need a partner
agreement with Garmin to get production credentials — until then this
module renders as "Coming soon" because `is_configured` returns False.

Setup once you have credentials:
  1. Set `GARMIN_CONSUMER_KEY` + `GARMIN_CONSUMER_SECRET` in backend/.env
  2. Register the callback URL `https://<your-api>/integrations/garmin/callback`
     in your Garmin developer portal.
  3. The frontend's "Connect Garmin" button lights up automatically.

What ships from Garmin (in order of value for Thallo):
  - Daily summary (steps, floors, calories) → DailyHealthSnapshot
  - Detailed activities (run/ride/swim with HR + GPS) → WorkoutCompletion
  - Sleep summary + stages → SleepLog
  - VO2 max → DailyHealthSnapshot.vo2_max
  - Daily readiness ("Body Battery") → custom field on DailyHealthSnapshot

This file is intentionally lightweight; fill `sync()` once credentials
land. The OAuth handshake's main subtleties are the OAuth 1.0a flow
(unusual today) and pagination on the activity feed.
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


class GarminProvider(WearableProvider):
    slug = "garmin"
    display_name = "Garmin Connect"
    capabilities = ("activities", "heart_rate", "sleep", "vo2_max")

    @property
    def is_configured(self) -> bool:
        return bool(os.getenv("GARMIN_CONSUMER_KEY") and os.getenv("GARMIN_CONSUMER_SECRET"))

    def authorize_url(self, state: str) -> str:
        # TODO: Garmin uses OAuth 1.0a. Implement the request-token →
        # authorize → access-token dance. The `state` nonce is preserved
        # via the existing _PENDING_OAUTH_STATES map in
        # app/routers/integrations.py.
        raise NotImplementedError("Garmin OAuth 1.0a flow not implemented yet — credentials required")

    def exchange_code(self, code: str) -> TokenSet:
        raise NotImplementedError("Garmin OAuth 1.0a flow not implemented yet")

    def refresh(self, refresh_token: str) -> TokenSet:
        # Garmin OAuth 1.0a tokens don't expire; refresh is a no-op.
        return TokenSet(access_token=refresh_token or "", refresh_token=refresh_token, expires_at=None)

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        raise NotImplementedError("Garmin sync not implemented yet — credentials required")
