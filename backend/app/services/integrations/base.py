"""WearableProvider abstract base class.

Every provider answers four questions:

  1. **Is it configured?**  Has the operator set client-id / client-secret
     in the env? If no, we shouldn't render a "Connect" button — instead
     a "Coming soon" tile.
  2. **Where does the user grant access?**  `authorize_url(state)` —
     returns the URL we open in a webview.
  3. **How do we exchange the code for tokens?**  `exchange_code(code)` —
     returns a normalized token dict the credential row can persist.
  4. **How do we pull data?**  `sync(credential, since)` — fetches new
     activity / sleep / health rows since the given cutoff and writes
     them into the existing Thallo tables (WorkoutCompletion,
     DailyHealthSnapshot, SleepLog, etc.). Idempotent.

The point of the abstraction is that the router doesn't need to know
which provider it's talking to. `get_provider("oura").authorize_url(state)`
is the same code path as `get_provider("garmin").authorize_url(state)`.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Any


class ProviderNotConfiguredError(Exception):
    """Raised when a wearable provider isn't enabled in this environment."""


@dataclass
class TokenSet:
    """Normalized OAuth token payload. Each provider returns its own
    shape; converting to this shape keeps `IntegrationCredential` writes
    uniform across providers."""
    access_token: str
    refresh_token: str | None
    expires_at: datetime | None
    external_user_id: str | None = None
    extras: dict | None = None


@dataclass
class SyncResult:
    """Outcome of a single sync run. Surfaced to the frontend so the
    user sees "12 activities imported, 0 errors" after connecting."""
    activities_imported: int = 0
    health_snapshots_imported: int = 0
    sleep_logs_imported: int = 0
    errors: int = 0
    error_messages: list[str] | None = None

    def to_dict(self) -> dict:
        return {
            "activities_imported": self.activities_imported,
            "health_snapshots_imported": self.health_snapshots_imported,
            "sleep_logs_imported": self.sleep_logs_imported,
            "errors": self.errors,
            "error_messages": self.error_messages or [],
        }


class WearableProvider(ABC):
    """Abstract base for wearable integrations.

    Subclass + register in `_PROVIDER_REGISTRY` in this package's
    `__init__.py`. Until then the provider is invisible to the router.
    """

    #: Stable URL slug. Must match `IntegrationCredential.provider`.
    slug: str = ""
    #: Human-readable name shown in UI.
    display_name: str = ""
    #: Capabilities the provider supports. Used to drive a feature
    #: matrix on the Connect screen. Recognized values:
    #:   "activities"    — running, cycling, etc.
    #:   "heart_rate"    — zone minutes, avg/max HR
    #:   "sleep"         — total time, stages
    #:   "readiness"     — daily readiness/recovery score
    #:   "strain"        — daily training load
    #:   "vo2_max"       — estimated VO2 max
    capabilities: tuple[str, ...] = ()

    @property
    @abstractmethod
    def is_configured(self) -> bool:
        """True iff the env vars needed to OAuth into this provider are
        set. False → render as "Coming soon" in UI."""

    @abstractmethod
    def authorize_url(self, state: str) -> str:
        """Return the URL the client opens to start the OAuth grant."""

    @abstractmethod
    def exchange_code(self, code: str) -> TokenSet:
        """Trade an authorization code for tokens."""

    @abstractmethod
    def refresh(self, refresh_token: str) -> TokenSet:
        """Refresh an expired access token."""

    @abstractmethod
    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        """Fetch data since `since` and persist into the existing
        Thallo tables (WorkoutCompletion / DailyHealthSnapshot /
        SleepLog). Idempotent — must tolerate re-runs."""
