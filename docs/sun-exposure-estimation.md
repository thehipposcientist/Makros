# Sun Exposure Estimation

Thallo estimates passive sun context as wellness information. It does not claim exact sun exposure, exact vitamin D production, or certainty that the user was outside.

## What It Estimates

- One displayed daylight-minute value, anchored to Apple Health `Time in Daylight` when available.
- Apple light-intensity metadata in lux when HealthKit provides it.
- Average/max UV Index for the daylight window.
- Effective UV minutes for internal relative comparison and UV safety messaging.
- High-UV minutes when UV Index is at least 3.

## Client Sync Sources

Current client sync creates sun exposure segments from:

- Apple Health `Time in Daylight` samples, when Apple Watch records them and the user grants Health access.
- Foreground coarse-location checks, when sun exposure estimates and coarse location are enabled.

The backend also supports explicit workout-route segments when route plumbing sends them.

While the app is active, the client refreshes sun exposure about every 5 minutes. Coarse-location checks round coordinates before weather lookup and store only a coarse location bucket on the backend, not raw passive GPS. Current UV, cloud cover, precipitation, and day/night context come from a weather lookup; if weather is unavailable, the client falls back to conservative daylight/local-time assumptions and lower confidence.

When Apple Health daylight samples are imported, Thallo reads the sample value, start/end time, and Apple's maximum light-intensity metadata when present. When coarse location is enabled, the client also looks up hourly UV/cloud/precipitation for the sample window. For example, a 9:15-9:45 daylight interval gets UV from the overlapping 9:00-10:00 weather bucket. Existing HealthKit daylight segments that were previously saved with UV 0 or missing lux can be updated with this enriched context.

## What It Does Not Estimate

- Exact UV dose.
- Exact vitamin D production.
- Whether the user was certainly outside.
- Medical guidance or safe sun exposure.

## Formula

Effective UV minutes:

```text
durationMinutes
* uvIndexAverage
* outdoorConfidence
* skyExposureCoefficient
* reflectionCoefficient
```

Internal light-adjusted minutes:

```text
durationMinutes
* outdoorConfidence
* skyExposureCoefficient
* reflectionCoefficient
```

Effective UV minutes are UV-weighted and useful for safety/context. Light-adjusted minutes are kept internal; product copy should show one daylight-minute value, lux when available, and average/max UV.

Daily daylight score:

```text
daylight adequacy
+ local timing quality (morning, midday, afternoon)
+ Apple light-intensity metadata when available
+ low/moderate UV context
- sustained high-UV penalty
```

The score is a user-day pattern signal, not a raw UV dose. Morning daylight earns the strongest timing credit, midday still counts as useful daylight, and sustained high-UV windows can lower the score. Display color and primary status should follow the daylight score scale; the separate UV risk score/label is the dedicated caution metric.

## Area Coefficients

| Area type | Sky exposure | Reflection |
|---|---:|---:|
| indoor | 0.02 | 1.00 |
| vehicle | 0.10 | 1.00 |
| dense_forest | 0.20 | 1.00 |
| wooded_trail | 0.40 | 1.00 |
| park_mixed | 0.65 | 1.00 |
| open_grass | 0.95 | 1.00 |
| sports_field | 0.95 | 1.00 |
| beach | 1.00 | 1.15 |
| snow | 1.00 | 1.25 |
| water_edge | 0.95 | 1.10 |
| urban_street | 0.60 | 1.05 |
| unknown | 0.50 | 1.00 |

Unknown is intentionally partial sun, never full sun.

## Landcover And Canopy

`AreaSunCoefficientService` accepts already-derived area hints from OSM, landcover, tree canopy, building polygons, or manual corrections.

Tree canopy maps to sky exposure:

- `>=80%` tree cover: `0.15`
- `>=60%`: `0.25`
- `>=40%`: `0.40`
- `>=20%`: `0.65`
- otherwise: `0.90`

Building polygon hits classify as likely indoor. Generic forest/wood/trail context uses conservative partial-sun coefficients unless canopy data gives stronger evidence.

## Outdoor Confidence

`OutdoorConfidenceService` combines passive signals:

- HealthKit daylight data: high confidence.
- Workout route: high confidence.
- Outdoor workout type: medium/high confidence.
- Outdoor landcover plus movement: medium/high confidence.
- Building polygon: strong negative signal.
- Vehicle activity: low outdoor-sun confidence.
- Unknown coarse location: low/medium confidence.
- User correction: highest confidence.

## Privacy Model

Derived sun exposure records store:

- Coarse location/geohash.
- Area type and coefficient.
- Duration.
- UV average/max bucket.
- Apple Health maximum light-intensity lux when available.
- Outdoor confidence and source.

They do not store raw GPS for passive sun insights. Existing workout routes remain only where Thallo already stores routes with explicit workout permission. Sun summaries must not expose exact friend/social location and should not create insights around sensitive places.

`DELETE /sun-exposure/derived-data` removes derived sun exposure segments and corrections. Full account deletion also removes these rows.

## Correction Flow

Correction options:

- Mostly sunny.
- Mixed.
- Mostly shaded.
- I was indoors.
- This activity is wrong.
- Dismiss.

Prompts should be occasional:

- Confidence is low and UV Index is at least 3.
- A high-UV estimate materially affects the daily summary.
- The user opens the summary and taps adjust.
- A new unknown area type appears repeatedly.

Corrections tune future similar contexts by coarse hash and area type. “Mostly shaded” lowers the sky coefficient. “I was indoors” prevents outdoor sun logging for that segment.

## UV Safety Copy

If UV Index is at least 3, show:

```text
Sun protection would be recommended if you were outside.
```

Keep all product copy in estimated language: “estimated,” “likely,” “daylight,” “light intensity,” and “UV Index.” Do not present light-adjusted minutes as user-facing time.

## Tuning

Tune coefficients conservatively. Raise coefficients only when stronger local evidence exists, such as open sports fields or beach/water/snow context. Lower coefficients when user corrections repeatedly indicate shade or indoor context. Avoid tuning that makes unknown context full sun.
