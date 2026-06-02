# Thallo Privacy Policy Draft

Last updated: 2026-05-31

Status: founder/legal review required before public launch. This draft is written to match the current app and server behavior and to provide source copy for a hosted public privacy policy URL.

## Overview

Thallo is a fitness and nutrition planning app. We collect information needed to create plans, track workouts and meals, support optional connected health data, power optional AI features, process subscriptions, provide social workout sharing, secure accounts, and improve reliability.

Thallo is not medical care, is not an emergency service, and does not diagnose, treat, monitor, cure, or prevent disease.

## Information We Collect

- Account data: email, username, name, password hash, sign-in provider IDs, email verification and password reset state, account status, legal acceptance versions, IP address, user agent, and timestamps.
- Profile and planning data: birthday or age, height, weight, goals, pace, schedule, equipment, injuries, allergies, dietary preferences, pregnancy/support flags when provided, GLP-1 support settings, and onboarding preferences.
- Workout and activity data: plan weeks, plan days, exercises, sets, reps, weights, RPE/RIR, workout completions, templates, custom exercises, imported activities, cardio distance, pace, elevation, heart-rate summaries, and route coordinates when captured.
- Nutrition data: meals, meal items, saved meals, custom foods, routines, macro targets, meal scores, food searches/selections, hydration, grocery/recipe context, and imports from files or connected services.
- Connected health data: optional Apple Health or future Health Connect categories you allow, including sleep, heart rate, HRV, steps, workouts/routes, body weight, active/basal energy, VO2 max, respiratory rate, blood oxygen, sleeping wrist temperature, sleep-breathing disturbances, standing hours, mindful minutes, time in daylight, menstrual-flow signals, and nutrition summaries. Raw samples are read on device; daily or nightly summaries may sync to your account.
- Photos, audio, and documents: optional food, supplement, equipment, form, body, lab report, social, and gear photos or videos; optional speech-to-meal audio and transcripts; optional lab report PDFs or extracted text; optional import files.
- Lab and sensitive health data: reviewed lab marker values, units, dates, reference ranges, and sources after user review. Thallo is designed not to retain raw lab report files as report files after extraction.
- Supplement and gear data: supplement stack, dose logs, scanned supplement facts, gear photos, gear usage, mileage, and retirement estimates.
- Location and route data: active outdoor cardio location, route, distance, pace, and elevation; optional coarse location signals for sun exposure estimates. Thallo does not use continuous location tracking outside features you start or enable.
- Social data: social profile, friend requests, friendships, blocked users, workout-only feed posts, captions, photos, likes, comments, notifications, and reports.
- Purchases and subscriptions: trial state, entitlement identifiers, product identifiers, subscription status, app store, environment, renewal/expiration timestamps, and RevenueCat webhook/sync metadata when billing is enabled.
- Telemetry and diagnostics: app version, platform, product interaction events, HealthKit permission results, API errors, timeouts, JS error messages/stacks, and anonymous or user-linked diagnostic events.

## How We Use Information

We use information to authenticate users, generate and display deterministic workout plans, personalize nutrition and recovery recommendations, score meals, sync data across devices, import/export account data, provide optional AI features, write completed workouts to Apple Health when enabled, run friends-only workout sharing, process subscriptions, provide support, detect abuse or fraud, debug crashes and API errors, and comply with legal obligations.

We do not sell personal data to advertisers, use HealthKit data for advertising, or use user data for third-party ad tracking.

## AI Processing

Thallo uses OpenAI API features for meal parsing, coach chat, scans, classification, lab report extraction, workout feedback, and related features. Prompts may include only the context needed for the selected feature, such as workout, nutrition, macro, recovery, supplement, connected health summary, lab marker, image, audio, transcript, PDF text, or photo-derived context.

Direct account identifiers such as name and email are not required for AI features and are stripped from server-generated coach check-in payloads. AI output can be wrong. Review foods, equipment, form cues, supplement details, body estimates, lab values, units, dates, and reference ranges before saving or acting on them.

## Third-Party Services

Thallo may share limited data with vendors needed to operate the app:

- OpenAI for AI processing.
- USDA FoodData Central, Open Food Facts, wger, and configured restaurant or branded-food providers for nutrition and exercise lookups.
- Apple Health / HealthKit and future Health Connect only when you grant permission. Apple Health receives completed workout writes when enabled.
- Apple and Google sign-in providers when you choose those login methods.
- RevenueCat and app stores for purchases, trials, subscriptions, restore purchases, and entitlement sync when billing is enabled.
- Hosting, database, email, security, and support providers needed to run the service.
- Legal, safety, fraud-prevention, or law-enforcement recipients when required or appropriate.

Vendor records may follow vendor retention terms. OpenAI states that API data is not used to train models by default unless the API customer opts in, and default abuse-monitoring logs may be retained for up to 30 days unless longer retention is required or otherwise allowed by policy.

## Social Boundary

Social sharing is optional and friends-only. When sharing is enabled, friends may see workout-only activity such as completed sessions, focus, duration, exercises, sets, reps, load, cardio time, distance, pace, streaks, captions, comments, and photos you choose to post.

Calories, macros, meals, weight, body measurements, body photos, route coordinates, lab data, cycle data, recovery flags, private notes, and account data do not cross the social boundary. Users can delete their own posts and comments, block users, and report abuse.

## Retention, Export, And Deletion

You can export account data and delete your account from Settings. When deletion is requested, Thallo deletes app-created profile, plan, workout, meal, weight, health-summary, lab, supplement, social, telemetry, legal-event, and settings rows, disables login, and anonymizes account identifiers. An anonymized account shell may remain for up to 30 days before hard deletion for deletion safety and database integrity.

Backups, server logs, vendor records, aggregate non-identifying analytics, and records needed for security, billing, fraud prevention, legal compliance, or moderation may follow separate retention schedules.

## Choices

You can manage device permissions in iOS or Android settings, disconnect Apple Health or Health Connect categories, turn off social sharing, delete posts and comments, export data, and request account deletion. You can contact support about privacy, deletion, or account data at thallosupport@gmail.com.

## Children

Thallo is not intended for users under 13. Users under the age of majority where they live should use Thallo only with parent or guardian permission. If we learn that an account belongs to a user under 13, we may delete the account and related data.

## Security And Breach Notice

Thallo uses reasonable technical and organizational safeguards for account and health data. No system is perfectly secure. If a security incident requires notice, Thallo will provide notices required by applicable law.

## Public Launch TODO

- Add the legal entity/operator name and mailing address if required.
- Host this policy at a stable public URL before App Store submission.
- Confirm backup, server log, AI vendor, RevenueCat, and email-provider retention with counsel.
- Confirm state, country, age, consumer-health-data, and health-breach notification obligations with counsel.
