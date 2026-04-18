# Thallo — Strategy Memo: Pricing, Positioning & Go-to-Market

Last updated: 2026-04-18

---

## 1. Executive Summary

Thallo is a combined workout programming + nutrition planning + recovery tracking app. Its core differentiation is deterministic workout programming (not random AI generation), muscle-group fatigue awareness, and the combination of workout + nutrition in one product. It has an AI convenience layer for coaching, food scanning, and meal generation.

The previous strategy gave away too much in free. Deterministic plan generation and meal programming are the product — giving them away permanently makes premium optional. This memo restructures free/paid, recommends pricing, defines launch sequence, and provides a concrete beta plan.

The recommended price is **$12.99/month or $79.99/year** ($6.67/month effective). This is below the combined cost of Fitbod + MyFitnessPal but positions Thallo as a serious tool, not a disposable free app.

The recommended launch market is **body recomp beginners** (25-40, want to lose fat and build muscle, currently using 2-3 apps badly). HYROX is a strong secondary wedge but too small to lead with.

---

## 2. What Changed From the Original Strategy

**The original plan was too generous with free.** The old free tier included:
- Full deterministic workout plan generation
- 3 meal templates with macro targets
- Fatigue-aware scheduling
- Day swapping
- All 27 themes

That's the entire product. A user on the free tier would get a complete, adaptive training and nutrition system. The only incentive to upgrade was AI chat, food scanning, and more themes — nice-to-haves, not must-haves.

**The fix:** Free becomes a tracking tool. Paid becomes the programming engine. The user can log workouts, log meals, track weight, and see their history for free. But generating an intelligent plan, adapting it, and getting AI-powered convenience requires a subscription.

This is not artificial scarcity. The programming engine has real marginal cost (backend compute for plan generation, AI API calls for nutrition, ongoing adaptation logic). The tracking features have near-zero marginal cost.

---

## 3. Updated Positioning

**What Thallo actually is:** A workout and nutrition programming system that tracks recovery and adapts over time.

**What it replaces:**
- A personal trainer who writes your program ($200-400/month)
- A nutritionist who sets your macros and meal plan ($100-300/session)
- The 2-3 apps you're currently juggling (workout logger + food tracker + maybe a timer)

**How it's different from competitors:**
- Unlike most workout apps, Thallo generates a structured program with deterministic logic — not random exercises or black-box AI. You can see why every exercise is there.
- Unlike most nutrition apps, Thallo generates meal plans that match your training — not just calorie counting.
- Unlike most fitness apps, Thallo tracks fatigue at the muscle-group level and adjusts your next workout accordingly. Hard leg day yesterday means today's plan adapts.
- The rare combination of workout programming + meal planning + fatigue tracking in a single app means you don't need Fitbod AND MyFitnessPal AND a spreadsheet.

**What NOT to claim:** "The only app that..." is fragile and invites scrutiny. Prefer: "One of the few apps that combines..." or "Unlike most fitness apps..."

---

## 4. Updated Free vs Paid Strategy

### Core Principle
**Do not monetize logging. Monetize programming, adaptation, intelligence, and convenience.**

Free users can track themselves. Paid users get programmed for success.

### Free Tier — "Thallo Free"

| Feature | Included |
|---------|----------|
| Manual workout logging (sets, reps, weight) | Yes |
| Manual meal/food logging | Yes |
| Weight tracking + history | Yes |
| Progress charts + PR tracking | Yes |
| Basic macro target display | Yes |
| Exercise library (view exercises) | Yes |
| Fatigue score (view-only, read your state) | Yes |
| One initial plan generation at signup | Yes — the hook |
| 1 theme (default) | Yes |

The one-time plan generation at signup is critical. The user needs to experience the product before deciding to pay. Give them one full plan — workout + nutrition — during onboarding. After that, regeneration, adaptation, and swaps require Pro.

### Pro Tier — "Thallo Pro"

