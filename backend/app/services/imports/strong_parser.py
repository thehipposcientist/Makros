"""Strong app workout CSV parser.

Pure-function — no DB, no network. Takes bytes and returns a
`StrongParseResult` containing a flat list of `ParsedWorkoutSet`
records. The pipeline groups them by (date, workout_name) to make
`WorkoutCompletion` rows and by `(session, exercise_name)` for
`ExerciseSet` rows.

Modern Strong export header (2023+):

    Date,Workout Name,Duration,Exercise Name,Set Order,Weight,
    Weight Unit,Reps,RPE,Distance,Distance Unit,Seconds,Notes,
    Workout Notes

Older variants:
  - "Date,Workout Name,Exercise Name,Set Order,Weight,Reps,
     Distance,Seconds,Notes,Workout Notes,Workout Duration"
    (weight unit inferred from Strong's per-user setting; we default
     to lbs when absent.)
  - Some 2022 exports use a single quoted Distance with embedded
    unit like "5 km" — we parse that off if present.

Date column may include time ("2023-01-01 10:00:00") — we keep only
the date portion since `WorkoutCompletion.workout_date` is `date`.

Weight unit defaults: when missing AND the value looks larger than
plausible kg numbers (>250), assume lbs. Otherwise check the Strong
import-config flag if we exposed one — for now we use the per-row
column or fall back to lbs. Strong itself stores in the user's preferred
unit so the values come pre-rounded.

Duration parsing tolerant of: "30m", "1h 15m", "75", "75 min",
"1:15:00" (h:mm:ss), and missing/null. Returns integer seconds.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, datetime


@dataclass(frozen=True)
class ParsedWorkoutSet:
    """One Strong set, with parent-session context inlined for ease
    of grouping. The pipeline groups by (workout_date, workout_name)
    to create WorkoutCompletion rows."""
    row_index: int
    workout_date: date
    # Full datetime from the CSV's Date column when present (Strong
    # writes "2026-01-30 05:20:49"). Preserved so the pipeline can
    # stamp WorkoutSession.completed_at with the real workout time
    # instead of the import moment. None for exports that only emit
    # a bare date.
    workout_started_at: datetime | None
    workout_name: str | None
    workout_duration_seconds: int | None
    workout_notes: str | None
    exercise_name: str
    set_order: int
    set_type: str | None
    weight_value: float | None
    weight_unit: str          # "lbs" | "kg"
    reps: int | None
    rpe: float | None
    distance_value: float | None
    distance_unit: str | None  # "mi" | "km" | None
    duration_seconds: int | None
    notes: str | None


@dataclass(frozen=True)
class StrongParseResult:
    sets: list[ParsedWorkoutSet]
    skipped_count: int
    errors: list[str]


# ─── Header normalization ────────────────────────────────────────────────────

_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "date":              ("date", "datetime", "start time"),
    "workout_name":      ("workout name", "workout"),
    "duration":          ("duration", "workout duration"),
    "exercise":          ("exercise name", "exercise"),
    "set_order":         ("set order", "set", "set number"),
    "weight":            ("weight", "weight kg", "weight lbs"),
    "weight_unit":       ("weight unit",),
    "reps":              ("reps", "repetitions"),
    "rpe":               ("rpe",),
    "distance":          ("distance", "distance km", "distance mi"),
    "distance_unit":     ("distance unit",),
    "seconds":           ("seconds", "time", "duration seconds"),
    "notes":             ("notes", "note"),
    "workout_notes":     ("workout notes", "workout note"),
}
_HEADER_LOOKUP: dict[str, str] = {
    alias: canonical
    for canonical, aliases in _HEADER_ALIASES.items()
    for alias in aliases
}


def _normalize_header(raw: str) -> str:
    s = raw.strip().lower()
    s = s.replace("(", " ").replace(")", " ").replace(",", " ")
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return _HEADER_LOOKUP.get(s, s)


# ─── Value parsers ───────────────────────────────────────────────────────────

_DATE_FORMATS_WITH_TIME: tuple[str, ...] = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
)
_DATE_FORMATS_DATE_ONLY: tuple[str, ...] = (
    "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%m-%d-%Y",
)


def _parse_datetime(raw: str) -> tuple[date, datetime | None] | None:
    """Returns (date, datetime|None). The datetime is set when the Date
    column carries a time component; bare-date exports return None for
    the second element. The pipeline uses the datetime for session
    timestamps so imported workouts land on their real day-of-day."""
    raw = raw.strip()
    if not raw:
        return None
    for fmt in _DATE_FORMATS_WITH_TIME:
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.date(), dt
        except ValueError:
            continue
    for fmt in _DATE_FORMATS_DATE_ONLY:
        try:
            return datetime.strptime(raw, fmt).date(), None
        except ValueError:
            continue
    # Permissive ISO-with-millis fallback.
    head = raw.split(" ")[0].split("T")[0]
    for fmt in _DATE_FORMATS_DATE_ONLY:
        try:
            return datetime.strptime(head, fmt).date(), None
        except ValueError:
            continue
    return None


def _parse_date(raw: str) -> date | None:
    """Back-compat wrapper for callers that only need the date."""
    parsed = _parse_datetime(raw)
    return parsed[0] if parsed else None


def _parse_float(raw: str | None) -> float | None:
    if raw is None:
        return None
    s = raw.strip()
    if not s or s.lower() in {"--", "-", "n/a", "null"}:
        return None
    # Strip trailing unit-ish text ("5 km", "30 lb").
    m = re.match(r"^-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def _parse_int(raw: str | None) -> int | None:
    v = _parse_float(raw)
    return int(v) if v is not None else None


def _parse_set_type(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = raw.strip().lower()
    if not s:
        return None
    if s in {"w", "warmup", "warm up", "warm-up"}:
        return "warmup"
    if s in {"d", "drop", "dropset", "drop set"}:
        return "dropset"
    if s in {"f", "failure"}:
        return "failure"
    return None


_DURATION_HMS_RE = re.compile(r"^(\d+):(\d+)(?::(\d+))?$")


def _parse_duration_seconds(raw: str | None) -> int | None:
    """Strong's Duration column is multi-format — "30m", "1h 15m",
    "75 min", "1:15:00", bare "1800" seconds. Returns int seconds or
    None when unparseable."""
    if raw is None:
        return None
    s = raw.strip().lower()
    if not s:
        return None

    # H:MM:SS or M:SS form.
    m = _DURATION_HMS_RE.match(s)
    if m:
        h_or_m = int(m.group(1))
        mid = int(m.group(2))
        last = int(m.group(3)) if m.group(3) else None
        if last is not None:
            return h_or_m * 3600 + mid * 60 + last
        return h_or_m * 60 + mid

    total = 0
    matched_any = False
    # "1h" / "1 hr" / "1 hour"
    hr = re.search(r"(\d+(?:\.\d+)?)\s*h", s)
    if hr:
        total += int(float(hr.group(1)) * 3600)
        matched_any = True
    mi = re.search(r"(\d+(?:\.\d+)?)\s*m(?!\w)", s)
    if mi:
        total += int(float(mi.group(1)) * 60)
        matched_any = True
    se = re.search(r"(\d+(?:\.\d+)?)\s*s\b", s)
    if se:
        total += int(float(se.group(1)))
        matched_any = True
    if matched_any:
        return total

    # Bare number — Strong's "Workout Duration" historically uses
    # minutes, so interpret as minutes by default. Switch to seconds
    # when the value is implausibly large for minutes (>= 600 = 10 h).
    bare = _parse_float(s)
    if bare is not None:
        return int(bare) if bare >= 600 else int(bare * 60)

    return None


def _infer_weight_unit(value: float | None, explicit: str | None) -> str:
    """Use the explicit column when present, else heuristic. Strong
    saves in whatever unit the user set; lbs is the default for new
    accounts."""
    if explicit:
        u = explicit.strip().lower()
        if u in {"lb", "lbs", "pound", "pounds"}:
            return "lbs"
        if u in {"kg", "kgs", "kilogram", "kilograms"}:
            return "kg"
    # Values >= 250 are almost always lbs (a 250 kg lift is elite-level
    # and rare; 250 lb is everyday).
    if value is not None and value >= 250:
        return "lbs"
    return "lbs"  # default — Strong's most common config.


def _decode_csv(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


# ─── Public entry point ──────────────────────────────────────────────────────

def parse_strong_csv(raw: bytes) -> StrongParseResult:
    """Parse a Strong workout CSV. Tolerant of header re-ordering,
    embedded duration formats, and partial columns. Sets with no
    weight + no reps + no distance + no seconds are dropped (probably
    Strong's "rest" placeholders or empty rows)."""
    text = _decode_csv(raw)
    reader = csv.reader(io.StringIO(text))

    try:
        header_row = next(reader)
    except StopIteration:
        return StrongParseResult(sets=[], skipped_count=0, errors=["empty file"])

    column_index: dict[str, int] = {}
    for i, raw_header in enumerate(header_row):
        canonical = _normalize_header(raw_header)
        column_index.setdefault(canonical, i)

    if "date" not in column_index or "exercise" not in column_index:
        return StrongParseResult(
            sets=[],
            skipped_count=0,
            errors=["missing required columns 'Date' and/or 'Exercise Name'"],
        )

    def cell(row: list[str], key: str) -> str | None:
        idx = column_index.get(key)
        if idx is None or idx >= len(row):
            return None
        v = row[idx]
        return v if v != "" else None

    sets: list[ParsedWorkoutSet] = []
    errors: list[str] = []
    skipped = 0

    for row_index, raw_row in enumerate(reader, start=1):
        if not any(c.strip() for c in raw_row):
            skipped += 1
            continue

        date_raw = (cell(raw_row, "date") or "").strip()
        parsed_dt = _parse_datetime(date_raw) if date_raw else None
        if parsed_dt is None:
            errors.append(f"row {row_index}: unparseable date {date_raw!r}")
            continue
        meal_date, workout_started_at = parsed_dt

        exercise_raw = (cell(raw_row, "exercise") or "").strip()
        if not exercise_raw:
            skipped += 1
            continue

        set_order_raw = (cell(raw_row, "set_order") or "").strip()

        weight = _parse_float(cell(raw_row, "weight"))
        reps = _parse_int(cell(raw_row, "reps"))
        distance = _parse_float(cell(raw_row, "distance"))
        secs = _parse_int(cell(raw_row, "seconds"))

        # Strong interleaves "Rest Timer" rows between real sets — they
        # carry only the rest interval (Seconds=120). Keep real nonnumeric
        # set markers like "W" warmups, but drop timer-only rows.
        if exercise_raw.strip().lower() in {"rest timer", "rest"} and \
           (weight in (None, 0)) and (reps in (None, 0)) and \
           (distance in (None, 0)) and secs not in (None, 0):
            skipped += 1
            continue

        # Drop placeholder rows entirely — Strong sometimes emits
        # set-order rows with all zero data (when the user added an
        # exercise but didn't log any sets).
        if (weight in (None, 0)) and (reps in (None, 0)) and \
           (distance in (None, 0)) and (secs in (None, 0)):
            skipped += 1
            continue

        sets.append(ParsedWorkoutSet(
            row_index=row_index,
            workout_date=meal_date,
            workout_started_at=workout_started_at,
            workout_name=(cell(raw_row, "workout_name") or None),
            workout_duration_seconds=_parse_duration_seconds(cell(raw_row, "duration")),
            workout_notes=(cell(raw_row, "workout_notes") or None),
            exercise_name=exercise_raw,
            set_order=_parse_int(cell(raw_row, "set_order")) or (len(sets) + 1),
            set_type=_parse_set_type(cell(raw_row, "set_order")),
            weight_value=weight,
            weight_unit=_infer_weight_unit(weight, cell(raw_row, "weight_unit")),
            reps=reps,
            rpe=_parse_float(cell(raw_row, "rpe")),
            distance_value=distance,
            distance_unit=(cell(raw_row, "distance_unit") or None),
            duration_seconds=secs,
            notes=(cell(raw_row, "notes") or None),
        ))

    return StrongParseResult(sets=sets, skipped_count=skipped, errors=errors)


# ─── Helper for the pipeline ─────────────────────────────────────────────────

def group_sets_by_session(
    sets: list[ParsedWorkoutSet],
) -> dict[tuple[date, str | None], list[ParsedWorkoutSet]]:
    """Group sets by (date, workout_name). The pipeline creates one
    `WorkoutCompletion` row per key, then groups within each by
    exercise_name for the `ExerciseSet` inserts."""
    out: dict[tuple[date, str | None], list[ParsedWorkoutSet]] = {}
    for s in sets:
        key = (s.workout_date, s.workout_name)
        out.setdefault(key, []).append(s)
    return out
