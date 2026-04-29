# AI Usage & Cost

Last updated: 2026-04-29

Pricing below reflects current OpenAI list prices used for internal planning. Thallo is deterministic first: AI adds content, classification, or coaching, but it does not drive workout-plan structure.

## Current Model Routing

| Flow | Default model | Notes |
|---|---|---|
| Trainer chat / workout coach / check-in coach | `gpt-4o-mini` | Text-first coaching and structured JSON responses |
| Meal parsing and text fallback search | `gpt-4o-mini` | Text-only parsing and fallback interpretation |
| Food enrichment / classification fallback | `gpt-4o-mini` | Cached or one-time enrichment paths |
| Dedicated image-analysis endpoints | `gpt-5.4-mini` | Food photo, multi-food scan, supplement photo, multi-supplement scan, equipment scan, form photo, body scan |
| Workout planner structure | None | Fully deterministic |

## Image Model Change: Cost Impact

On 2026-04-29, the dedicated image-analysis default moved from `gpt-5-mini` to `gpt-5.4-mini` via `MODEL_IMAGE`.

| Model | Input / 1M tokens | Output / 1M tokens |
|---|---|---|
| `gpt-5-mini` | $0.25 | $2.00 |
| `gpt-5.4-mini` | $0.75 | $4.50 |

For the same billed token volume on image-analysis requests:

- Input token cost is `3.0x` higher.
- Output token cost is `2.25x` higher.
- A workload with equal 1M input + 1M output tokens would move from `$2.25` to `$5.25` total, a `133%` increase.

Actual per-request spend still varies with image tokenization, number of images, prompt length, and output length. The important practical takeaway is that this change only affects the dedicated image-analysis routes, not the broader text AI footprint.

## What Is Affected

These endpoints now use `MODEL_IMAGE` by default:

- `POST /ai/food-photo`
- `POST /ai/scan-foods`
- `POST /ai/supplement-photo`
- `POST /ai/scan-supplements`
- `POST /ai/scan-equipment`
- `POST /ai/form-photo`
- `POST /ai/body-scan`

These flows are not affected by the `MODEL_IMAGE` switch:

- Home trainer chat
- Weekly/daily check-in coach
- Text-only meal parsing and search fallback
- Food enrichment / classification fallback
- In-workout recommendation review

One nuance: `POST /ai/workout-question` can accept an attached image, but it still runs on `MODEL_CHAT` today rather than `MODEL_IMAGE`.

## Current Flag State

| Flag | Current state | Effect |
|---|---|---|
| `PLAN_REVIEW_ENABLED=0` | Disabled no-op | Legacy workout AI review path is effectively off |
| `NUTRITION_REVIEW_ENABLED=0` | Disabled no-op | Legacy nutrition review path is effectively off |
| `STARTUP_ENRICH_FOODS_ENABLED=1` | On | Background enrichment on backend boot |
| Missing `OPENAI_API_KEY` | Graceful degradation | Deterministic paths still work |

## Zero-AI Systems

These systems remain fully deterministic and have no model cost:

- Workout split selection, weekly recipe, day sequencing, and exercise choice
- Set/rep/rest prescription logic
- Split recommendation and rationale text
- Calorie and macro target calculation
- Meal portion solving and macro normalization
- Exercise adjacency repair and intensity spacing
- Plan validation and focus-volume adjustments

## Practical Cost Read

The image-model switch raises the cost ceiling of photo-driven features, but it does not change the cost of the app's core planner, chat, or weekly coaching flows. If AI cost starts climbing after this change, the most likely source will be higher volume in food scans, supplement scans, form-photo analysis, or body scans rather than routine text chat.

## Estimated Monthly Cost Per User

These are planning estimates, not invoice-grade forecasts. They assume current model routing, normal prompt sizes, and standard OpenAI pricing as of 2026-04-29.

| User profile | Typical behavior | Estimated AI cost / month |
|---|---|---|
| Low-AI user | ~12 workouts, ~4 coach/check-in interactions, ~2-4 image scans, ~1 regen | $0.03-$0.08 |
| Typical engaged user | ~16 workouts, ~10-15 coach/check-in interactions, ~8-15 image scans, ~1 regen | $0.10-$0.30 |
| Heavy AI user | ~20-24 workouts, ~30-40 coach interactions, ~40-60 image scans, ~2-4 regens | $0.40-$1.20 |

## Budgeting Guidance

- If users mostly log workouts, read summaries, and occasionally chat, a good planning number is about `$0.15 per user per month`.
- If users are heavy on food photos, supplement scans, form photos, or body scans, a safer planning number is about `$0.50-$1.00 per user per month`.
- Text AI is cheap relative to photo analysis. The biggest cost swing in Thallo comes from scan volume, not from normal trainer chat or deterministic workout usage.

## Assumptions Behind The Estimates

- Most text flows run on `gpt-4o-mini`.
- Dedicated image-analysis routes run on `gpt-5.4-mini`.
- Workout planning remains deterministic, so plan structure itself adds no AI cost.
- The ranges are intentionally broad because image requests can vary a lot by number of photos, prompt size, and output length.