| Feature | Included |
|---------|----------|
| Unlimited workout plan generation | Yes |
| Unlimited plan regeneration | Yes |
| Fatigue-aware schedule adaptation | Yes |
| Day swap (deterministic) | Yes |
| Meal plan generation (5+ templates) | Yes |
| Meal swaps and variety rotation | Yes |
| AI coach (workout + nutrition) | Yes |
| Barcode scanning | Yes |
| Food photo scanning | Yes |
| Body scan analysis | Yes |
| Weekly AI check-ins | Yes |
| Progressive overload recommendations | Yes |
| All 27 themes | Yes |
| Data export (CSV) | Yes |

### Why This Split Is Healthier

The old free tier gave away the engine. A user who signed up, got a plan, and never changed their goal or equipment had no reason to pay. The plan worked. The meals were set. The fatigue score showed. Why upgrade?

The new split creates a natural upgrade moment: **the user's plan gets stale.** After 2-3 weeks, they want to change something — swap a day, regenerate after an injury, adjust for a new goal, get fresh meal ideas. That's when they hit the paywall. The pain is real and the solution is obvious.

Free users still get value — they can log everything manually, see their progress, and use the initial plan until it stops fitting. That's generous enough to not feel hostile, but constrained enough to create a genuine upgrade path.

---

## 5. Recommended Pricing

### Primary Recommendation: $12.99/month or $79.99/year

| Option | Monthly | Annual | Annual Effective |
|--------|---------|--------|-----------------|
| ~~Original~~ | ~~$9.99~~ | ~~$59.99~~ | ~~$5.00~~ |
| **Recommended** | **$12.99** | **$79.99** | **$6.67** |
| Alternative | $14.99 | $89.99 | $7.50 |

### Why Not $9.99/$59.99

The original $59.99/year ($5/month effective) is too cheap. At that price:
- Apple takes 30% → you get $42/year per subscriber
- AI costs eat $6-24/year per active user
- Net margin: $18-36/year per user
- You need 3,000+ paying users just to make $50k/year

At $79.99/year:
- After Apple's cut: $56/year per subscriber
- After AI costs: $32-50/year net
- 1,500 paying users = $48-75k/year

The $20/year difference doesn't meaningfully affect conversion, but it nearly doubles your margin.

### Why Not Higher ($14.99+)

At $14.99/month you're competing with RP Hypertrophy ($14.99) and approaching Juggernaut AI ($34.99). Those are established brands with years of content marketing. You don't have that credibility yet. $12.99 positions you as premium but accessible — more than Strong ($9.99), less than RP, and dramatically cheaper than a coach.

### AI Cost Management

Do NOT promise "unlimited AI." AI features have real per-use cost.

Recommended caps for Pro:
- AI coach: 50 messages/month (covers ~2 conversations/day)
- Food photo scan: 30 scans/month
- Plan regeneration: 10/month
- Body scan: 5/month

These caps are generous enough that 95% of users never hit them, but protect you from the 5% who would burn $20/month in API costs.

Display the caps as "50 coach messages/month" not "limited AI" — framing matters.

### Launch Pricing

Offer a **founding member price** for the first 500 subscribers:
- $9.99/month or $59.99/year (locked for life)
- Creates urgency without a discount code circus
- Rewards early adopters who take a risk on a new app
- You can raise the standard price later without breaking trust

### Themes Are Not a Premium Anchor

The original doc listed themes as a premium feature. This is weak. Nobody pays $12.99/month for dark mode. Keep 1 free theme, put the rest in Pro, but never market themes as a reason to upgrade. They're a bonus, not a value driver.

---

## 6. Competitive Analysis

### The Market Split

| Category | Examples | Gap |
|----------|---------|-----|
| Workout loggers | Strong, Hevy, JEFIT | No programming. User builds their own routine. |
| Workout programmers | Fitbod, Juggernaut AI, RP | No nutrition. Often expensive or niche. |
| Nutrition trackers | MyFitnessPal, MacroFactor, Cronometer | No workouts. Just counting. |
| Combined (expensive) | Caliber, Future, Trainiac | $150-400/month. Human coach dependency. |
| Combined (cheap) | Basically nobody | This is the gap. |

