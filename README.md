# Thallo — Fitness & Nutrition App

React Native + Expo fitness app with a deterministic workout planner, AI-assisted nutrition, native Apple Health / Watch integrations, and structured coaching.

## Quick Start

```bash
docker compose up -d          # Backend (PostgreSQL + FastAPI on :8000)
npm install && npx expo start # Frontend (Expo dev server)
```

See [docs/SETUP.md](docs/SETUP.md) for full setup instructions.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Key files, data flow, module responsibilities |
| [docs/GOALS_AND_SPLITS.md](docs/GOALS_AND_SPLITS.md) | Goals, training splits, stimulus types, target focus |
| [docs/AI_USAGE.md](docs/AI_USAGE.md) | Every AI call, cost estimates, feature flags |
| [docs/SCORING.md](docs/SCORING.md) | Every scored algorithm: sleep, readiness, nutrition, fitness, fatigue, e1RM, weekly volume |
| [docs/SETUP.md](docs/SETUP.md) | Dev environment, Docker, Expo, env vars |

## Architecture at a Glance

```
User → React Native (Expo) → FastAPI backend → PostgreSQL
                                    |
                    ┌───────────────┼───────────────┐
                    |               |               |
             Workout Planner   Nutrition        AI Services
             (deterministic)   (hybrid)         (scoped)
                    |               |               |
              weekly_recipe    meal_assembler   chat/scanning
              slots/scoring    calorie_calc     coach/apply
              prescriptions    context          progression
```

**Workout planner is fully deterministic** — no AI. Structure, exercise selection, scoring, prescriptions, and validation are all rule-based.

**Nutrition is hybrid** — AI may create meal skeletons / parsing output, then deterministic services size portions, normalize macros, score meals, and apply allergen filters.

**AI services are scoped** — chat, scans, enrichment, supplement recommendations, parsing, and selected recommendations can use OpenAI. Legacy workout and nutrition AI review flags are disabled no-ops; the active PlanWeek is not rewritten by AI.

## Tech Stack

- **Frontend**: React Native 0.81.5 + Expo SDK 54 + expo-router 6 + TypeScript
- **Backend**: FastAPI + SQLModel + PostgreSQL 16
- **AI**: `gpt-4o-mini` for text flows, `gpt-4o-mini-transcribe` for phone speech-to-meal transcription, and `gpt-5.4-mini` for dedicated image-analysis endpoints
- **Storage**: PostgreSQL source of truth + AsyncStorage hot/offline cache

## License

MIT
