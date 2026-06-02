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
```

## Environment Variables (backend/.env)

```
SECRET_KEY=...
OPENAI_API_KEY=sk-...
USDA_FDC_API_KEY=...
FATSECRET_CLIENT_ID=...
FATSECRET_CLIENT_SECRET=...
FATSECRET_SCOPE=basic
FATSECRET_SEARCH_VERSION=v1
MODEL_PLAN_GENERATION=gpt-4o-mini
MODEL_PLAN_UPDATE=gpt-4o-mini
MODEL_MEAL_PARSING=gpt-4o-mini
MODEL_TRANSCRIPTION=gpt-4o-mini-transcribe
MODEL_CHAT=gpt-4o-mini
MODEL_FOOD_ENRICHMENT=gpt-4o-mini
MODEL_IMAGE=gpt-5.4-mini
PLAN_REVIEW_ENABLED=0
NUTRITION_REVIEW_ENABLED=0
BETA_FULL_ACCESS_ENABLED=0
SIGNUP_TRIAL_DAYS=7
REVENUECAT_PRO_ENTITLEMENT_ID=pro
REVENUECAT_SECRET_API_KEY=...
REVENUECAT_WEBHOOK_AUTH_TOKEN=...
STARTUP_DATA_MAINTENANCE_ENABLED=0
STARTUP_BACKFILLS_ENABLED=0
```

Enable the RevenueCat beta UI in an Expo build with `EXPO_PUBLIC_BILLING_REVENUECAT=1`
plus the platform public SDK keys (`EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` and/or
`EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY`). Leave it unset for builds where the
server trial should work quietly without exposing store purchase buttons.

Run `make maintenance` for explicit backend data refreshes and seed refreshes.
Startup stays schema-only; deploy/restart paths do not run data backfills, AI
enrichment, or historical classification jobs unless explicitly opted in.

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
- AI micronutrient backfill scripts are removed; logged/requested foods rely on DB values plus live user-triggered classification where applicable.
