# Thallo Social System — Design Doc

## Core Concept

Lightweight accountability-first social layer. Not a feed-scroll app — built around mutual visibility into training consistency, friendly challenges, and shared progress milestones.

---

## 1. Connection Model

**Friends (mutual)** — both users must accept. No followers/following asymmetry.

- Add by username or invite link (deep link `thallo://invite/{code}`)
- Optional: sync contacts to suggest existing Thallo users
- Cap at ~100 friends to keep it intimate (raise later if needed)

### DB Schema

```sql
friendships (
  id            UUID PK,
  requester_id  UUID FK -> users,
  receiver_id   UUID FK -> users,
  status        TEXT CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at    TIMESTAMPTZ,
  accepted_at   TIMESTAMPTZ
)
-- unique constraint on sorted (requester_id, receiver_id) to prevent duplicates
```

---

## 2. What Gets Shared

Users control visibility per category. Default: everything **off** — opt-in only.

| Data | Shared As | Notes |
|------|-----------|-------|
| Workout completions | "Sawyer completed Push Day (52 min)" | No exercise details unless tapped |
| Streak | "12-day streak" | Always visible to friends |
| Weekly compliance | Green/amber/red dot per day | Calendar strip, no granular data |
| PRs / Milestones | "New PR: Bench 225 lb" | Auto-detected from workout history |
| Weight trend | Direction only ("down 3 lb this month") | Never shows absolute weight |
| Fitness score | Composite number (0-100) | Optional — some users won't want this visible |
| Nutrition | **Never shared** | Too personal, too easy to trigger unhealthy comparison |

### Privacy Settings Schema

```sql
social_privacy (
  user_id           UUID PK FK -> users,
  share_workouts    BOOLEAN DEFAULT false,
  share_streak      BOOLEAN DEFAULT true,
  share_compliance  BOOLEAN DEFAULT false,
  share_prs         BOOLEAN DEFAULT false,
  share_weight_dir  BOOLEAN DEFAULT false,
  share_fitness_score BOOLEAN DEFAULT false
)
```

---

## 3. Activity Feed

Simple reverse-chronological feed of friends' shared activity. No algorithm, no ranking, no ads.

### Feed Item Schema

```sql
social_events (
  id          UUID PK,
  user_id     UUID FK -> users,
  event_type  TEXT,  -- 'workout_complete', 'streak_milestone', 'pr', 'weight_milestone', 'challenge_update'
  payload     JSONB, -- type-specific data (focus, duration, pr_exercise, pr_value, etc.)
  created_at  TIMESTAMPTZ
)
-- Index on created_at DESC for feed queries
-- TTL: auto-delete events older than 90 days
```

### Feed Query

```
GET /social/feed?before={cursor}&limit=20

Returns events from accepted friends where the event_type
matches the friend's privacy settings.
```

### Reactions

Simple — one reaction type: a fist bump (single tap, toggle on/off). No comments in v1 (avoids moderation burden).

```sql
social_reactions (
  event_id  UUID FK -> social_events,
  user_id   UUID FK -> users,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, user_id)
)
```

---

## 4. Challenges

The real value prop. Two types:

### A. Streak Challenge
- Two or more friends commit to X workouts/week for Y weeks
- Everyone sees a shared tracker
- Miss a week = eliminated (or just flagged, depending on mode)

### B. Volume Challenge
- "Most total sets this week" or "Most active minutes this month"
- Leaderboard among participants
- Auto-resolves at deadline

### Schema

```sql
challenges (
  id            UUID PK,
  creator_id    UUID FK -> users,
  title         TEXT,
  type          TEXT CHECK (type IN ('streak', 'volume')),
  metric        TEXT,  -- 'workouts_per_week', 'total_sets', 'active_minutes'
  target        INT,   -- e.g. 4 workouts/week
  start_date    DATE,
  end_date      DATE,
  status        TEXT CHECK (status IN ('pending', 'active', 'completed')),
  created_at    TIMESTAMPTZ
)

challenge_participants (
  challenge_id  UUID FK -> challenges,
  user_id       UUID FK -> users,
  status        TEXT CHECK (status IN ('invited', 'accepted', 'eliminated', 'completed')),
  current_value REAL DEFAULT 0,
  joined_at     TIMESTAMPTZ,
  PRIMARY KEY (challenge_id, user_id)
)
```

