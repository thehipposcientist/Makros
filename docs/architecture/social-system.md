# Social System — Architecture

Last updated: 2026-05-05

Friend list + once-a-week digest + a bounded friends-only activity feed. There is still no public discovery feed and no comments.

## Tables

- `user_social_profiles` — `display_name` + `share_activity_enabled`. Lazy-created on first `/social/me` read. Auth-level `User.username` is the friend-search handle.
- `friendships` — canonical pair (`user_a_id < user_b_id`), `status` ∈ {pending/accepted/blocked}, `requested_by`, `blocked_by`. Unique index on `(user_a_id, user_b_id)`.
- `weekly_digest_cache` — per-user-per-week JSON. TTL = 1 hour + eager invalidation on accept/remove/block.
- `activity_feed` — friends-only workout activity rows. Feed payloads are sanitized to workout structure only.
- `feed_likes` — one like per user/feed item.
- `social_notifications` — in-app notification inbox for friend requests, accepted requests, and feed likes. Unique per actor + subject so unlike/re-like loops do not spam duplicates.

## Privacy Model

| Visible to friends | Never visible |
|---|---|
| Sessions completed, workout focus/duration/exercises/sets/reps, recorded lift load, cardio time/distance/pace | Calories, macros, body weight |
| Streak length | Body fat, measurements, body photos |
| Goal label | Meal logs, recovery flags |
| Active-in-last-48h dot | Private notes, reports, account data |

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
| `GET /social/notifications` | In-app social inbox: `{items, unread_count}` for friend requests, accepts, and likes. |
| `POST /social/notifications/{id}/read` | Mark one notification read. |
| `POST /social/notifications/read-all` | Mark all current user's notifications read. |
| `GET /social/feed` | Bounded feed for self + friends with sharing enabled. |
| `GET /social/feed/{user_id}` | Friend detail feed when the friend has sharing enabled. |
| `POST /social/posts` | Optional workout share with caption/photo + sanitized workout summary. |
| `DELETE /social/posts/{id}` | Delete own post. |
| `POST /social/feed/{id}/like` | Toggle a persisted like on a visible feed item; returns `{liked, like_count}`. |

## Client (`src/components/FriendsModal.tsx`, `src/components/SocialFeedView.tsx`)

Full-screen modal in `HomeScreen`. Two tabs:
1. **Activity** — latest workout shares from self + friends with sharing enabled.
2. **Friends** — THIS WEEK digest, requests/friends/sent rows, and ADD FRIENDS username search with 250ms debounce.

Both tabs share the Social toolbar. The bell opens the in-app notification tray; friend-request taps switch to Friends, like/accept taps switch to Activity. Bottom-tab badge uses unread social notifications, falling back to incoming request count.

Profile tab: "Friends · N" row with pending-request badge. Count refreshes on Profile-tab activation + FriendsModal close.

## Key Design Decisions

- Activity is bounded and friends-only — it is a recent activity surface, not an infinite public feed.
- Reuse `User.username` (globally unique) as friend handle — no separate social handle.
- Canonical pair `(user_a_id < user_b_id)` — exactly one row per pair.
- Eager cache invalidation — newly-accepted friend appears in digest within seconds.
- Digest reads `WorkoutCompletion.workout_date` only.
- Feed write/read paths sanitize payloads so calorie/macro/body-weight/body-composition data never crosses social surfaces. Workout-only set load and cardio metrics are allowed.
- PR feed rows are accepted so badges can attach to workout cards, but the sanitized payload omits PR values.
