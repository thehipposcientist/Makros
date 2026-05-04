from __future__ import annotations

from dataclasses import dataclass
import os
from collections.abc import Mapping


PROD_ENV_NAMES = {"production", "prod"}


@dataclass(frozen=True)
class CorsConfig:
    allow_origins: list[str]
    allow_credentials: bool
    is_production: bool


def _env_value(env: Mapping[str, str], *names: str) -> str:
    for name in names:
        value = (env.get(name) or "").strip()
        if value:
            return value
    return ""


def is_production_env(env: Mapping[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    return _env_value(env, "APP_ENV", "ENVIRONMENT", "ENV").lower() in PROD_ENV_NAMES


def parse_cors_origins(raw: str | None) -> list[str]:
    return [origin.strip() for origin in (raw or "").split(",") if origin.strip()]


def resolve_cors_config(env: Mapping[str, str] | None = None) -> CorsConfig:
    env = os.environ if env is None else env
    is_prod = is_production_env(env)
    origins = parse_cors_origins(env.get("CORS_ORIGINS"))

    if "*" in origins and is_prod and env.get("ALLOW_WILDCARD_CORS_IN_PROD") != "1":
        raise RuntimeError(
            "CORS_ORIGINS cannot include '*' in production. Set specific HTTPS origins "
            "or leave CORS_ORIGINS empty for native-app-only deployments."
        )

    if not origins:
        return CorsConfig(
            allow_origins=[] if is_prod else ["*"],
            allow_credentials=False,
            is_production=is_prod,
        )

    return CorsConfig(
        allow_origins=origins,
        allow_credentials="*" not in origins,
        is_production=is_prod,
    )
