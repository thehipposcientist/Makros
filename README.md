# Thallo — Fitness & Nutrition App

React Native + Expo fitness app with a deterministic workout planner, AI-assisted nutrition, and structured coaching.

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
             (deterministic)   (hybrid)         (gated)
                    |               |               |
              weekly_recipe    meal_assembler   plan_review
              slots/scoring    calorie_calc     chat/scanning
              prescriptions    context          progression
```

**Workout planner is fully deterministic** — no AI. Structure, exercise selection, scoring, prescriptions, and validation are all rule-based.

**Nutrition is hybrid** — AI picks meal skeletons, deterministic solver sizes portions and hits macro targets.

**AI services are gated** — review, enrichment, and coaching only fire when enabled via env flags.

## Tech Stack

- **Frontend**: React Native 0.76 + Expo SDK 54 + TypeScript
- **Backend**: FastAPI + SQLModel + PostgreSQL
- **AI**: OpenAI gpt-4o-mini (gated, deterministic fallbacks everywhere)
- **Storage**: AsyncStorage (client) + PostgreSQL (server)

## License

MIT
