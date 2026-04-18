"""Fatigue and recovery scoring for logged activities.

Converts structured activity data (category, subtype, intensity, duration)
into a fatigue impact used by the planner to avoid overtraining and by
the user-facing recovery score to show readiness.

Fatigue model:
  - Each activity produces a fatigue_load (0.0-1.0) and cardio_load (0.0-1.0)
  - Fatigue decays over time: ~50% after 24h, ~25% after 48h, ~10% after 72h
  - Rolling sum across recent days yields a readiness score
  - The planner reads blocks_next_day to suppress conflicting workouts
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, date, timedelta, timezone

_DECAY = {0: 1.0, 1: 0.50, 2: 0.25, 3: 0.10}


@dataclass
class ActivityImpact:
    fatigue_load: float = 0.0
    cardio_load: float = 0.0
    muscle_regions: list[str] = field(default_factory=list)
    blocks_next_day: list[str] = field(default_factory=list)


# ─── Base fatigue tables ─────────────────────────────────────────────────────

_STRENGTH_BASE: dict[str, dict[str, tuple[float, float, list[str], list[str]]]] = {
    # subtype → intensity → (fatigue, cardio, regions, blocks)
    "push":       {"easy": (0.30, 0.05, ["upper_body"], []),
                   "moderate": (0.60, 0.10, ["upper_body"], ["push"]),
                   "hard": (0.80, 0.15, ["upper_body"], ["push", "upper"])},
    "pull":       {"easy": (0.30, 0.05, ["upper_body"], []),
                   "moderate": (0.60, 0.10, ["upper_body"], ["pull"]),
                   "hard": (0.80, 0.15, ["upper_body"], ["pull", "upper"])},
    "legs":       {"easy": (0.35, 0.10, ["lower_body"], []),
                   "moderate": (0.65, 0.15, ["lower_body"], ["legs"]),
                   "hard": (0.90, 0.20, ["lower_body"], ["legs", "lower", "cardio"])},
    "upper_body": {"easy": (0.30, 0.05, ["upper_body"], []),
                   "moderate": (0.60, 0.10, ["upper_body"], ["push", "pull", "upper"]),
                   "hard": (0.80, 0.15, ["upper_body"], ["push", "pull", "upper"])},
    "lower_body": {"easy": (0.35, 0.10, ["lower_body"], []),
                   "moderate": (0.65, 0.15, ["lower_body"], ["legs", "lower"]),
                   "hard": (0.90, 0.20, ["lower_body"], ["legs", "lower", "cardio"])},
    "full_body":  {"easy": (0.35, 0.10, ["upper_body", "lower_body"], []),
                   "moderate": (0.65, 0.15, ["upper_body", "lower_body"], ["full_body"]),
                   "hard": (0.85, 0.20, ["upper_body", "lower_body"], ["full_body", "legs", "upper"])},
}

_CARDIO_BASE: dict[str, dict[str, tuple[float, float, list[str], list[str]]]] = {
    "walk":       {"easy": (0.05, 0.10, [], []),
                   "moderate": (0.15, 0.25, [], []),
                   "hard": (0.25, 0.40, ["lower_body"], [])},
    "run":        {"easy": (0.20, 0.30, ["lower_body"], []),
                   "moderate": (0.40, 0.55, ["lower_body"], ["legs"]),
                   "hard": (0.60, 0.80, ["lower_body"], ["legs", "lower", "cardio"])},
    "ride":       {"easy": (0.15, 0.25, ["lower_body"], []),
                   "moderate": (0.35, 0.50, ["lower_body"], []),
                   "hard": (0.60, 0.75, ["lower_body"], ["legs", "lower"])},
    "hike":       {"easy": (0.15, 0.20, ["lower_body"], []),
                   "moderate": (0.35, 0.40, ["lower_body"], ["legs"]),
                   "hard": (0.50, 0.60, ["lower_body"], ["legs", "lower"])},
    "swim":       {"easy": (0.20, 0.30, ["upper_body"], []),
                   "moderate": (0.40, 0.50, ["upper_body", "lower_body"], []),
                   "hard": (0.60, 0.70, ["upper_body", "lower_body"], ["upper", "cardio"])},
    "row":        {"easy": (0.20, 0.30, ["upper_body", "lower_body"], []),
                   "moderate": (0.40, 0.55, ["upper_body", "lower_body"], ["pull"]),
                   "hard": (0.60, 0.75, ["upper_body", "lower_body"], ["pull", "upper", "cardio"])},
    "stair":      {"easy": (0.15, 0.25, ["lower_body"], []),
                   "moderate": (0.35, 0.50, ["lower_body"], ["legs"]),
                   "hard": (0.55, 0.70, ["lower_body"], ["legs", "lower"])},
    "elliptical": {"easy": (0.10, 0.20, [], []),
                   "moderate": (0.30, 0.45, ["lower_body"], []),
                   "hard": (0.50, 0.65, ["lower_body"], ["cardio"])},
    "bootcamp":   {"easy": (0.35, 0.30, ["upper_body", "lower_body"], []),
                   "moderate": (0.55, 0.50, ["upper_body", "lower_body"], ["full_body"]),
                   "hard": (0.70, 0.60, ["upper_body", "lower_body"], ["full_body", "legs", "upper"])},
    "other":      {"easy": (0.10, 0.20, [], []),
                   "moderate": (0.30, 0.45, [], []),
                   "hard": (0.50, 0.65, [], ["cardio"])},
}

_MOBILITY_BASE: dict[str, dict[str, tuple[float, float, list[str], list[str]]]] = {
    "yoga":       {"easy": (0.10, 0.00, [], []),
                   "moderate": (0.20, 0.05, [], []),
                   "hard": (0.35, 0.10, ["upper_body", "lower_body"], [])},
    "stretching": {"easy": (0.05, 0.00, [], []),
                   "moderate": (0.05, 0.00, [], []),
                   "hard": (0.10, 0.00, [], [])},
    "foam_roll":  {"easy": (0.05, 0.00, [], []),
                   "moderate": (0.05, 0.00, [], []),
                   "hard": (0.05, 0.00, [], [])},
    "pilates":    {"easy": (0.15, 0.05, ["upper_body", "lower_body"], []),
                   "moderate": (0.30, 0.10, ["upper_body", "lower_body"], []),
                   "hard": (0.45, 0.15, ["upper_body", "lower_body"], [])},
}

_SPORT_OVERRIDES: dict[str, dict[str, tuple[float, float, list[str], list[str]]]] = {
    "boxing":     {"easy": (0.30, 0.35, ["upper_body"], []),
                   "moderate": (0.55, 0.55, ["upper_body"], ["push", "pull"]),
                   "hard": (0.75, 0.75, ["upper_body"], ["push", "pull", "upper", "cardio"])},
    "kickboxing": {"easy": (0.35, 0.40, ["upper_body", "lower_body"], []),
                   "moderate": (0.60, 0.60, ["upper_body", "lower_body"], ["full_body"]),
                   "hard": (0.80, 0.80, ["upper_body", "lower_body"], ["full_body", "legs", "cardio"])},
}

_SPORT_DEFAULT: dict[str, tuple[float, float, list[str], list[str]]] = {
    "easy": (0.20, 0.30, ["lower_body"], []),
    "moderate": (0.45, 0.50, ["upper_body", "lower_body"], []),
    "hard": (0.65, 0.70, ["upper_body", "lower_body"], ["full_body", "cardio"]),
}


def compute_activity_impact(
    category: str | None,
    subtype: str | None,
    intensity: str | None,
    duration_minutes: int = 60,
    cardio_style: str | None = None,
) -> ActivityImpact:
    """Compute fatigue impact from a single activity."""
    cat = (category or "").lower()
    sub = (subtype or "other").lower()
    inten = (intensity or "moderate").lower()
    if inten not in ("easy", "moderate", "hard"):
        inten = "moderate"

    if cat == "recovery":
        return ActivityImpact()

    if cat == "strength":
        row = _STRENGTH_BASE.get(sub, _STRENGTH_BASE["full_body"]).get(inten, (0.5, 0.1, [], []))
    elif cat == "cardio":
        row = _CARDIO_BASE.get(sub, _CARDIO_BASE["other"]).get(inten, (0.3, 0.4, [], []))
    elif cat == "mobility":
        row = _MOBILITY_BASE.get(sub, _MOBILITY_BASE["yoga"]).get(inten, (0.1, 0.0, [], []))
    elif cat == "sport":
        override = _SPORT_OVERRIDES.get(sub)
        row = override.get(inten, (0.45, 0.50, [], [])) if override else _SPORT_DEFAULT.get(inten, (0.45, 0.50, [], []))
    else:
        row = _infer_from_focus_label(subtype or "", inten)

    fatigue, cardio, regions, blocks = row

    # Class-style cardio (Peloton etc) gets a fatigue bump
    if cardio_style == "class" and cat == "cardio":
        fatigue = min(1.0, fatigue + 0.10)
    elif cardio_style == "intervals" and cat == "cardio":
        fatigue = min(1.0, fatigue + 0.05)

    # Duration scaling: baseline is 60 min, scale 0.5x-1.5x
    dur_mult = max(0.5, min(1.5, duration_minutes / 60.0))
    fatigue = min(1.0, fatigue * dur_mult)
    cardio = min(1.0, cardio * dur_mult)

    return ActivityImpact(
        fatigue_load=round(fatigue, 3),
        cardio_load=round(cardio, 3),
        muscle_regions=list(regions),
        blocks_next_day=list(blocks),
    )


def _infer_from_focus_label(focus: str, intensity: str) -> tuple[float, float, list[str], list[str]]:
    """Backward compat: infer impact from old-style focus labels."""
    f = focus.lower()
    if any(k in f for k in ("push", "chest", "shoulder")):
        return _STRENGTH_BASE["push"].get(intensity, (0.5, 0.1, ["upper_body"], []))
    if any(k in f for k in ("pull", "back")):
        return _STRENGTH_BASE["pull"].get(intensity, (0.5, 0.1, ["upper_body"], []))
    if any(k in f for k in ("leg", "lower", "squat", "glute")):
        return _STRENGTH_BASE["legs"].get(intensity, (0.6, 0.15, ["lower_body"], []))
    if any(k in f for k in ("upper",)):
        return _STRENGTH_BASE["upper_body"].get(intensity, (0.5, 0.1, ["upper_body"], []))
    if any(k in f for k in ("full", "total")):
        return _STRENGTH_BASE["full_body"].get(intensity, (0.5, 0.15, [], []))
    if any(k in f for k in ("cardio", "run", "cycling", "walk", "hik", "swim")):
        return _CARDIO_BASE["other"].get(intensity, (0.3, 0.4, [], []))
    if any(k in f for k in ("yoga", "stretch", "mobil", "foam")):
        return _MOBILITY_BASE["yoga"].get(intensity, (0.1, 0.0, [], []))
    if any(k in f for k in ("recovery", "rest", "sauna")):
        return (0.0, 0.0, [], [])
    return (0.50, 0.10, [], [])


# ─── Rolling fatigue / recovery score ────────────────────────────────────────

@dataclass
class RegionalFatigue:
    """Per-region fatigue buckets. Each is 0.0 (fresh) to 1.0+ (overtrained)."""
    upper_body: float = 0.0
    lower_body: float = 0.0
    cardio: float = 0.0
    systemic: float = 0.0    # full-body / CNS drain

    def high_regions(self, threshold: float = 0.5) -> list[str]:
        """Return region names above the threshold."""
        out = []
        if self.upper_body >= threshold: out.append("upper_body")
        if self.lower_body >= threshold: out.append("lower_body")
        if self.cardio >= threshold: out.append("cardio")
        if self.systemic >= threshold: out.append("systemic")
        return out

    def blocked_focuses(self, threshold: float = 0.6) -> list[str]:
        """Focus families that should be suppressed due to accumulated fatigue."""
        blocked = []
        if self.upper_body >= threshold:
            blocked.extend(["push", "pull", "upper"])
        if self.lower_body >= threshold:
            blocked.extend(["legs", "lower"])
        if self.cardio >= threshold:
            blocked.extend(["cardio"])
        if self.lower_body >= threshold and self.cardio >= 0.4:
            blocked.append("full_body")
        return sorted(set(blocked))


@dataclass
class FatigueSnapshot:
    """Rolling fatigue state across recent days."""
    total_fatigue: float      # 0.0 = fully recovered, 1.0+ = overtrained
    total_cardio: float       # accumulated cardio load
    regional: RegionalFatigue # per-region breakdown
    readiness_score: int      # 0-100, higher = more ready
    readiness_label: str      # "Fresh", "Ready", "Moderate", "Fatigued", "Overtrained"
    fatigued_regions: list[str]
    blocked_focuses: list[str]
    days_analyzed: int
    activities: list[dict]    # summary per day


def compute_rolling_fatigue(
    completions: list[dict],
    today: date | None = None,
) -> FatigueSnapshot:
    """Compute rolling fatigue from recent workout completions.

    Each completion dict should have:
      - workout_date (date or str)
      - focus_label (str)
      - duration_seconds (int)
      - activity_category (str|None)
      - activity_subtype (str|None)
      - activity_intensity (str|None)
      - cardio_style (str|None)
    """
    if today is None:
        today = date.today()

    total_fatigue = 0.0
    total_cardio = 0.0
    reg = RegionalFatigue()
    all_blocks: list[str] = []
    activities: list[dict] = []

    for c in completions:
        wd = c.get("workout_date")
        if isinstance(wd, str):
            try:
                wd = date.fromisoformat(wd)
            except ValueError:
                continue
        if not isinstance(wd, date):
            continue

        days_ago = (today - wd).days
        if days_ago < 0 or days_ago > 3:
            continue

        decay = _DECAY.get(days_ago, 0.0)
        dur = (c.get("duration_seconds") or 0) / 60

        impact = compute_activity_impact(
            category=c.get("activity_category"),
            subtype=c.get("activity_subtype") or c.get("focus_label"),
            intensity=c.get("activity_intensity"),
            duration_minutes=int(dur) if dur > 0 else 60,
            cardio_style=c.get("cardio_style"),
        )

        total_fatigue += impact.fatigue_load * decay
        total_cardio += impact.cardio_load * decay

        # Accumulate per-region fatigue
        decayed_fatigue = impact.fatigue_load * decay
        decayed_cardio = impact.cardio_load * decay
        if "upper_body" in impact.muscle_regions:
            reg.upper_body += decayed_fatigue
        if "lower_body" in impact.muscle_regions:
            reg.lower_body += decayed_fatigue
        reg.cardio += decayed_cardio
        reg.systemic += decayed_fatigue * 0.5  # everything contributes to systemic

        if days_ago <= 1:
            all_blocks.extend(impact.blocks_next_day)

        activities.append({
            "date": wd.isoformat(),
            "days_ago": days_ago,
            "focus": c.get("focus_label", ""),
            "category": c.get("activity_category", ""),
            "intensity": c.get("activity_intensity", ""),
            "fatigue": round(impact.fatigue_load * decay, 2),
            "cardio": round(impact.cardio_load * decay, 2),
        })

    # Merge region-based blocks with activity-based blocks
    all_blocks.extend(reg.blocked_focuses())

    # Readiness: inverse of fatigue, 0-100 scale
    raw_readiness = max(0.0, 1.0 - total_fatigue)
    readiness_score = int(round(raw_readiness * 100))

    if readiness_score >= 85:
        label = "Fresh"
    elif readiness_score >= 65:
        label = "Ready"
    elif readiness_score >= 40:
        label = "Moderate"
    elif readiness_score >= 20:
        label = "Fatigued"
    else:
        label = "Overtrained"

    return FatigueSnapshot(
        total_fatigue=round(total_fatigue, 3),
        total_cardio=round(total_cardio, 3),
        regional=RegionalFatigue(
            upper_body=round(reg.upper_body, 3),
            lower_body=round(reg.lower_body, 3),
            cardio=round(reg.cardio, 3),
            systemic=round(reg.systemic, 3),
        ),
        readiness_score=readiness_score,
        readiness_label=label,
        fatigued_regions=reg.high_regions(),
        blocked_focuses=sorted(set(all_blocks)),
        days_analyzed=len(activities),
        activities=activities,
    )