### Head-to-Head

| Competitor | Price | Thallo Advantage | Their Advantage |
|-----------|-------|-----------------|-----------------|
| **Fitbod** ($12.99/mo) | Workout only | Thallo adds nutrition + fatigue | Fitbod has brand recognition, years of data |
| **MyFitnessPal** ($19.99/mo) | Nutrition only | Thallo adds workouts + programming | MFP has massive food database, social |
| **Strong** ($9.99/mo) | Logger only | Thallo generates plans + adapts | Strong is simpler, faster for pure logging |
| **MacroFactor** ($11.99/mo) | Nutrition only | Thallo adds workouts | MacroFactor has better TDEE algorithm |
| **RP Hypertrophy** ($14.99/mo) | Hypertrophy only | Thallo adds nutrition + cardio + HYROX | RP has brand authority in bodybuilding |
| **Caliber** ($199+/mo) | Full coaching | Thallo is 15x cheaper | Caliber has human coaches |

### Defensible Differentiators

1. **Deterministic programming** — the user can understand WHY their plan looks the way it does. Not a black box.
2. **Muscle-group fatigue** — 12-dimension recovery tracking. No competitor does this at the consumer level.
3. **Combined workout + nutrition** — at $12.99, not $200.
4. **HYROX/hybrid support** — genuinely underserved market with no real app competition.

---

## 7. Best Initial Beachhead Market

**Recommendation: Body recomp beginners. Lead with this. HYROX is a strong second wedge, not the primary.**

### Why Body Recomp Beginners

- **Largest addressable group.** "I want to lose fat and build muscle" is the most common fitness goal. Every gym has 50 of these people for every 1 HYROX athlete.
- **Highest pain.** These users are currently using 2-3 apps (or nothing) and getting nowhere. They don't know how to program. They don't know how to eat. They're the most likely to pay for a solution.
- **Best retention potential.** Body recomp is a months-long process. Users who see progress will stay for 6-12+ months.
- **Easiest to reach.** r/loseit has 3.5M members. r/fitness has 11M. r/gainit has 700K. These are your people.

### Why Not HYROX First

HYROX is a great wedge but a small market. The global HYROX community is maybe 500K-1M people, and most of them already have training plans from their coaches or HYROX's own programming. The competitive moat is real but the TAM is small.

**Strategy:** Launch for body recomp. Add HYROX as a visible goal option. When HYROX users find you organically, the product already supports them. Don't spend marketing dollars on HYROX until the core business is working.

### Why Not Intermediate Lifters First

Intermediate lifters (2-5 years training) are hard to convert because they think they already know what they're doing. They have opinions about programming. They'll argue about your rep ranges. They're valuable long-term but expensive to acquire.

---

## 8. Real Launch Strategy

### What NOT To Do

- Do not publish to the App Store and immediately blast Reddit/Twitter. You get one launch moment. If the app crashes, the onboarding is confusing, or the first plan is bad, those users are gone forever and they'll tell others.
- Do not pay for ads before you have retention data. You'll burn money acquiring users who churn in a week.
- Do not hire a social media manager before the product is stable.

### Phase 1: Pre-Launch Prep (Weeks 1-2)

- Get USDA API key
- Generate production SECRET_KEY
- Add Sentry error monitoring
- Create EAS development build, test on real device
- Design app icon and screenshots (hire a designer on Fiverr, $50-100)
- Write App Store description and metadata
- Create a simple landing page (Carrd.co, $19/year) with email signup
- Set up a TestFlight group

### Phase 2: Closed Beta (Weeks 3-5)

- 20-30 beta testers via TestFlight (see Section 9 for recruitment)
- Focus: does onboarding work? Does the first plan make sense? Do meals look right?
- Fix critical bugs. Iterate on confusing UX.
- DO NOT market during beta. This is for finding problems.
- Collect: onboarding completion rate, first-workout completion rate, week-1 retention

### Phase 3: Open Beta / Soft Launch (Weeks 6-7)

