export function estimateCyclingPowerWatts({
  distanceMiles,
  durationSeconds,
  riderWeightLbs,
  elevationGainFt = 0,
  indoor = false,
}: {
  distanceMiles?: number | null;
  durationSeconds?: number | null;
  riderWeightLbs?: number | null;
  elevationGainFt?: number | null;
  indoor?: boolean;
}): number | null {
  const distance = Number(distanceMiles ?? 0);
  const duration = Number(durationSeconds ?? 0);
  const weightLbs = Number(riderWeightLbs ?? 0);
  const gainFt = Number(elevationGainFt ?? 0);
  if (!Number.isFinite(distance) || !Number.isFinite(duration) || !Number.isFinite(weightLbs)) return null;
  if (distance <= 0 || duration <= 0 || weightLbs <= 0) return null;

  const mph = distance / (duration / 3600);
  if (mph < 3 || mph > 45) return null;

  const distanceM = distance * 1609.344;
  const speedMps = distanceM / duration;
  const riderKg = weightLbs * 0.45359237;
  const bikeKg = indoor ? 10.0 : 12.0;
  const totalMassKg = riderKg + bikeKg;
  const gainM = Math.max(0, Number.isFinite(gainFt) ? gainFt * 0.3048 : 0);
  const grade = Math.min(0.18, gainM / Math.max(1, distanceM));

  const gravity = 9.80665;
  const rollingResistance = indoor ? 0.004 : 0.005;
  const airDensity = 1.225;
  const dragArea = indoor ? 0.30 : 0.40;
  const drivetrainEfficiency = 0.95;

  const rollingWatts = totalMassKg * gravity * rollingResistance * speedMps;
  const climbingWatts = totalMassKg * gravity * grade * speedMps;
  const aeroWatts = 0.5 * airDensity * dragArea * (speedMps ** 3);
  const watts = (rollingWatts + climbingWatts + aeroWatts) / drivetrainEfficiency;
  if (!Number.isFinite(watts) || watts < 25 || watts > 650) return null;
  return Math.round(watts);
}
