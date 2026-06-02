# Context-Aware Health Insights

Last updated: 2026-05-19

Thallo's Context-Aware Health Insights Engine turns opted-in health, workout, recovery, environment, coarse-location, and social summaries into transparent wellness insights. It is not a generic dashboard. Every insight must include:

- A clear insight.
- The data used.
- A confidence label and explanation.
- Why the user is seeing it.
- One recommended next action.

## Insight Categories

| Category | Purpose | Examples |
|---|---|---|
| `move` | Activity, strength, route load, commute, and bone-supporting behaviors | "Add one strength session to complete your bone-support week." |
| `recover` | Sleep, HRV, resting heart rate, load, recent activity, and travel context | "Keep training light; recovery is below baseline." |
| `environment` | Daylight, UV, weather, AQI, temperature, humidity, and outdoor planning | "Take a shaded walk before 10 AM." |
| `connect` | Mutual opt-in friend/group activity summaries | "Schedule one shared workout or send one check-in this week." |
| `improve` | Multi-week habit correlations and next experiments | "Try 3 daylight walks this week." |

## Data Used

Current foundations:

- HealthKit-derived daily snapshots: steps, activity minutes, resting HR, HRV, readiness.
- Sleep logs: duration, score, resting HR, HRV.
- Workout completions: type, duration, intensity, distance, elevation details, route-derived coarse context.
- Sun exposure segments: coarse location hash, area type, UV bucket, confidence, open-sky equivalent minutes.
- Social summaries: mutual opt-in activity counts only.

Future providers can add:

- Weather observations: temperature, humidity, storm risk.
- AQI observations.
- Calendar availability.
- Area coefficients from landcover/canopy/place categories.

## Privacy Model

- All context insight categories and data sources are opt-in through `UserInsightPreferences`.
- Passive derived insight records store coarse location hashes and place categories, not raw passive GPS.
- Workout routes can be used only when the user explicitly recorded workout routes and opted in to route use.
- Sensitive place categories do not create location insights.
- Exact friend locations are never stored or exposed.
- Social insights require mutual opt-in and use aggregate activity signals only.
- Health, location, and social data are not used for ads.
- `DELETE /context-insights/derived-data` removes generated insights, context segments, and daily feature sets without deleting source health/workout records.
- Account deletion removes context insight preferences and derived rows.

## Medical Safety Boundaries

Context insights must not:

- Diagnose medical conditions.
- Predict actual bone density.
- Use the phrase "bone density score."
- Calculate exact vitamin D production or UV dose.
- Infer sensitive health, religious, political, reproductive, or other protected conditions from location.
- Label a user as lonely.

Preferred language:

- "estimated"
- "likely"
- "pattern"
- "appears linked"
- "supporting behavior"
- "below baseline"

## Confidence Scoring

Confidence is based on:

- Number of independent data sources.
- Recent data coverage.
- Whether the signal is directly observed or derived.
- Whether the location/environment context is coarse, workout-route-derived, or user-corrected.
- For segmented context such as sun exposure, repeated rows from the same source or day do not count as independent evidence.
- For recovery context, HRV/RHR signals require a recent baseline before they can drive the insight.

Use:

- `high`: multiple recent direct signals and good coverage.
- `medium`: at least two useful signals or moderate coverage.
- `low`: sparse, indirect, or missing context.

Every insight should explain the confidence in plain language and show its data sources.

## Adding A New Insight

1. Add a pure service method in `backend/app/services/context_insights/services.py`.
2. Return structured data plus safe copy.
3. Convert it to an `Insight` with `title`, `summary`, `recommended_action`, `confidence`, `data_sources`, `explanation`, and optional `safety_note`.
4. Gate generation behind the correct `UserInsightPreferences` flag.
5. Add tests for safety language, confidence, and privacy boundaries.
6. Add frontend copy only through reusable `InsightCard`, `InsightDetailScreen`, or `DailyActionCard`.

## Tuning Insight Priority

Priority should combine:

- Urgency: safety/environment/recovery flags outrank routine suggestions.
- Confidence: higher confidence ranks higher.
- Feasibility: short, realistic actions rank higher.
- User goals and enabled categories.
- Recency and dismissal state.

`NextBestActionService` must return exactly one primary action for today, with at most one secondary action.

## Adding Environment Providers

Add providers as facts, not raw coordinates:

- `temperature`
- `humidity`
- `uv_index`
- `air_quality_index`
- `storm_risk`
- `observed_at`
- `source`
- optional coarse area or user-preferred area

Do not store continuous GPS for weather. Prefer city/ZIP, OS approximate location, or manually chosen preferred area. Update privacy labels and provider documentation before shipping a third-party weather/AQI integration.

## User Feedback And Corrections

Feedback controls should support:

- Helpful / not helpful.
- Correct the context.
- Dismiss.
- Snooze.

Corrections should update derived context or future coefficients, not mutate source health/workout records. Correction prompts should be occasional and gated by `allowOccasionalCorrectionPrompts`, low confidence, or material high-UV/environment impact.
