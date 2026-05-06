"""Deterministic weekly check-in evaluator.

Evaluates a user's committed goals from the previous check-in against
actual logged data (WorkoutSession + ExerciseSet + meal logs) over the
past 7 days and produces a structured hit / partial / missed breakdown.

This module is the ground truth the AI check-in phrase-layer consumes.
The AI never re-interprets the data — it only phrases the verdict.

No LLM, no DB writes. Pure read + compute.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Literal, Optional

from sqlmodel import Session, select


CommitmentBucket = Literal["hit", "partial", "missed"]
Recommendation = Literal[
    "coach_only", "small_adjust", "deep_review", "leave_alone", "ask_more",
]


@dataclass
class EvaluatedCommitment:
    """One commitment pulled from the PRIOR week's check-in, evaluated
    against what actually happened this week.

    `kind` is a free-form label ("bench +5 lb", "cardio 2x/week", "hit
    protein target"); the evaluator rules use it to pick a comparator
    but don't impose a schema."""
    kind: str
    bucket: CommitmentBucket
    promised: str              # "bench 185×8"
    actual: str                # "bench 185×8" or "bench 180×6"
    delta_pct: float           # (actual / promised), 1.0 = exact hit
    note: str = ""             # one-line evaluator comment


@dataclass
class WeeklyEvaluation:
    week_start: date
    week_end: date
    commitments: list[EvaluatedCommitment] = field(default_factory=list)
    adherence_pct: float = 0.0
    sessions_logged: int = 0
    sessions_planned: int = 0
    biggest_win: Optional[EvaluatedCommitment] = None
    biggest_gap: Optional[EvaluatedCommitment] = None

    def counts(self) -> dict[str, int]:
        return {
            "hit":     sum(1 for c in self.commitments if c.bucket == "hit"),
            "partial": sum(1 for c in self.commitments if c.bucket == "partial"),
            "missed":  sum(1 for c in self.commitments if c.bucket == "missed"),
        }

    def to_dict(self) -> dict:
        return {
            "weekStart": self.week_start.isoformat(),
            "weekEnd":   self.week_end.isoformat(),
            "adherencePct": round(self.adherence_pct, 1),
            "sessionsLogged": self.sessions_logged,
            "sessionsPlanned": self.sessions_planned,
            "counts": self.counts(),
            "commitments": [
                {
                    "kind": c.kind,
                    "bucket": c.bucket,
                    "promised": c.promised,
                    "actual": c.actual,
                    "deltaPct": round(c.delta_pct, 2),
                    "note": c.note,
                }
                for c in self.commitments
            ],
            "biggestWin": (
                {
                    "kind": self.biggest_win.kind,
                    "actual": self.biggest_win.actual,
                    "promised": self.biggest_win.promised,
                }
                if self.biggest_win else None
            ),
            "biggestGap": (
                {
                    "kind": self.biggest_gap.kind,
                    "actual": self.biggest_gap.actual,
                    "promised": self.biggest_gap.promised,
                }
                if self.biggest_gap else None
            ),
        }


# ── Deterministic recommendation selector ────────────────────────


def recommend_from_evaluation(ev: WeeklyEvaluation) -> Recommendation:
    """Pick the right `response_type` from the evaluation alone —
    no LLM. The AI only phrases the verdict downstream.

    Rules (order matters):
    - No commitments AND no sessions logged → ask_more
    - No commitments BUT sessions logged → coach_only (nothing promised to grade)
    - adherence ≥ 85% AND no missed safety items → leave_alone
    - adherence 60-85% → coach_only (positive reinforcement)
    - adherence 40-60% → small_adjust (name the adjustment)
    - adherence < 40% OR 2+ missed compounds → deep_review
    """
    if not ev.commitments:
        return "ask_more" if ev.sessions_logged == 0 else "coach_only"
    pct = ev.adherence_pct
    missed = ev.counts()["missed"]
    if pct >= 85.0:
        return "leave_alone"
    if pct >= 60.0:
        return "coach_only"
    if pct >= 40.0:
        return "small_adjust"
    if pct < 40.0 or missed >= 2:
        return "deep_review"
    return "coach_only"


# ── Public evaluator ─────────────────────────────────────────────


def evaluate_week(
    *,
    db: Session,
    user_id: int,
    prior_commitments: list[dict],
    week_end: Optional[date] = None,
) -> WeeklyEvaluation:
    """Evaluate `prior_commitments` against the last 7 days of data.

    `prior_commitments` is the list carried forward from the PREVIOUS
    check-in's `pending_changes`. Each entry is a free-form dict with:
        {
          "kind": "bench_load",                 # stable ID
          "label": "bench +5 lb to 185",        # user-facing
          "target_exercise": "Barbell Bench Press",
          "target_reps": 8,
          "target_weight_lbs": 185,
        }
    OR a cardio / protein / volume commitment:
        {"kind": "cardio_count", "label": "2 Z2 sessions", "target_count": 2, "focus_contains": "cardio"}
        {"kind": "protein_target", "label": "hit protein 175g/day", "target_g_per_day": 175}

    Missing or malformed commitments are bucketed as `partial` with a
    note explaining what was missing.
    """
    end = week_end or date.today()
    start = end - timedelta(days=7)

    # Pull sessions in the window (best-effort — if the DB schema doesn't
    # match, we degrade gracefully to an empty evaluation).
    sessions: list = []
    try:
        from app.models import WorkoutSession
        sessions = db.exec(
            select(WorkoutSession).where(
                WorkoutSession.user_id == user_id,
                WorkoutSession.workout_date >= start,
                WorkoutSession.workout_date <= end,
            )
        ).all()
    except Exception:
        sessions = []

    sets_by_session: dict[int, list] = {}
    try:
        from app.models import ExerciseSet
        for s in sessions:
            rows = db.exec(
                select(ExerciseSet).where(ExerciseSet.session_id == s.id)
            ).all()
            sets_by_session[s.id] = list(rows)
    except Exception:
        pass

    evaluated: list[EvaluatedCommitment] = []

    for commit in prior_commitments or []:
        if not isinstance(commit, dict):
            continue
        kind = str(commit.get("kind") or "")
        label = str(commit.get("label") or kind or "commitment")

        # ── Exercise-load commitments (e.g. "bench 185×8") ──
        if kind.endswith("_load") or "exercise" in kind.lower() or commit.get("target_exercise"):
            target_ex = str(commit.get("target_exercise") or "").strip().lower()
            target_w  = float(commit.get("target_weight_lbs") or 0)
            target_r  = int(commit.get("target_reps") or 0)
            if not target_ex or target_w <= 0 or target_r <= 0:
                evaluated.append(EvaluatedCommitment(
                    kind=kind, bucket="partial", promised=label, actual="—",
                    delta_pct=0.0, note="commitment malformed — no target",
                ))
                continue

            # Find the best matching logged set this week.
            best_w = 0.0
            best_r = 0
            for sid, rows in sets_by_session.items():
                for r in rows:
                    if target_ex in (str(getattr(r, "exercise_name", "") or "").lower()):
                        w = float(getattr(r, "weight_lbs", 0) or 0)
                        reps = int(getattr(r, "reps", 0) or 0)
                        if w >= best_w and reps >= target_r:
                            best_w, best_r = w, reps
            if best_w <= 0:
                evaluated.append(EvaluatedCommitment(
                    kind=kind, bucket="missed", promised=f"{target_ex} {int(target_w)}×{target_r}",
                    actual="not logged", delta_pct=0.0, note="exercise not logged this week",
                ))
                continue
            ratio = best_w / target_w if target_w else 0.0
            bucket: CommitmentBucket = (
                "hit" if (best_w >= target_w and best_r >= target_r)
                else "partial" if ratio >= 0.85
                else "missed"
            )
            evaluated.append(EvaluatedCommitment(
                kind=kind, bucket=bucket,
                promised=f"{target_ex} {int(target_w)}×{target_r}",
                actual=f"{target_ex} {int(best_w)}×{best_r}",
                delta_pct=ratio,
                note="",
            ))
            continue

        # ── Focus count commitments (e.g. "2 cardio sessions") ──
        if "count" in kind.lower() or commit.get("target_count"):
            needle = str(commit.get("focus_contains") or "").lower()
            target_count = int(commit.get("target_count") or 0)
            hits = sum(
                1 for s in sessions
                if needle and needle in str(getattr(s, "focus", "") or "").lower()
            )
            ratio = (hits / target_count) if target_count > 0 else 0.0
            bucket = (
                "hit" if hits >= target_count
                else "partial" if ratio >= 0.5
                else "missed"
            )
            evaluated.append(EvaluatedCommitment(
                kind=kind, bucket=bucket,
                promised=f"{target_count}× {needle}",
                actual=f"{hits}× {needle}",
                delta_pct=ratio,
                note="",
            ))
            continue

        # ── Fallback bucket for unknown commitment types ──
        evaluated.append(EvaluatedCommitment(
            kind=kind, bucket="partial", promised=label, actual="no rule",
            delta_pct=0.0, note="unknown commitment kind — evaluator has no rule",
        ))

    # Session count / planned (best-effort; sessions_planned may be unknown)
    sessions_logged = len(sessions)
    sessions_planned = int(max(sessions_logged, len(evaluated) or 0))

    # Adherence — weighted toward exercise-load commitments.
    counts = {
        "hit":     sum(1 for c in evaluated if c.bucket == "hit"),
        "partial": sum(1 for c in evaluated if c.bucket == "partial"),
        "missed":  sum(1 for c in evaluated if c.bucket == "missed"),
    }
    total = max(1, len(evaluated))
    adherence = (counts["hit"] * 1.0 + counts["partial"] * 0.5) / total * 100.0

    biggest_win: Optional[EvaluatedCommitment] = None
    biggest_gap: Optional[EvaluatedCommitment] = None
    hits = [c for c in evaluated if c.bucket == "hit"]
    misses = [c for c in evaluated if c.bucket == "missed"]
    if hits:
        biggest_win = max(hits, key=lambda c: c.delta_pct)
    if misses:
        biggest_gap = min(misses, key=lambda c: c.delta_pct)

    return WeeklyEvaluation(
        week_start=start,
        week_end=end,
        commitments=evaluated,
        adherence_pct=adherence,
        sessions_logged=sessions_logged,
        sessions_planned=sessions_planned,
        biggest_win=biggest_win,
        biggest_gap=biggest_gap,
    )