- Expand to 100-200 testers
- Submit to App Store review (takes 1-3 days)
- App is live but you're not promoting it yet
- Watch crash reports, API costs, server load
- This is your "does it actually work at scale?" phase

### Phase 4: Public Launch (Week 8)

- App Store listing is polished (screenshots, description, keywords)
- Post on Reddit (see sample post in Appendix C)
- Share in fitness Discord servers
- Post on ProductHunt (if you want — see note below)
- Start creating short-form content (TikTok/Reels showing actual app features)
- Founding member pricing live

### Phase 5: Post-Launch Iteration (Weeks 9-16)

- Monitor metrics (see Section 12)
- Iterate based on feedback
- Start creator seeding (free Pro access to 20-30 micro-influencers)
- Build content library (screen recordings, before/after showcases)
- Consider paid acquisition only after month-1 retention exceeds 30%

### On ProductHunt

ProductHunt is useful if your landing page and App Store listing are already excellent. It drives a one-day spike of traffic from tech-adjacent people — some of whom are fitness enthusiasts. It's free. But it's not a growth strategy. It's a one-time awareness event. Do it in week 8-10, not earlier.

---

## 9. Beta Tester Strategy

### How Many

Start with **20-30 for closed beta**, expand to **100-200 for open beta**. More than 200 in closed beta creates too much noise and you can't respond to everyone.

### Who to Recruit First

Priority order:
1. **People you know who go to the gym** — friends, gym buddies, coworkers. They'll give honest feedback because they know you.
2. **r/fitness, r/loseit, r/gainit Daily Discussion threads** — post a genuine request (see Appendix C). These are real users with real goals.
3. **Fitness Discord servers** — many have #app-feedback or #beta-testing channels.
4. **Your own gym** — put up a small sign or mention it to regulars. Local users are the best testers because you can watch them use it in person.

### iPhone First

Beta via TestFlight (iOS only). Android requires a separate build pipeline and most fitness app early adopters are on iPhone. Ship Android after the iOS version is stable.

### Incentives

**Recommended stack:**
- 3 months free Pro (automatically applied)
- Founding Member badge in their profile
- Direct message access to you for feedback (makes them feel valued)
- Their name in a "Founding Testers" section if they want it

Do NOT offer: lifetime free, cash, gift cards for signup. These attract freebie hunters who won't actually use the app or give feedback.

DO offer the gift card ($25 Amazon) to the **5 testers who give the most detailed feedback** — announced after beta ends, not before. This rewards real engagement, not signup gaming.

### What to Ask Testers

Send a structured feedback form (Google Form or Typeform) after 1 week:
1. Did you complete onboarding? If not, where did you stop and why?
2. Did you start a workout? Was the plan reasonable for your level?
3. Did you look at the meal plan? Did it make sense?
4. What was confusing?
5. What would make you pay $12.99/month for this?
6. What would make you delete it?
7. Net Promoter Score: "How likely are you to recommend Thallo to a friend?" (0-10)

### Ready-to-Launch Criteria

You're ready for public launch when:
- Onboarding completion rate > 70%
- First workout started rate > 50% (of completed onboardings)
- Week-1 retention > 40%
- No crash-on-open bugs
- NPS from beta testers > 30

---

## 10. Outside Marketing Help: What to Pay For and What Not To

### What's Worth Paying For

| Help | Why | Budget |
|------|-----|--------|
| **App Store screenshots / icon design** | First impression. Users decide in 3 seconds. | $50-200 (Fiverr/99designs) |
| **Short-form video editing** | You record screen captures, they edit into TikTok/Reels with music + text | $100-300/month freelancer |
| **ASO (App Store Optimization) audit** | Keywords, description, category optimization. One-time. | $200-500 one-time |
| **Landing page polish** | Clean page with email capture, screenshots, value prop | $100-300 one-time |

### What's NOT Worth Paying For

