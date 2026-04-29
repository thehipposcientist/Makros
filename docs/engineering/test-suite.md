# Test Suite

Last synced from test run: 2026-04-29

## Running Tests

```bash
docker exec thallo-backend python -m tests.run_all
make test
```

Current observed baseline: 8 known pre-existing failures in `make test` as of 2026-04-29. New failures after a change = regression, must fix.

Baseline failing tests on 2026-04-29:

- `test_fatigue_override_mid_band_minus_5pct`
- `test_fatigue_override_high_band_minus_10pct`
- `test_fatigue_override_very_high_band_minus_15pct_low_confidence`
- `test_ai_first_time_no_muscle_sessions_returns_none`
- `test_ai_first_time_three_sessions_hits_ai_and_stamps_fields`
- `test_full_week_reports_sessions_volume_and_adherence`
- `test_missed_watch_summary_recommends_watch`
- `test_user_scenario_wife_forgot_watch_full_flow`

## Test Modules (`backend/tests/`)

| Module | Coverage |
|---|---|
| `test_change_day_type` | 31 tests for `change_day_type.py` pure-function service — single mode, smart mode, conflicts, cycles, protection. |
| `test_switch_day` | 49 tests for single-day switch logic. |
| `test_switch_day_rotation` | 24 tests for focus rotation. |
| `test_switch_day_splits` | 118 tests for split-aware switching. |
| `test_switch_day_integration` | 736 integration tests. |
| `test_readiness_compute` | Readiness score computation. |
| `test_weekly_volume` | `_classify` band logic, spike detection, range sanity. |
| `test_carb_distribution` | Protein invariant, carb shifts, per-goal caps, ±5 kcal preservation, 40g floor. |
| `test_quick_intents` | All 12 intents match positive cases, no false-positives, handlers return structured actions. |
| `test_rolling_e1rm` | <3 sample fallback, Epley+RIR math, recency weighting, warmup filtering, rep band, confidence tier. |
| `test_live_workout_recommendations` | 66 tests: `load_increment_for`, `round_to_increment`, `parse_rep_range`, `build_set_scheme`, `recommend_next_set`, `recommend_next_session_load`, `is_suspicious`, `reviewed_next_set_recommendation`, `compute_rolling_e1rm`. |
| `test_social_digest` | `week_start_for`, streak math, `_last_active`, `_canonical_pair`. |
| `test_api_smoke` | HTTP smoke tests against running backend. |

## Known Gaps (not yet written)

- `plan_review_v2._build_headline` — pure-function, no DB.
- `carb_distribution.classify_day` + `redistribute_macros` — pure-function, no DB.
- AI estimator regression — mock OpenAI client, verify clamping (collagen ≤30g, CFU ≤200B).
- Plan review snapshot — seed 5 completions over 7 days, expect specific recommendation keys.
- Watch payload schema — assert `WatchWorkoutPayload` JSON round-trips through Swift `Codable`.

## Testing Rules

- Prefer pure-function tests (no DB) for deterministic logic. They're fast and reliable.
- DB-touching tests require the full Docker stack to be up.
- When adding a new service file, add a corresponding test module and register it in `run_all.py`.
- Do not mock the database for integration tests — live DB failures catch real migration issues.
