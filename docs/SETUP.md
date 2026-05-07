# Setup & Development

## Prerequisites

- Node.js 18+ (`brew install node`)
- Docker Desktop (for backend)
- Expo Go for JS-only smoke testing
- EAS development build for Apple Health, Watch bridge, Live Activity, Apple Sign In, and the local `thallo-*` native modules

## Quick Start

```bash
# Backend
docker compose up -d          # Starts PostgreSQL + FastAPI backend on :8000

# Frontend
npm install
npx expo start                # Starts Metro dev server
npx expo start --tunnel       # If phone can't connect over WiFi
npx expo run:ios              # Local native dev build when testing native modules
```

## Backend Commands

```bash
docker compose build backend && docker compose up -d backend   # Rebuild after code changes
docker compose restart backend                                  # Restart without rebuild
docker logs thallo-backend --tail 50                            # View logs
docker exec thallo-backend python enrich_food_micros.py         # Seed food micronutrients
```

## Environment Variables (backend/.env)

```
SECRET_KEY=...
OPENAI_API_KEY=sk-...
MODEL_PLAN_GENERATION=gpt-4o-mini
MODEL_PLAN_UPDATE=gpt-4o-mini
MODEL_MEAL_PARSING=gpt-4o-mini
MODEL_CHAT=gpt-4o-mini
MODEL_FOOD_ENRICHMENT=gpt-4o-mini
MODEL_IMAGE=gpt-5.4-mini
PLAN_REVIEW_ENABLED=0
NUTRITION_REVIEW_ENABLED=0
STARTUP_ENRICH_FOODS_ENABLED=0
STARTUP_ENRICH_EXERCISE_IMAGES_ENABLED=0
STARTUP_BACKFILL_MUSCLE_FATIGUE_ENABLED=0
GUT_BACKFILL_ENABLED=0
BETA_FULL_ACCESS_ENABLED=1
STARTUP_DATA_MAINTENANCE_ENABLED=0
```

Run `make maintenance` for explicit backend data backfills/seed refreshes, and
`make maintenance-food-micros` when you intentionally want food micronutrient
enrichment to call OpenAI. Startup should stay schema-only by default; enable
the startup enrichment/backfill flags only for a deliberate maintenance deploy.

## Expo Go / Native Build Notes

Expo Go is useful for quick UI iteration, but it does not include Thallo's custom native modules (`modules/thallo-healthkit`, `modules/thallo-watch-bridge`, `modules/thallo-live-activity`) or the Apple Watch targets. Use a development build for HealthKit reads/writes, Watch sync, Live Activity rest timers, Apple Sign In, and any flow that depends on native iOS entitlements.

## Expo Go Troubleshooting

1. Phone and PC must be on the same WiFi
2. If firewall blocks port 8081, use `--tunnel` mode
3. Scan QR code from Expo Go app (not camera)
4. SDK mismatch? Update Expo Go from App Store

## Database

- PostgreSQL 16 in Docker (`thallo-pg` container, port 5433)
- Schema auto-created and idempotent `_ensure_*` migrations run on startup via `create_db_and_tables()`
- Data backfills/seed refreshes are default-off at startup. Run `make maintenance` intentionally.
- Micronutrient enrichment is default-off. Run `make maintenance-food-micros` intentionally.
