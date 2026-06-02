"""Async safety verdicts for live workout load recommendations.

The deterministic recommendation remains the source of truth. This module
only decides whether a suspicious recommendation should be held for review,
and the LLM response is deliberately tiny: ``ok`` or ``review``.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from typing import Any

from openai import OpenAI


_CACHE_TTL_SECONDS = int(os.getenv("RECOMMENDATION_AI_SAFETY_CACHE_TTL_SECONDS", "3600"))
_CACHE_MAX_ITEMS = int(os.getenv("RECOMMENDATION_AI_SAFETY_CACHE_MAX_ITEMS", "512"))
_ENABLED = os.getenv("RECOMMENDATION_AI_SAFETY_ENABLED", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
}

_ALLOWED_REASONS = {
    None,
    "non_numeric_equipment",
    "too_large_jump",
    "equipment_mismatch",
    "history_mismatch",
    "low_confidence_transfer",
    "stale_plan_snapshot",
    "implausible_default",
}

_REVIEW_FLAGS_HOLD_IMMEDIATELY = {
    "non_numeric_equipment",
    "too_large_jump",
    "equipment_mismatch",
    "history_mismatch",
}

_CACHE: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()

_SCHEMA = {
    "name": "workout_recommendation_safety",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["verdict", "reason_code"],
        "properties": {
            "verdict": {"type": "string", "enum": ["ok", "review"]},
            "reason_code": {
                "type": ["string", "null"],
                "enum": [
                    None,
                    "non_numeric_equipment",
                    "too_large_jump",
                    "equipment_mismatch",
                    "history_mismatch",
                    "low_confidence_transfer",
                    "stale_plan_snapshot",
                    "implausible_default",
                ],
            },
        },
    },
}


def _now() -> float:
    return time.time()


def _finite_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if out != out or out in (float("inf"), float("-inf")):
        return None
    return out


def _positive_float(value: Any) -> float | None:
    out = _finite_float(value)
    if out is None or out <= 0:
        return None
    return out


def _positive_int(value: Any) -> int | None:
    try:
        out = int(value)
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def _short_text(value: Any, limit: int = 80) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return text[:limit]


def _compact_set(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        raw = {
            "weightLbs": getattr(raw, "weightLbs", None),
            "reps": getattr(raw, "reps", None),
            "rir": getattr(raw, "rir", None),
        }
    weight = _positive_float(raw.get("weightLbs") if "weightLbs" in raw else raw.get("weight_lbs"))
    reps = _positive_int(raw.get("reps") if "reps" in raw else raw.get("actual_reps"))
    if weight is None and reps is None:
        return None
    out: dict[str, Any] = {}
    if weight is not None:
        out["weightLbs"] = round(weight, 2)
    if reps is not None:
        out["reps"] = reps
    rir = _finite_float(raw.get("rir"))
    if rir is not None:
        out["rir"] = round(max(0.0, min(10.0, rir)), 1)
    return out


def _compact_sets(raw_sets: Any, *, limit: int = 4) -> list[dict[str, Any]]:
    if not isinstance(raw_sets, list):
        return []
    compact: list[dict[str, Any]] = []
    for item in raw_sets[-limit:]:
        row = _compact_set(item)
        if row:
            compact.append(row)
    return compact


def _compact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    exercise = payload.get("exercise") if isinstance(payload.get("exercise"), dict) else {}
    rec = payload.get("recommendation") if isinstance(payload.get("recommendation"), dict) else {}
    plan = payload.get("plan") if isinstance(payload.get("plan"), dict) else {}
    out = {
        "kind": _short_text(payload.get("kind"), 24) or "unknown",
        "exercise": {
            "name": _short_text(exercise.get("name")),
            "slug": _short_text(exercise.get("slug")),
            "equipment": _short_text(exercise.get("equipment")),
            "primaryMuscle": _short_text(exercise.get("primaryMuscle"), 48),
            "loadSemantics": _short_text(exercise.get("loadSemantics"), 48),
            "numericLoad": bool(exercise.get("numericLoad")),
        },
        "recommendation": {
            "weightLbs": _positive_float(rec.get("weightLbs")),
            "reps": _short_text(rec.get("reps"), 24),
            "dataSource": _short_text(rec.get("dataSource"), 48),
            "confidence": _finite_float(rec.get("confidence")),
            "action": _short_text(rec.get("action"), 32),
        },
        "plan": {
            "targetWeightLbs": _positive_float(plan.get("targetWeightLbs")),
            "targetReps": _short_text(plan.get("targetReps"), 24),
        },
        "currentSessionSets": _compact_sets(payload.get("currentSessionSets")),
        "lastSessionSets": _compact_sets(payload.get("lastSessionSets")),
        "recentHistory": _compact_sets(payload.get("recentHistory")),
        "reasonTags": [
            _short_text(tag, 48)
            for tag in (payload.get("reasonTags") or [])[:8]
            if _short_text(tag, 48)
        ],
    }
    return out


def cache_key_for_payload(payload: dict[str, Any]) -> str:
    canonical = json.dumps(_compact_payload(payload), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def _history_weights(payload: dict[str, Any]) -> list[float]:
    weights: list[float] = []
    for key in ("lastSessionSets", "recentHistory"):
        for row in payload.get(key) or []:
            weight = _positive_float(row.get("weightLbs") if isinstance(row, dict) else None)
            if weight is not None:
                weights.append(weight)
    return weights


def deterministic_review_flags(payload: dict[str, Any]) -> list[str]:
    """Cheap gate before spending tokens."""
    compact = _compact_payload(payload)
    exercise = compact["exercise"]
    rec = compact["recommendation"]
    plan = compact["plan"]
    rec_weight = _positive_float(rec.get("weightLbs"))
    if rec_weight is None:
        return []

    flags: list[str] = []
    if not exercise.get("numericLoad") and rec_weight > 0:
        flags.append("non_numeric_equipment")

    load_semantics = str(exercise.get("loadSemantics") or "").lower()
    if "assistance" in load_semantics and rec_weight > 0:
        flags.append("equipment_mismatch")

    exact_weights = _history_weights(compact)
    if exact_weights:
        anchor = max(exact_weights)
        if rec_weight >= max(anchor * 1.5, anchor + 25.0):
            flags.append("too_large_jump")
        plan_weight = _positive_float(plan.get("targetWeightLbs"))
        if (
            plan_weight is not None
            and rec_weight >= plan_weight * 0.95
            and rec_weight >= max(anchor * 1.5, anchor + 25.0)
        ):
            flags.append("history_mismatch")

    data_source = str(rec.get("dataSource") or "")
    confidence = _finite_float(rec.get("confidence"))
    if data_source == "plan_snapshot" and exact_weights:
        anchor = max(exact_weights)
        if rec_weight >= max(anchor * 1.35, anchor + 20.0):
            flags.append("stale_plan_snapshot")
    if data_source in {"movement_pattern", "muscle_equipment_bucket"}:
        if rec_weight >= 75 and (confidence is None or confidence < 0.55):
            flags.append("low_confidence_transfer")
    if data_source == "default" and rec_weight >= 135:
        flags.append("implausible_default")

    seen: set[str] = set()
    return [f for f in flags if not (f in seen or seen.add(f))]


def _entry_public(entry: dict[str, Any], key: str) -> dict[str, Any]:
    out = {
        "status": entry.get("status") or "missing",
        "verdict": entry.get("verdict"),
        "reasonCode": entry.get("reasonCode"),
        "cacheKey": key,
        "flags": list(entry.get("flags") or []),
        "shouldHold": bool(entry.get("shouldHold")),
    }
    if entry.get("updatedAt"):
        out["updatedAt"] = entry["updatedAt"]
    return out


def _prune_cache_locked(now: float) -> None:
    stale = [key for key, entry in _CACHE.items() if now - float(entry.get("updatedAt") or 0) > _CACHE_TTL_SECONDS]
    for key in stale:
        _CACHE.pop(key, None)
    if len(_CACHE) <= _CACHE_MAX_ITEMS:
        return
    for key, _entry in sorted(_CACHE.items(), key=lambda item: float(item[1].get("updatedAt") or 0))[: len(_CACHE) - _CACHE_MAX_ITEMS]:
        _CACHE.pop(key, None)


def get_ai_safety_status(cache_key: str) -> dict[str, Any]:
    key = str(cache_key or "").strip()[:80]
    if not key:
        return {"status": "missing", "verdict": None, "reasonCode": None, "cacheKey": "", "flags": [], "shouldHold": False}
    now = _now()
    with _LOCK:
        _prune_cache_locked(now)
        entry = _CACHE.get(key)
        if not entry:
            return {"status": "missing", "verdict": None, "reasonCode": None, "cacheKey": key, "flags": [], "shouldHold": False}
        return _entry_public(entry, key)


def prepare_ai_safety_review(
    payload: dict[str, Any],
    *,
    user_id: int | None,
    background_tasks: Any = None,
) -> dict[str, Any]:
    compact = _compact_payload(payload)
    flags = deterministic_review_flags(compact)
    key = cache_key_for_payload(compact)
    if not flags:
        return {
            "status": "not_required",
            "verdict": None,
            "reasonCode": None,
            "cacheKey": key,
            "flags": [],
            "shouldHold": False,
        }

    now = _now()
    with _LOCK:
        _prune_cache_locked(now)
        existing = _CACHE.get(key)
        if existing and existing.get("status") not in {"missing"}:
            if (
                existing.get("status") == "pending"
                and background_tasks is not None
                and not existing.get("enqueued")
            ):
                existing["enqueued"] = True
                existing["updatedAt"] = now
                background_tasks.add_task(_run_ai_safety_review, key, compact, user_id)
            return _entry_public(existing, key)

        should_hold = bool(_REVIEW_FLAGS_HOLD_IMMEDIATELY.intersection(flags))
        if not _ENABLED:
            entry = {
                "status": "disabled",
                "verdict": None,
                "reasonCode": flags[0],
                "flags": flags,
                "shouldHold": should_hold,
                "updatedAt": now,
            }
            _CACHE[key] = entry
            return _entry_public(entry, key)

        try:
            from app.routers.ai.utils import get_openai_api_key
            api_key = get_openai_api_key()
        except Exception:
            api_key = None
        if not api_key:
            entry = {
                "status": "unavailable",
                "verdict": None,
                "reasonCode": flags[0],
                "flags": flags,
                "shouldHold": should_hold,
                "updatedAt": now,
            }
            _CACHE[key] = entry
            return _entry_public(entry, key)

        entry = {
            "status": "pending",
            "verdict": None,
            "reasonCode": flags[0],
            "flags": flags,
            "shouldHold": should_hold,
            "enqueued": background_tasks is not None,
            "updatedAt": now,
        }
        _CACHE[key] = entry

    if background_tasks is not None:
        background_tasks.add_task(_run_ai_safety_review, key, compact, user_id)
    return get_ai_safety_status(key)


def _store_result(key: str, entry: dict[str, Any]) -> None:
    entry["updatedAt"] = _now()
    with _LOCK:
        _CACHE[key] = entry


def _run_ai_safety_review(key: str, payload: dict[str, Any], user_id: int | None) -> None:
    flags = deterministic_review_flags(payload)
    should_hold_default = bool(_REVIEW_FLAGS_HOLD_IMMEDIATELY.intersection(flags))
    try:
        from app.routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_chat,
        )

        api_key = get_openai_api_key()
        if not api_key:
            _store_result(key, {
                "status": "unavailable",
                "verdict": None,
                "reasonCode": flags[0] if flags else None,
                "flags": flags,
                "shouldHold": should_hold_default,
            })
            return

        messages = [
            {
                "role": "system",
                "content": (
                    "You review workout load recommendations. You never choose a new weight. "
                    "Return JSON only: verdict ok or review, plus a reason_code."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Return review for non-numeric/band/bodyweight gear with weight, "
                    "large jumps vs exact history, stale plan targets, assistance-vs-resistance "
                    "mismatches, or implausible low-confidence transfers. Otherwise ok.\n"
                    f"{json.dumps(payload, sort_keys=True, separators=(',', ':'))}"
                ),
            },
        ]
        model = model_chat()
        kwargs = _build_chat_kwargs(
            model,
            messages,
            json_schema=_SCHEMA,
            max_tokens=80,
            timeout_secs=10,
            ai_route="/recommendations/ai-safety",
            ai_user_id=user_id,
            ai_budget_bucket="recommendation_safety",
        )
        response = _chat_create(OpenAI(api_key=api_key), **kwargs)
        content = response.choices[0].message.content or "{}"
        data = _extract_json(content)
        verdict = "review" if data.get("verdict") == "review" else "ok"
        reason = data.get("reason_code")
        if reason not in _ALLOWED_REASONS:
            reason = flags[0] if verdict == "review" and flags else None
        _store_result(key, {
            "status": verdict,
            "verdict": verdict,
            "reasonCode": reason,
            "flags": flags,
            "shouldHold": verdict == "review",
        })
    except Exception as exc:
        print(f"[recommendation-ai-safety] review failed (non-fatal): {exc}")
        _store_result(key, {
            "status": "error",
            "verdict": None,
            "reasonCode": flags[0] if flags else None,
            "flags": flags,
            "shouldHold": should_hold_default,
        })
