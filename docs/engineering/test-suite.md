# Test Suite

Last synced from test run: 2026-05-22

## Running Tests

```bash
docker exec thallo-backend python -m tests.run_all
make test
npm run test:frontend
```

There is no fixed pass count. A handful of failures are flaky / environment-dependent and vary run to run — e.g.:

- `test_food_search_can_disable_ai_fallback_for_signup` — hits the live FatSecret API
- `test_99_delete_account_cleans_up` — sensitive to leftover DB state from prior runs
- `test_digestion_patterns_requires_symptom_checkin` — heuristic insight thresholds

Treat only a NEW failure in code you actually touched as a regression. Run `make test` before and after a change and compare.

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
| `test_quick_intents` | All 13 intents match positive cases, no false-positives, and the state-mutating handlers return structured actions. |
| `test_rolling_e1rm` | <3 sample fallback, Epley+RIR math, recency weighting, warmup filtering, rep band, confidence tier. |
| `test_live_workout_recommendations` | 87 tests: `load_increment_for`, `round_to_increment`, `parse_rep_range`, `build_set_scheme`, `recommend_next_set`, `recommend_next_session_load`, `is_suspicious`, deterministic review, route aliases, metadata/trace, malformed live snapshots, `compute_rolling_e1rm`. |
| `test_social_digest` | `week_start_for`, streak math, `_last_active`, `_canonical_pair`. |
| `test_api_smoke` | HTTP smoke tests against running backend. |

## Known Gaps (not yet written)

- `plan_review_v2._build_headline` — pure-function, no DB.
- AI estimator regression — mock OpenAI client, verify clamping (collagen ≤30g, CFU ≤200B).
- Plan review snapshot — seed 5 completions over 7 days, expect specific recommendation keys.
- Watch payload schema — assert `WatchWorkoutPayload` JSON round-trips through Swift `Codable`.

## Frontend / Platform Coverage

`npm run test:frontend` runs lightweight TS/MJS tests with `scripts/run-frontend-tests.mjs`.
Android-specific coverage includes API base URL resolution for emulators, platform
health capability/copy expectations, Android manifest/app-config permission
checks, and iOS-only native-module autolinking guards.

Maestro Android parity coverage lives in `.maestro/flows/android-platform-parity.yaml`
and can be run with:

```bash
make seed-e2e
MAESTRO='maestro --device emulator-5554' make smoke-mobile-android-platform
```

## Testing Rules

- Prefer pure-function tests (no DB) for deterministic logic. They're fast and reliable.
- DB-touching tests require the full Docker stack to be up.
- When adding a new service file, add a corresponding test module and register it in `run_all.py`.
- Do not mock the database for integration tests — live DB failures catch real migration issues.
