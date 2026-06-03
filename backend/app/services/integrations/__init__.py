"""Wearable + activity-source integration framework.

Adds new providers (Garmin, Oura, WHOOP, Fitbit, Google Health) without re-implementing
OAuth boilerplate per provider. The pattern:

  1. Subclass `WearableProvider` in a new module under this package.
  2. Implement `authorize_url`, `exchange_code`, `refresh`, `sync` for
     the provider's API.
  3. Register the class in `_PROVIDER_REGISTRY` below.
  4. Set the provider's client-id / client-secret in backend/.env
     (e.g. GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET).
  5. The generic `/integrations/{provider}/authorize` endpoint picks it
     up automatically — no router changes per provider.

What lives where:
  - This package owns the provider abstraction + a registry.
  - `app/services/integrations/strava.py` is a thin wrapper around the
    existing strava OAuth code so Strava reads like every other provider.
  - `app/routers/integrations.py` is the generic OAuth + sync router.

What's deferred:
  - Garmin, Fitbit, and Google Health still need live API approval/scope
    validation before sync is enabled. Oura and WHOOP have first-pass
    OAuth + sync implementations.
"""
from __future__ import annotations

from typing import Type

from app.services.integrations.base import WearableProvider, ProviderNotConfiguredError
from app.services.integrations.strava import StravaProvider
from app.services.integrations.garmin import GarminProvider
from app.services.integrations.oura import OuraProvider
from app.services.integrations.whoop import WhoopProvider
from app.services.integrations.fitbit import FitbitProvider
from app.services.integrations.google_health import GoogleHealthProvider


# Provider name (URL slug) -> class. Keep in sync with the
# IntegrationCredential.provider strings stored in the DB so authorize
# / sync flows can look up the right class from a token row.
_PROVIDER_REGISTRY: dict[str, Type[WearableProvider]] = {
    "strava": StravaProvider,
    "garmin": GarminProvider,
    "oura":   OuraProvider,
    "whoop":  WhoopProvider,
    "fitbit": FitbitProvider,
    "google_health": GoogleHealthProvider,
}


def get_provider(name: str) -> WearableProvider:
    """Resolve a provider class by URL slug. Raises a domain error when
    the provider doesn't exist or isn't configured."""
    cls = _PROVIDER_REGISTRY.get(name.lower().strip())
    if cls is None:
        raise ProviderNotConfiguredError(
            f"unknown wearable provider: {name!r}. "
            f"Known: {sorted(_PROVIDER_REGISTRY.keys())}"
        )
    instance = cls()
    if not instance.is_configured:
        raise ProviderNotConfiguredError(
            f"{name} OAuth credentials are not set. "
            f"See docs/engineering/wearables.md for the env vars."
        )
    return instance


def list_providers() -> list[dict]:
    """Return a list of supported providers with their configuration
    status. Used by the frontend to show "Connect" vs "Coming soon"."""
    out: list[dict] = []
    for slug, cls in _PROVIDER_REGISTRY.items():
        instance = cls()
        out.append({
            "slug": slug,
            "name": instance.display_name,
            "configured": instance.is_configured,
            "capabilities": list(instance.capabilities),
        })
    return out
