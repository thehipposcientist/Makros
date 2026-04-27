# Social System — Architecture

Last synced from CLAUDE.md: 2026-04-27

Friend list + once-a-week digest only. **No public feed, no posts, no reactions, no comments.**

## Tables

- `user_social_profiles` — `display_name` + `share_activity_enabled`. Lazy-created on first `/social/me` read. Auth-level `User.username` is the friend-search handle.
- `friendships` — canonical pair (`user_a_id < user_b_id`), `status` ∈ {pending/accepted/blocked}, `requested_by`, `blocked_by`. Unique index on `(user_a_id, user_b_id)`.
- `weekly_digest_cache` — per-user-per-week JSON. TTL = 1 hour + eager invalidation on accept/remove/block.

## Privacy Model

| Visible to friends | Never visible |
|---|---|
| Sessions completed (count only) | Calories, macros, weight |
| Streak length | Body fat, measurements |
| Goal label | Specific lifts/weights, PRs |
| Active-in-last-48h dot | Meal logs, recovery flags |

`share_activity_enabled` defaults **off**. Friends without it on show `sessions=0 / streak=0 / share_enabled=false`.

## Aggregation (`services/social/digest.py`)

Pure-function helpers — no DB writes:
- `week_start_for(today)` — Monday of containing week.
- `_streak_days(dates, today)` — consecutive completion days, tolerates not-yet-trained today.
- `_last_active(dates, today)` — most recent completion ≤ today.
- `compute_digest(db, user_id, today)` — pulls accepted friends, runs `_completion_dates` per friend over 7-day window.

Digest `summary`: `friend_count`, `friends_trained_this_week`, `total_friend_sessions`, `top_user_id`, `top_sessions`, `long_streak_count` (≥14 days).

## API (`routers/social.py`)

| Endpoint | Description |
|---|---|
| `GET /social/me` | Own profile (lazy-creates row). |
| `PATCH /social/me` | Update `display_name` / `share_activity_enabled`. |
| `GET /social/friends` | `{friends, pending}` — both carry `friendship_id`. Pending carries `direction`. |
| `POST /social/friends/request` | Body `{username}`. Auto-accepts if other user had a pending request to you. 409 if already friends; 404 if blocked or not found. |
| `POST /social/friends/{id}/{accept,reject,remove,block}` | State transitions. `reject`/`remove` delete row. `block` keeps row hidden. |
| `GET /social/search?q=...` | Username prefix search, ≥2 chars, max 10 results, excludes caller. |
| `GET /social/digest` | Cached weekly payload. Eagerly invalidated on friend-state change. |

## Client (`src/components/FriendsModal.tsx`)

Full-screen modal in `HomeScreen`. Three sections:
1. **THIS WEEK** — digest summary + YOU row.
2. **REQUESTS / FRIENDS / SENT** — pending incoming, accepted, pending outgoing. Long-press → remove confirm.
3. **ADD FRIENDS** — username prefix search with 250ms debounce.

Profile tab: "Friends · N" row with pending-request badge. Count refreshes on Profile-tab activation + FriendsModal close.

## Key Design Decisions

- No live feed — keeps App Store review simple.
- Reuse `User.username` (globally unique) as friend handle — no separate social handle.
- Canonical pair `(user_a_id < user_b_id)` — exactly one row per pair.
- Eager cache invalidation — newly-accepted friend appears in digest within seconds.
- Digest reads `WorkoutCompletion.workout_date` only — calorie/macro/weight data NEVER crosses social boundary.
