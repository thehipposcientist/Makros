/**
 * Static require() map of bundled equipment preview images, keyed by
 * `Equipment.slug` from the backend seed (`SEED_EQUIPMENT` in
 * `backend/app/seed_exercises_data.py`).
 *
 * React Native's Metro bundler can't resolve `require(dynamicPath)`,
 * so every slug→asset has to be listed explicitly here. New equipment
 * additions: drop the PNG into `assets/images/equipment/{slug}.png`
 * and add a line to this map (or `_alt_N` for additional shots).
 *
 * `getEquipmentImageSource` is the only thing consumers should call —
 * it falls back to `null` for unknown slugs so callers can decide
 * whether to show a placeholder or external-search button.
 */

const EQUIPMENT_IMAGE_MAP: Record<string, number> = {
  ab_crunch_machine: require('../../assets/images/equipment/ab_crunch_machine.png'),
  ab_wheel: require('../../assets/images/equipment/ab_wheel.png'),
  adjustable_bench: require('../../assets/images/equipment/adjustable_bench.png'),
  adjustable_dumbbells: require('../../assets/images/equipment/adjustable_dumbbells.png'),
  assault_bike: require('../../assets/images/equipment/assault_bike.png'),
  assisted_pullup_machine: require('../../assets/images/equipment/assisted_pullup_machine.png'),
  barbell: require('../../assets/images/equipment/barbell.png'),
  battle_ropes: require('../../assets/images/equipment/battle_ropes.png'),
  belt_squat_machine: require('../../assets/images/equipment/belt_squat_machine.png'),
  cable_ankle_strap: require('../../assets/images/equipment/cable_ankle_strap.png'),
  cable_d_handle_attachment: require('../../assets/images/equipment/cable_d_handle_attachment.png'),
  cable_machine: require('../../assets/images/equipment/cable_machine.png'),
  single_cable_station: require('../../assets/images/equipment/cable_machine.png'),
  dual_cable_station: require('../../assets/images/equipment/cable_machine.png'),
  cable_rope_attachment: require('../../assets/images/equipment/cable_rope_attachment.png'),
  cable_straight_bar_attachment: require('../../assets/images/equipment/cable_straight_bar_attachment.png'),
  cable_v_bar_attachment: require('../../assets/images/equipment/cable_v_bar_attachment.png'),
  captain_chair: require('../../assets/images/equipment/captain_chair.png'),
  chest_press_machine: require('../../assets/images/equipment/chest_press_machine.png'),
  decline_bench: require('../../assets/images/equipment/decline_bench.png'),
  dip_bars: require('../../assets/images/equipment/dip_bars.png'),
  dumbbells: require('../../assets/images/equipment/dumbbells.png'),
  elliptical: require('../../assets/images/equipment/elliptical.png'),
  ez_curl_bar: require('../../assets/images/equipment/ez_curl_bar.png'),
  flat_bench: require('../../assets/images/equipment/flat_bench.png'),
  foam_roller: require('../../assets/images/equipment/foam_roller.png'),
  ghd: require('../../assets/images/equipment/ghd.png'),
  hack_squat_machine: require('../../assets/images/equipment/hack_squat_machine.png'),
  heavy_bag: require('../../assets/images/equipment/heavy_bag.png'),
  hip_abduction_machine: require('../../assets/images/equipment/hip_abduction_machine.png'),
  hip_adduction_machine: require('../../assets/images/equipment/hip_adduction_machine.png'),
  hyperextension_bench: require('../../assets/images/equipment/hyperextension_bench.png'),
  incline_bench: require('../../assets/images/equipment/incline_bench.png'),
  jump_rope: require('../../assets/images/equipment/jump_rope.png'),
  kettlebell: require('../../assets/images/equipment/kettlebell.png'),
  landmine_attachment: require('../../assets/images/equipment/landmine_attachment.png'),
  lat_pulldown_machine: require('../../assets/images/equipment/lat_pulldown_machine.png'),
  lateral_raise_machine: require('../../assets/images/equipment/lateral_raise_machine.png'),
  leg_curl_machine: require('../../assets/images/equipment/leg_curl_machine.png'),
  leg_extension_machine: require('../../assets/images/equipment/leg_extension_machine.png'),
  leg_press_machine: require('../../assets/images/equipment/leg_press_machine.png'),
  leverage_shoulder_press_machine: require('../../assets/images/equipment/leverage_shoulder_press_machine.png'),
  medicine_ball: require('../../assets/images/equipment/medicine_ball.png'),
  mini_band: require('../../assets/images/equipment/mini_band.png'),
  nordic_anchor: require('../../assets/images/equipment/nordic_anchor.png'),
  outdoor_bike: require('../../assets/images/equipment/outdoor_bike.png'),
  pec_deck_machine: require('../../assets/images/equipment/pec_deck_machine.png'),
  plate_loaded_chest_press_machine: require('../../assets/images/equipment/plate_loaded_chest_press_machine.png'),
  plate_loaded_row_machine: require('../../assets/images/equipment/plate_loaded_row_machine.png'),
  power_rack: require('../../assets/images/equipment/power_rack.png'),
  preacher_bench: require('../../assets/images/equipment/preacher_bench.png'),
  preacher_curl_machine: require('../../assets/images/equipment/preacher_curl_machine.png'),
  pull_up_bar: require('../../assets/images/equipment/pull_up_bar.png'),
  pullover_machine: require('../../assets/images/equipment/pullover_machine.png'),
  resistance_bands: require('../../assets/images/equipment/resistance_bands.png'),
  rotary_torso_machine: require('../../assets/images/equipment/rotary_torso_machine.png'),
  rowing_machine: require('../../assets/images/equipment/rowing_machine.png'),
  ruck_pack: require('../../assets/images/equipment/ruck_pack.png'),
  seated_calf_raise_machine: require('../../assets/images/equipment/seated_calf_raise_machine.png'),
  shoulder_press_machine: require('../../assets/images/equipment/shoulder_press_machine.png'),
  skierg: require('../../assets/images/equipment/skierg.png'),
  slant_board: require('../../assets/images/equipment/slant_board.png'),
  slider_discs: require('../../assets/images/equipment/slider_discs.png'),
  smith_machine: require('../../assets/images/equipment/smith_machine.png'),
  squat_rack: require('../../assets/images/equipment/squat_rack.png'),
  stair_climber: require('../../assets/images/equipment/stair_climber.png'),
  standing_calf_raise_machine: require('../../assets/images/equipment/standing_calf_raise_machine.png'),
  stationary_bike: require('../../assets/images/equipment/stationary_bike.png'),
  sturdy_chair: require('../../assets/images/equipment/sturdy_chair.png'),
  suspension_trainer: require('../../assets/images/equipment/suspension_trainer.png'),
  swimming_pool: require('../../assets/images/equipment/swimming_pool.png'),
  swiss_ball: require('../../assets/images/equipment/swiss_ball.png'),
  tibialis_raise_machine: require('../../assets/images/equipment/tibialis_raise_machine.png'),
  trap_bar: require('../../assets/images/equipment/trap_bar.png'),
  treadmill: require('../../assets/images/equipment/treadmill.png'),
  v_squat_machine: require('../../assets/images/equipment/v_squat_machine.png'),
  versaclimber: require('../../assets/images/equipment/versaclimber.png'),
  weight_plates: require('../../assets/images/equipment/weight_plates.png'),
  wrist_roller: require('../../assets/images/equipment/wrist_roller.png'),
  yoga_mat: require('../../assets/images/equipment/yoga_mat.png'),
};

// DB slug → image-file slug aliases for cases where the seed slug and
// the bundled filename diverge. Cable attachments in `SEED_EQUIPMENT`
// use bare slugs (`rope_attachment`) but the curated files are prefixed
// (`cable_rope_attachment.png`). Same story for the plate-loaded row.
// Add a line here when a new slug doesn't match its file.
const SLUG_ALIASES: Record<string, string> = {
  rope_attachment: 'cable_rope_attachment',
  straight_bar_attachment: 'cable_straight_bar_attachment',
  d_handle: 'cable_d_handle_attachment',
  v_bar_attachment: 'cable_v_bar_attachment',
  ankle_strap: 'cable_ankle_strap',
  machine_row_station: 'plate_loaded_row_machine',
};

function resolveSlug(slug: string): string {
  return SLUG_ALIASES[slug] ?? slug;
}

export function getEquipmentImageSource(slug: string | undefined | null): number | null {
  if (!slug) return null;
  return EQUIPMENT_IMAGE_MAP[resolveSlug(slug)] ?? null;
}

export function hasEquipmentImage(slug: string | undefined | null): boolean {
  return slug != null && resolveSlug(slug) in EQUIPMENT_IMAGE_MAP;
}
