export function dailyWaterOz(weightLbs: number, workoutMinutes: number = 0, isHotDay: boolean = false): number {
  // Base: half bodyweight in oz
  let oz = weightLbs / 2;
  // Add 16oz per 30 min of exercise
  oz += (workoutMinutes / 30) * 16;
  // Hot day bonus
  if (isHotDay) oz += 16;
  return Math.round(oz);
}

export function dailyWaterLiters(weightLbs: number, workoutMinutes: number = 0): number {
  return Math.round(dailyWaterOz(weightLbs, workoutMinutes) * 0.0296 * 10) / 10;
}

export function formatWaterTarget(weightLbs: number, workoutMinutes: number = 0): string {
  const oz = dailyWaterOz(weightLbs, workoutMinutes);
  const L = dailyWaterLiters(weightLbs, workoutMinutes);
  const cups = Math.round(oz / 8);
  return `${oz}oz (${L}L / ~${cups} cups)`;
}
