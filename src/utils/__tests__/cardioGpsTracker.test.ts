import { activityFromFocus, estimateRouteElevationGainFt } from '../cardioGpsTracker.ts';
import { estimateCyclingPowerWatts } from '../cyclingPower.ts';

describe('cardioGpsTracker', () => {
  describe('activityFromFocus', () => {
    it('keeps indoor cycling from starting GPS', () => {
      expect(activityFromFocus('Stationary Bike')).toBe('unknown');
      expect(activityFromFocus('Spin Class')).toBe('unknown');
    });

    it('keeps strength movements with walking words from starting GPS', () => {
      expect(activityFromFocus('Walking Lunges')).toBe('unknown');
      expect(activityFromFocus("Farmer's Walk")).toBe('unknown');
      expect(activityFromFocus('Lateral Band Walks')).toBe('unknown');
      expect(activityFromFocus('Inchworm Walkouts')).toBe('unknown');
    });

    it('recognizes outdoor walk and run labels', () => {
      expect(activityFromFocus('Outdoor Walk')).toBe('walking');
      expect(activityFromFocus('Brisk Walking')).toBe('walking');
      expect(activityFromFocus('Outdoor Run')).toBe('running');
      expect(activityFromFocus('Treadmill Run')).toBe('unknown');
    });

    it('recognizes outdoor ride labels', () => {
      expect(activityFromFocus('Outdoor Cycling')).toBe('cycling');
      expect(activityFromFocus('Bike Ride')).toBe('cycling');
    });
  });

  describe('estimateRouteElevationGainFt', () => {
    it('sums meaningful climbs and ignores descents', () => {
      const gain = estimateRouteElevationGainFt([
        { lat: 1, lon: 1, t_ms: 1, alt_m: 100, v_acc_m: 5 },
        { lat: 1, lon: 1, t_ms: 2, alt_m: 105, v_acc_m: 5 },
        { lat: 1, lon: 1, t_ms: 3, alt_m: 103, v_acc_m: 5 },
        { lat: 1, lon: 1, t_ms: 4, alt_m: 110, v_acc_m: 5 },
      ]);
      expect(gain).toBe(39);
    });

    it('drops noisy altitude samples', () => {
      const gain = estimateRouteElevationGainFt([
        { lat: 1, lon: 1, t_ms: 1, alt_m: 100, v_acc_m: 5 },
        { lat: 1, lon: 1, t_ms: 2, alt_m: 140, v_acc_m: 80 },
        { lat: 1, lon: 1, t_ms: 3, alt_m: 102, v_acc_m: 5 },
      ]);
      expect(gain).toBe(7);
    });
  });

  describe('estimateCyclingPowerWatts', () => {
    it('estimates plausible outdoor cycling power from distance duration and elevation', () => {
      const watts = estimateCyclingPowerWatts({
        distanceMiles: 20,
        durationSeconds: 3600,
        riderWeightLbs: 175,
        elevationGainFt: 900,
      });
      expect(watts).toBeGreaterThan(179);
      if (watts == null || watts > 360) throw new Error(`expected ${watts} to be <= 360`);
    });

    it('rejects unrealistic ride speeds', () => {
      expect(estimateCyclingPowerWatts({
        distanceMiles: 60,
        durationSeconds: 3600,
        riderWeightLbs: 175,
        elevationGainFt: 100,
      })).toBe(null);
    });
  });
});