| Help | Why Not |
|------|---------|
| Social media management agency | They don't understand your product. Generic posts don't convert for fitness apps. |
| Reddit marketing service | Anyone who offers to "market on Reddit" will get you banned. Reddit users detect and punish astroturfing. |
| PR agency | You're pre-revenue. PR agencies cost $3-10K/month and don't move download numbers for consumer apps. |
| Paid ads (yet) | Don't spend on acquisition until you have retention data. You'll optimize for installs, not users who stay. |

### Budget Bands

| Level | Monthly Spend | What You Get |
|-------|-------------|-------------|
| Very lean | $0-100 | You do everything. Canva for graphics. Screen record for videos. |
| Moderate | $200-500 | Fiverr designer for screenshots + freelance video editor for 4-8 Reels/month |
| Early growth | $500-1500 | Above + ASO specialist + creator gifting budget (free Pro codes) |

### On Influencers

Do NOT pay influencers cash at this stage. Instead:
- Give 20-30 micro-influencers (10K-50K followers) free Pro access
- Ask them to try it for 2 weeks and post honestly if they like it
- Some will. Some won't. The ones who do are worth more than any paid post.
- Cost: $0 (just Pro access codes)

---

## 11. Should I Use a Business Loan?

**No. Not yet.**

Here's why:
- You have no proven retention or conversion data. A loan creates repayment pressure before you know if the business works.
- Consumer app revenue is lumpy and slow to build. Subscription revenue takes months to compound. Loan payments don't wait.
- Your launch costs are low. Backend hosting is $5-15/month. Apple Developer is $99/year. AI costs scale with users. There's no capital-intensive manufacturing or inventory.
- The riskiest phase is the first 3 months. If the app doesn't retain users, no amount of marketing spend will fix that. A loan spent on ads for a leaky bucket is just faster failure.

**What to do instead:**
- Self-fund the first $500-1000 (hosting, developer account, design work, small freelancer budget)
- Validate retention and conversion with the first 500-1000 users
- If month-1 retention > 30% and free-to-paid conversion > 3%, THEN consider whether growth capital makes sense
- At that point, a small SBA microloan ($5-15K) or a revenue-based financing tool (Pipe, Clearco) makes more sense than a traditional bank loan

**Bottom line:** Borrow to scale a working machine, not to find out if the machine works.

---

## 12. Key Metrics to Track

| Metric | Why It Matters | Target |
|--------|---------------|--------|
| **Onboarding completion rate** | If users don't finish setup, nothing else matters. Measures whether the flow is too long or confusing. | > 70% |
| **First workout started** | The activation moment. A user who starts a workout is 5x more likely to return. | > 50% of completed onboardings |
| **First meal plan viewed** | Secondary activation. Shows the user engaged with the nutrition side. | > 40% |
| **Day 7 retention** | The cliff. Most app users churn in week 1. If they're still here after 7 days, you have something. | > 35% |
| **Day 30 retention** | The real test. Monthly retention predicts LTV better than anything else. | > 20% |
| **Free-to-paid conversion** | Revenue viability. Below 3% means your paywall is invisible or your free tier is too generous. | > 4% |
| **Paywall encounter rate** | How many free users actually see the upgrade prompt? If it's low, they're not using features that would trigger it. | > 60% |
| **AI cost per active user** | Margin protection. If this exceeds $3/month, you need caps or model optimization. | < $2/month |
| **NPS (Net Promoter Score)** | Would users recommend you? Below 20 means the product has problems. Above 40 means word-of-mouth is working. | > 30 |
| **Churn rate (monthly)** | How many paying users cancel each month. Below 8% is good for a fitness app. Above 12% means the product isn't sticky enough. | < 10% |

---

## 13. Final Recommendation

Ship the beta in the next 2 weeks. Price at $12.99/month or $79.99/year with a founding member discount of $9.99/$59.99. Lead with body recomp beginners. Don't borrow money. Don't pay for ads. Don't hire an agency.

Your biggest risk isn't competition — it's giving away too much for free and never building a subscription business. The product is genuinely good. The free tier should prove that. The paid tier should be where the real value lives.

