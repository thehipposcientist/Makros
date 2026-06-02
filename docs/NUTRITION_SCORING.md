# Nutrition Scoring System

## What Was Missing Before
- Diet score was frontend-only and tracked meal LOGGING adherence (did you check meals off?), not food QUALITY
- No whole-food vs processed classification
- No micronutrient gap detection
- No combined health score with nutrition as a pillar
- No user-facing nutrition tags or daily indicators
- No weekly nutrition trends

## What Changed
- New `nutrition_score.py` module — single source of truth for all nutrition scoring
- `/meals/score` scores the projected day plan first, not checked/logged meal totals
- 3-dimension scoring: Adherence (35-40%) + Food Quality (35-40%) + Micronutrient Coverage (20-25%)
- Goal-aware weight adjustments (muscle_gain biases protein/calories, general_health biases micros)
- Food quality classification (whole/processed/unknown) from existing food categories
- Micronutrient gap detection with confidence gating
- User-facing tags: "Protein target hit", "Mostly whole foods", "Likely low calcium"
- Weekly trend with pattern detection
- Overall health score combining nutrition + activity + sleep + recovery

## Scoring Model

### Nutrition Score (0-100)

**Adherence Bucket (35-40% weight)**
- Calorie alignment (0-40 pts): 1.0 inside ±5%, "close" through ±10%, then degrades outside that zone
- Protein alignment (0-60 pts inside adherence): 1.0 at ≥95% of target
- Projected meal coverage for confidence: planned meals / expected meals

**Food Quality Bucket (35-40% weight)**
- Whole food % (0-35 pts): linear from 0-100%
- Processed food penalty (0-20 pts deducted): linear from 0-100%
- Fiber (0-20 pts): proportion of 28g RDA
- Fruit/veg servings (0-15 pts): 5 servings = full credit
- Hydration (0-10 pts): logged or not

**Micronutrient Coverage Bucket (20-25% weight)**
- Checks 6 key micros against RDA: calcium, iron, potassium, magnesium, vitamin D, vitamin C
- ≥70% RDA = "hit", <40% RDA = "gap"
- Score: (hits / checked) × 100
- Low-confidence data pulls score toward neutral (60% weight + 30 baseline)

### Goal-Aware Weights

| Goal | Adherence | Quality | Micros |
|------|-----------|---------|--------|
| muscle_gain / strength | 40% | 35% | 25% |
| fat_loss | 40% | 40% | 20% |
| body_recomp | 38% | 37% | 25% |
| endurance / athletic / hyrox | 35% | 35% | 30% |
| general_health / maintain | 30% | 35% | 35% |

### Confidence Levels
- **High**: logging ≥70% complete AND micro data coverage ≥70%
- **Medium**: logging 30-70% OR micro coverage low
- **Low**: logging <30%

### Overall Health Score (0-100)

Combines available domains with normalized weights:
- Nutrition: 30% ideal weight
- Activity: 25%
- Sleep: 25%
- Recovery: 20%

Missing domains don't penalize — weights redistribute among available data.

### Weekly Trend
- 7-day rolling average for score, adherence, quality
- Pattern detection: "Protein consistently on target", "Fiber inconsistent", "Processed food elevated"
- Trend direction: improving / stable / declining (comparing first half vs second half of week)

## User-Facing Tags

**Positive:**
- Calorie target hit
- Protein target hit
- Fiber target hit
- Produce goal hit
- Mostly whole foods
- Hydration on target
- Micronutrient coverage: strong/decent

**Actionable:**
- Calories off target
- Protein below target
- Fiber low
- More fruits and vegetables
- High processed-food day
- Likely low calcium/iron/potassium/etc.
- Log more meals for accurate tracking

## API

`GET /profile/nutrition-score` — returns today's nutrition score with full breakdown.

## Files

| File | Purpose |
|------|---------|
| `backend/app/services/nutrition/nutrition_score.py` | All scoring logic — single source of truth |
| `backend/app/routers/profile.py` | API endpoint |
