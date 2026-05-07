import type { UserProfile } from '../types';

export type HomeTabKey = 'friends' | 'workout' | 'meals' | 'progress' | 'you';

export function shouldShowWorkouts(profile: Pick<UserProfile, 'hiddenSurfaces'> | null | undefined): boolean {
  return profile?.hiddenSurfaces?.workouts !== true;
}

export function shouldShowMeals(profile: Pick<UserProfile, 'hiddenSurfaces'> | null | undefined): boolean {
  return profile?.hiddenSurfaces?.meals !== true;
}

export function isHomeTabVisible(tab: HomeTabKey, profile: Pick<UserProfile, 'hiddenSurfaces'> | null | undefined): boolean {
  if (tab === 'workout') return shouldShowWorkouts(profile);
  if (tab === 'meals') return shouldShowMeals(profile);
  return true;
}

export function fallbackHomeTab(profile: Pick<UserProfile, 'hiddenSurfaces'> | null | undefined): HomeTabKey {
  if (shouldShowWorkouts(profile)) return 'workout';
  if (shouldShowMeals(profile)) return 'meals';
  return 'progress';
}