The second biggest risk is launching too publicly before the product is stable. Beta first. Fix what breaks. Then launch.

---

## Appendix A: 30-60-90 Day Plan

### Days 1-30: Ship and Test

- [ ] Get USDA API key
- [ ] Add Sentry
- [ ] Generate production secrets
- [ ] Create EAS development build
- [ ] Design app icon + screenshots ($50-100 Fiverr)
- [ ] Create landing page with email capture
- [ ] Recruit 20-30 beta testers
- [ ] Submit to App Store (can happen in parallel)
- [ ] Run closed beta via TestFlight
- [ ] Collect structured feedback after week 1
- [ ] Fix critical bugs, iterate on onboarding
- [ ] Implement free/paid paywall

### Days 31-60: Launch

- [ ] Expand to 100-200 testers
- [ ] App Store listing polished and live
- [ ] Founding member pricing active
- [ ] Reddit posts in r/fitness, r/loseit, r/gainit (genuine, not spammy)
- [ ] First 10 short-form videos (screen recordings with captions)
- [ ] ProductHunt launch (optional, one-time)
- [ ] Monitor: retention, conversion, AI costs, crash rate

### Days 61-90: Grow

- [ ] Creator seeding: 20-30 micro-influencers with free Pro
- [ ] ASO optimization based on first month of keyword data
- [ ] Iterate pricing if conversion < 3% (test lower annual, trial period)
- [ ] Build content pipeline: 2-3 Reels/TikToks per week
- [ ] Consider Android build if iOS metrics are solid
- [ ] First revenue milestone: 100 paying subscribers

---

## Appendix B: Sample Beta Tester Recruitment Message

**For friends/gym contacts:**

> Hey — I've been building a fitness app called Thallo for the past few months. It does workout programming + meal planning + recovery tracking in one app. I'm looking for 20-30 people to test it before I put it on the App Store.
>
> What I need: use it for a week, do at least 2 workouts, check out the meal plan, and tell me what's confusing or broken. Takes maybe 30 minutes total.
>
> What you get: 3 months free Pro (normally $12.99/month) and direct input on how the app works.
>
> You'd need an iPhone and TestFlight. Interested?

---

## Appendix C: Sample Reddit Post for r/fitness Daily Discussion

> I'm a developer who's been building a fitness app called Thallo. It combines workout programming, meal planning, and muscle-group recovery tracking in one app.
>
> The workout planner is deterministic (not random AI) — it generates structured programs based on your goal, split, and equipment. The fatigue system tracks 12 muscle groups and adjusts your next session based on what you've actually done.
>
> I'm looking for 20-30 beta testers to try it via TestFlight before I launch publicly. I want honest feedback — what works, what's confusing, what's missing.
>
> If you're interested, DM me with your goal (fat loss, muscle gain, recomp, strength, etc.) and how many days/week you train. I'll send a TestFlight link.
>
> Full disclosure: I built this. I'm not pretending to be a random user. I just want real lifters to tell me if it's useful.

---

## Appendix D: Free Trial vs Freemium Recommendation

**Recommendation: Freemium with one-time generated starter plan.**

| Model | Pros | Cons |
|-------|------|------|
| Free trial (7 days) | Forces urgency, clear conversion moment | Users feel rushed, high churn at trial end, no long-term free users for word-of-mouth |
| Freemium (current recommendation) | Builds audience, word-of-mouth, low-friction | Risk of free tier being too good (solved by constraining it) |
| One-time plan + paywall | User sees full value before paying | No ongoing free engagement, loses users who aren't ready to pay yet |
| Hybrid: freemium + one initial plan | Best of both: user experiences programming once, then needs Pro to continue | Slightly complex to implement |

**Go with the hybrid:** Give every user one full plan at signup (workout + nutrition). After that, regeneration, adaptation, and AI features require Pro. Free users keep the tracking tools forever.

This gives users the "aha moment" during onboarding (they see a real, personalized plan) without giving away ongoing programming for free. When they want to change something 2-3 weeks later, that's the natural upgrade moment.
