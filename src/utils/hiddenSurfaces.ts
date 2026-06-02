import type { UserProfile } from '../types';

export type HomeTabKey = 'today' | 'friends' | 'workout' | 'meals' | 'progress' | 'you';

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
  return 'today';
}
