import { PRIMARY_GOALS } from '../../constants/goalConfig.ts';
import { goalEquipmentWarnings } from '../goalEquipmentGuardrails.ts';

function hasWarning(goal: string, equipment: string[], text: string): boolean {
  return goalEquipmentWarnings(goal, equipment).some(warning => warning.includes(text));
}

describe('goal equipment guardrails', () => {
  describe('strength and muscle goals', () => {
    it('warns when build_strength has only cardio equipment', () => {
      expect(hasWarning('build_strength', ['Stationary bike'], 'progressive resistance')).toBe(true);
    });

    it('does not warn for build_strength with dumbbells', () => {
      expect(goalEquipmentWarnings('build_strength', ['Dumbbells', 'Adjustable bench']).length).toBe(0);
    });

    it('requires a complete barbell setup for powerlifting', () => {
      expect(hasWarning('powerlifting', ['Flat bench'], 'barbell-specific')).toBe(true);
      expect(goalEquipmentWarnings('powerlifting', ['Barbell', 'Weight plates', 'Power rack', 'Flat bench']).length).toBe(0);
    });

    it('catches body-part focus mismatches', () => {
      expect(hasWarning('build_glutes', ['Pull-up bar'], 'lower-body resistance')).toBe(true);
      expect(hasWarning('build_upper_body', ['Leg press'], 'upper-body focus')).toBe(true);
      expect(hasWarning('build_glutes', ['Dumbbells'], 'lower-body resistance')).toBe(false);
    });
  });

  describe('cardio and athletic goals', () => {
    it('allows a stationary bike for general cardio and cycling goals', () => {
      expect(goalEquipmentWarnings('improve_cardio', ['Stationary bike']).length).toBe(0);
      expect(goalEquipmentWarnings('cycling_endurance', ['Stationary bike']).length).toBe(0);
    });

    it('warns when running goals only have a stationary bike', () => {
      expect(hasWarning('train_5k', ['Stationary bike'], 'Running goals need running exposure')).toBe(true);
      expect(goalEquipmentWarnings('train_5k', ['Bodyweight / no equipment']).length).toBe(0);
    });

    it('warns for HYROX without running or resistance access', () => {
      const warnings = goalEquipmentWarnings('hyrox', ['Stationary bike']);
      expect(warnings.some(w => w.includes('Hybrid performance'))).toBe(true);
      expect(warnings.some(w => w.includes('HYROX-style goals include running'))).toBe(true);
      expect(goalEquipmentWarnings('hyrox', ['Treadmill', 'Rowing machine', 'Sled', 'Dumbbells']).length).toBe(0);
    });
  });

  describe('health goals', () => {
    it('requires repeatable cardio for heart health', () => {
      expect(hasWarning('heart_health', ['Dumbbells'], 'Heart-health goals')).toBe(true);
      expect(goalEquipmentWarnings('heart_health', ['Stationary bike']).length).toBe(0);
    });

    it('requires weight-bearing or resistance work for bone health', () => {
      expect(hasWarning('bone_health', ['Stationary bike'], 'Bone-health goals')).toBe(true);
      expect(goalEquipmentWarnings('bone_health', ['Bodyweight / no equipment']).length).toBe(0);
    });
  });

  describe('catalog safety', () => {
    it('returns only unique warning strings', () => {
      for (const goal of ['powerlifting', 'hyrox', 'metabolic_health', 'build_glutes']) {
        const warnings = goalEquipmentWarnings(goal, ['Stationary bike']);
        expect(warnings.length).toBe(new Set(warnings).size);
      }
    });

    it('handles every frontend primary goal without invalid warning values', () => {
      for (const goal of PRIMARY_GOALS) {
        const warnings = goalEquipmentWarnings(goal.id, ['Stationary bike']);
        expect(Array.isArray(warnings)).toBe(true);
        expect(warnings.every(warning => typeof warning === 'string' && warning.length > 0)).toBe(true);
      }
    });
  });
});