### Challenge Flow

```
Creator picks type + metric + friends + duration
  -> Invites sent (push notification)
  -> Accepted friends join
  -> Challenge goes active on start_date
  -> Backend cron updates current_value nightly from workout_completions
  -> Push notifications: "Alex just hit 5 workouts this week"
  -> End date: declare winner / celebrate completions
```

---

## 5. Notifications

All social notifications are push (expo-notifications) with in-app badge.

| Trigger | Message |
|---------|---------|
| Friend request | "Alex wants to connect on Thallo" |
| Friend completed workout | "Alex finished Leg Day" (if opted in) |
| Streak milestone (7, 30, 60, 100) | "Alex hit a 30-day streak!" |
| Challenge invite | "Alex invited you to a 4-week streak challenge" |
| Challenge update | "You're in 2nd place — 1 workout behind Alex" |
| Fist bump received | "Alex fist-bumped your Push Day" |

---

## 6. UI Layout

### New Tab: "Social" (or add to existing Progress tab)

```
Social Tab
  ├── Feed (default view)
  │     └── Scrollable list of friend events + fist bump buttons
  ├── Friends
  │     ├── Friend list with streak/score badges
  │     ├── Pending requests
  │     └── Add friend (username / invite link)
  └── Challenges
        ├── Active challenges with progress bars
        ├── Challenge invites
        └── Create challenge button
```

### Profile additions
- Privacy toggles in Settings > Social
- "Share Profile" button generates invite link
- Friend count badge

---

## 7. API Endpoints

```
# Friends
POST   /social/friends/request      {username}
POST   /social/friends/accept       {friendship_id}
POST   /social/friends/block        {user_id}
DELETE /social/friends/{user_id}
GET    /social/friends               -> list with streak/score

# Feed
GET    /social/feed?before=&limit=   -> paginated friend events
POST   /social/feed/{event_id}/react -> toggle fist bump
GET    /social/feed/mine             -> your own shared events

# Challenges
POST   /social/challenges            {type, metric, target, friend_ids, start_date, end_date}
GET    /social/challenges            -> active + pending
GET    /social/challenges/{id}       -> detail with leaderboard
POST   /social/challenges/{id}/join
POST   /social/challenges/{id}/leave

# Privacy
GET    /social/privacy
PUT    /social/privacy               {share_workouts, share_streak, ...}
```

---

## 8. Implementation Order

| Phase | Scope | Effort |
|-------|-------|--------|
| **Phase 1** | Friendships + streak visibility + fist bumps | ~1 week |
| **Phase 2** | Activity feed + privacy controls | ~1 week |
| **Phase 3** | Streak challenges | ~1 week |
| **Phase 4** | Volume challenges + leaderboard | ~3-4 days |
| **Phase 5** | Push notifications for social events | ~2-3 days |

Total: ~4 weeks of focused work.

---

## 9. Key Decisions / Trade-offs

- **No comments** — avoids moderation, keeps it lightweight. Fist bumps are enough for v1.
- **No nutrition sharing** — deliberate. Weight/body data is sensitive; sharing macro counts invites unhealthy comparison.
- **Weight direction only** — "down this month" not "167.3 lb". Protects privacy while still sharing progress.
- **90-day event TTL** — keeps the DB lean, feed relevant. Nobody scrolls back 6 months.
- **Nightly challenge updates** — not real-time. Keeps infra simple, avoids obsessive checking.
- **Friend cap (100)** — this isn't Instagram. Small circles drive accountability better than large audiences.
- **Opt-in everything** — social features should feel like a bonus, not a requirement. Zero social data shared until the user explicitly enables it.
