/**
 * Exercise guide — generates detailed exercise breakdowns including
 * movement phases, setup cues, and common mistakes.
 * Shared between HomeScreen and EditProfileScreen exercise libraries.
 */

export interface ExerciseLibraryItem {
  id?: number;
  name: string;
  slug?: string | null;
  description?: string | null;
  primary_muscle?: string;
  secondary_muscles?: string[];
  equipment?: string;
  gear?: Array<{ slug?: string | null; name?: string | null; category?: string | null; required?: boolean | null; role?: string | null }> | null;
  aliases?: string[] | null;
  is_compound?: boolean;
  exercise_type?: string | null;
  movement_pattern?: string | null;
  cardio_intensity?: string | null;
  /** Legacy demo identifier. Resolved server-side at seed time and retained
   *  so older payloads can still match bundled Move Kit videos. */
  demo_exercise_db_id?: string | null;
}

export interface ExerciseGuide {
  howTo: string;
  hits: string;
  why: string;
  setup: string;
  movement: string;
  feel: string;
  mistake: string;
  concentric: string;
  eccentric: string;
  phaseTitle: string;
  primaryPhaseLabel: string;
  secondaryPhaseLabel: string;
}

/** Turn an identifier string into a human-readable label.
 *
 * Handles four input shapes the backend and seed data mix freely:
 *   - snake_case:    "horizontal_press"  → "Horizontal Press"
 *   - kebab-case:    "cool-down"         → "Cool Down"
 *   - camelCase:     "lastSessionBest"   → "Last Session Best"
 *   - PascalCase:    "UpperBody"         → "Upper Body"
 *
 * Also collapses multi-letter acronyms ("RPE", "1RM") so they stay
 * intact instead of splitting into "R P E". Safe on already-humanized
 * strings — "Barbell Bench Press" passes through unchanged.
 */
export function humanizeToken(s?: string | null): string {
  if (!s) return '';
  // 1. Break snake_ and kebab-case into words.
  let out = s.replace(/[_\-]+/g, ' ');
  // 2. Split camelCase / PascalCase: insert a space before every
  //    lowercase→uppercase boundary ("lastBest" → "last Best") AND
  //    before an uppercase followed by lowercase that itself follows
  //    another uppercase ("HTTPServer" → "HTTP Server").
  out = out
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  // 3. Collapse runs of whitespace, trim, title-case each word.
  return out
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

type MovementPattern =
  | 'curl' | 'extension_elbow' | 'press_horizontal' | 'press_vertical'
  | 'fly' | 'row' | 'pulldown' | 'raise' | 'squat' | 'hinge'
  | 'lunge' | 'hip_thrust' | 'calf_raise' | 'plank' | 'crunch' | 'generic';

function detectMovementPattern(name: string, _primary: string): MovementPattern {
  const n = name.toLowerCase();
  if (/(curl|bicep curl|hammer curl|preacher)/.test(n)) return 'curl';
  if (/(tricep|skull crusher|pushdown|kickback|overhead extension)/.test(n) && /(extend|press)/.test(n)) return 'extension_elbow';
  if (/pushdown|tricep extension|skull crusher|kickback/.test(n)) return 'extension_elbow';
  if (/(bench press|chest press|push.?up|dip|pec dec)/.test(n) && !/(overhead|shoulder)/.test(n)) return 'press_horizontal';
  if (/(fly|pec|cable cross)/.test(n)) return 'fly';
  if (/(overhead press|shoulder press|military|arnold|lateral raise|front raise|upright row)/.test(n)) {
    if (/raise/.test(n)) return 'raise';
    return 'press_vertical';
  }
  if (/(lateral raise|front raise|rear delt|face pull)/.test(n)) return 'raise';
  if (/(row|pull.?up|chin.?up|lat pull)/.test(n)) {
    if (/pulldown|lat pull/.test(n)) return 'pulldown';
    return 'row';
  }
  if (/(squat|goblet|hack squat|leg press)/.test(n)) return 'squat';
  if (/(deadlift|rdl|romanian|good morning|hip hinge)/.test(n)) return 'hinge';
  if (/lunge/.test(n)) return 'lunge';
  if (/(hip thrust|glute bridge)/.test(n)) return 'hip_thrust';
  if (/(calf raise|standing calf|seated calf)/.test(n)) return 'calf_raise';
  if (/(plank|hollow|l.sit)/.test(n)) return 'plank';
  if (/(crunch|sit.?up|ab|cable crunch)/.test(n)) return 'crunch';
  return 'generic';
}

function isCardioExercise(ex: ExerciseLibraryItem): boolean {
  const name = ex.name.toLowerCase();
  return (
    String(ex.exercise_type ?? '').toLowerCase() === 'cardio'
    || String(ex.movement_pattern ?? '').toLowerCase() === 'cardio'
    || String(ex.primary_muscle ?? '').toLowerCase() === 'cardio'
    || /sprint|interval|zone ?2|treadmill|bike|cycling|rowing|rower|skierg|elliptical|stair climber|walk|jog|run|jump rope|boxing|kickboxing|martial.?arts|mma|burpee|mountain climber|jumping jack|high knees|butt kick|fast feet|plank jack|squat thrust|skater|line hop|battle rope|shuffle|shadow boxing|cardio/.test(name)
  );
}

function buildCardioExerciseGuide(ex: ExerciseLibraryItem): ExerciseGuide {
  const name = ex.name.toLowerCase();
  const secondary = (ex.secondary_muscles ?? []).map(humanizeToken).filter(Boolean);
  const supportText = secondary.length ? ` Secondary demand: ${joinParts(secondary).toLowerCase()}.` : '';
  const has = (pattern: RegExp) => pattern.test(name);
  const isIntervals = has(/interval|sprint|hiit|tabata|burpee|jump rope|jumping jack|high knees|butt kicks|fast feet|plank jack|squat thrust|skater|line hop|shadow boxing|boxing|kickboxing|martial.?arts|mma|battle rope|shuttle|shuffle/);
  const phaseTitle = isIntervals ? 'Interval Breakdown' : 'Cardio Execution';

  if (has(/sprint|hill sprint|shuttle/)) {
    return {
      howTo: 'Use this as a sprint repeat, not a lifting exercise. Mark roughly 30-40 yards of clear space, sprint hard, then walk back or rest until the next repeat.',
      hits: `Primarily trains acceleration, top-speed mechanics, and high-output conditioning.${supportText}`,
      why: 'Short sprints build power, speed, and anaerobic capacity without turning the session into a long endurance run. Full recovery keeps each rep fast and crisp.',
      setup: 'Use a track, turf lane, quiet field, or hill with room to slow down. Warm up first, mark a start and finish, and leave extra space past the finish for deceleration.',
      movement: 'Start tall with a slight forward lean. Drive arms cheek-to-hip, push the ground back, accelerate smoothly, and stay relaxed through the face, hands, and shoulders.',
      feel: 'Each sprint should feel fast and powerful, with breathing high by the end but mechanics still clean. Stop a rep early if you are stumbling or tightening up.',
      mistake: 'Starting cold or sprinting in a cramped space. Sprint intervals need a warm-up, clear runway, and enough recovery to keep speed high.',
      concentric: 'Sprint the marked distance hard. Build speed over the first few steps, drive the knees and arms, and run through the finish instead of easing up before it.',
      eccentric: 'Walk back slowly or rest in place until breathing comes down enough for another quality sprint. Recovery is part of the prescription, not wasted time.',
      phaseTitle,
      primaryPhaseLabel: 'SPRINT',
      secondaryPhaseLabel: 'RECOVER',
    };
  }

  if (has(/bike|cycling|assault bike/)) {
    return {
      howTo: isIntervals
        ? 'Set the bike so you can pedal fast without bouncing. Alternate hard efforts with easy pedaling exactly as prescribed.'
        : 'Ride at a steady conversational pace. Keep cadence smooth and adjust resistance so effort stays aerobic instead of turning into leg strength work.',
      hits: `Primarily trains the cardiovascular system with leg support from quads and calves.${supportText}`,
      why: isIntervals
        ? 'Bike intervals let you push heart rate high with low joint impact and very controlled pacing.'
        : 'Steady cycling builds aerobic capacity with low impact, making it useful for conditioning, recovery support, and weekly Zone 2 volume.',
      setup: 'Set saddle height so the knee stays slightly bent at the bottom of the pedal stroke. Keep the torso quiet and hands light on the bars.',
      movement: 'Pedal in smooth circles. For hard intervals, increase cadence and resistance together; for easy work, back off enough that breathing settles.',
      feel: isIntervals
        ? 'Hard rounds should burn in the legs and lungs, then noticeably settle during the easy spin.'
        : 'You should be able to speak in short sentences. If you are gasping, lower resistance or cadence.',
      mistake: 'Cranking resistance so high that cadence crawls. This changes cardio into a grindy leg-strength effort.',
      concentric: isIntervals
        ? 'During the hard interval, ramp cadence quickly and hold a strong but repeatable pace until the timer ends.'
        : 'Find a smooth cadence you can hold. Keep breathing rhythmic and effort steady rather than surging.',
      eccentric: isIntervals
        ? 'During recovery, keep the pedals moving very easy. Let breathing drop before the next push.'
        : 'Use small resistance or cadence adjustments to stay in the intended zone as fatigue builds.',
      phaseTitle,
      primaryPhaseLabel: isIntervals ? 'HARD' : 'PACE',
      secondaryPhaseLabel: isIntervals ? 'EASY' : 'CONTROL',
    };
  }

  if (has(/row|rowing|skierg/)) {
    const ski = has(/skierg|ski erg/);
    return {
      howTo: isIntervals
        ? `Use ${ski ? 'the SkiErg' : 'the rower'} for timed hard repeats with easy recovery between rounds.`
        : `Use ${ski ? 'the SkiErg' : 'the rower'} at a steady pace you can repeat without form falling apart.`,
      hits: `Primarily trains cardio with ${ski ? 'lats, shoulders, and core' : 'legs, back, and core'} contributing each stroke.${supportText}`,
      why: `${ski ? 'SkiErg' : 'Rowing'} work gives a measurable cardio stimulus while involving more total body mass than most machines.`,
      setup: ski
        ? 'Stand tall with handles above eye level, ribs down, and feet planted. Start each pull from the lats, not by yanking with the arms.'
        : 'Strap feet in, sit tall, and start with shins near vertical. Sequence each stroke as legs, hips, arms, then arms, hips, legs on the return.',
      movement: ski
        ? 'Snap the handles down by crunching the ribs toward the hips, then let the arms recover smoothly overhead.'
        : 'Drive with the legs first, swing the torso slightly open, then finish with the arms. Recover in the reverse order and keep strokes smooth.',
      feel: isIntervals ? 'Hard rounds should spike breathing without your stroke getting sloppy.' : 'Breathing should be steady and stroke rhythm repeatable.',
      mistake: ski ? 'Turning it into an arm-only pull. Use torso and lats.' : 'Yanking with the arms before the legs drive. That wastes power and irritates the low back.',
      concentric: isIntervals ? 'Push the hard stroke rate or pace for the work interval while keeping technique sharp.' : 'Settle into a repeatable stroke rhythm and keep the monitor pace steady.',
      eccentric: isIntervals ? 'Use the easy interval to slow the stroke rate, breathe, and reset technique.' : 'Relax the recovery phase of each stroke so the next drive starts controlled.',
      phaseTitle,
      primaryPhaseLabel: isIntervals ? 'WORK' : 'PACE',
      secondaryPhaseLabel: isIntervals ? 'RESET' : 'RHYTHM',
    };
  }

  if (has(/walk|jog|run|treadmill|incline|outdoor/)) {
    return {
      howTo: isIntervals ? 'Alternate fast running efforts with easy walking or jogging recovery.' : 'Move continuously at the prescribed easy or Zone 2 pace.',
      hits: `Primarily trains aerobic conditioning through the legs and cardiovascular system.${supportText}`,
      why: isIntervals
        ? 'Run intervals build speed and conditioning with clear work and recovery blocks.'
        : 'Walking, jogging, and steady running build aerobic base without needing complex setup.',
      setup: 'Choose a safe route or treadmill setting. For outdoor work, pick a surface where you can keep rhythm without dodging traffic or obstacles.',
      movement: 'Keep posture tall, arms relaxed, and stride quiet. Let pace come from rhythm, not overstriding.',
      feel: isIntervals ? 'Fast portions should feel challenging but controlled; easy portions should clearly lower breathing.' : 'For Zone 2, you should be able to hold a broken conversation.',
      mistake: isIntervals ? 'Turning every recovery into another hard rep. Go easy enough to make the next interval good.' : 'Letting easy cardio drift into a tempo run. If conversation disappears, slow down.',
      concentric: isIntervals ? 'Run the hard segment at the prescribed pace or effort while keeping stride mechanics smooth.' : 'Hold the target pace, incline, or heart-rate zone steadily.',
      eccentric: isIntervals ? 'Walk or jog easy until the next rep. Use the recovery to bring breathing and posture back under control.' : 'Adjust pace or incline down when breathing climbs above the target zone.',
      phaseTitle,
      primaryPhaseLabel: isIntervals ? 'FAST' : 'PACE',
      secondaryPhaseLabel: isIntervals ? 'EASY' : 'ADJUST',
    };
  }

  if (has(/burpee/)) {
    return {
      howTo: 'Perform full-body conditioning reps: stand tall, squat down, place hands on the floor, jump or step your feet back to a strong plank, return feet under you, then stand or jump.',
      hits: `Primarily trains cardio, legs, chest, shoulders, and trunk stiffness.${supportText}`,
      why: 'Burpees combine a squat, plank transition, and standing finish, making them a simple high-output drill when space and equipment are limited.',
      setup: 'Clear enough floor space for a plank and stand with feet about hip width. Use the step-back version if jumping back makes your low back sag or your landings get loud.',
      movement: 'Move as one clean rep at a time. Hands land under shoulders, ribs stay braced in the plank, feet return flat under the hips, and the finish is tall before the next rep.',
      feel: 'Breathing should climb fast and the whole body should work. You should not feel sharp wrist, shoulder, or low-back strain.',
      mistake: 'Flopping into the plank or rushing sloppy landings. Keep the plank organized and choose a step-back rep before form breaks.',
      concentric: 'Complete the rep with a crisp floor-to-stand transition. Drive the feet back, snap them forward under control, then stand tall or jump if prescribed.',
      eccentric: 'Reset briefly between reps or during the rest interval. Shake out the arms, breathe, and restart with a stable plank position.',
      phaseTitle,
      primaryPhaseLabel: 'REP',
      secondaryPhaseLabel: 'RESET',
    };
  }

  if (has(/mountain climber/)) {
    return {
      howTo: 'Hold a high plank and drive one knee at a time toward the chest for the prescribed interval. Move quickly only while the hips and shoulders stay stable.',
      hits: `Primarily trains cardio, abs, hip flexors, shoulders, and trunk anti-rotation.${supportText}`,
      why: 'Mountain climbers turn a plank into a conditioning drill by adding fast knee drives without needing jumping or equipment.',
      setup: 'Start in a push-up plank with hands under shoulders, feet behind you, and ribs tucked down. Widen the feet slightly if your hips rock side to side.',
      movement: 'Alternate knee drives while pressing the floor away. Keep the back long, hips near shoulder height, and foot strikes light.',
      feel: 'Abs, shoulders, and lungs should work together. If the low back takes over, slow down and shorten the knee drive.',
      mistake: 'Letting the hips bounce high or sag low. The drill should look like a plank with fast legs, not a loose crawl.',
      concentric: 'Drive the knee forward sharply while keeping the supporting leg and shoulders braced.',
      eccentric: 'Return the foot to the plank under control and immediately switch sides without losing trunk position.',
      phaseTitle,
      primaryPhaseLabel: 'DRIVE',
      secondaryPhaseLabel: 'RESET',
    };
  }

  if (has(/plank jack|squat thrust/)) {
    const isPlankJack = has(/plank jack/);
    return {
      howTo: isPlankJack
        ? 'Hold a high plank and jump or step both feet out and in like a jumping jack for the prescribed time.'
        : 'Perform burpee-style reps without the push-up or jump: hands to floor, feet jump or step back to plank, feet return under you, then stand.',
      hits: `Primarily trains cardio, shoulders, abs, and hip control.${supportText}`,
      why: isPlankJack
        ? 'Plank jacks add fast footwork to a plank, raising heart rate while challenging trunk stiffness.'
        : 'Squat thrusts deliver the conditioning piece of a burpee with less impact and less upper-body fatigue.',
      setup: 'Use a clear floor space and start with hands under shoulders. Choose step-out reps if jumping causes loud landings or hip sway.',
      movement: isPlankJack
        ? 'Keep shoulders stacked over hands, brace the ribs down, and move the feet out-in without letting the hips bounce.'
        : 'Place hands down, brace the plank, move feet back and forward, then stand tall before starting the next rep.',
      feel: 'Shoulders, abs, and lungs should work. The low back should stay quiet.',
      mistake: 'Moving the feet faster than the plank can handle. Slow down or step the feet when hips start swinging.',
      concentric: isPlankJack
        ? 'Move the feet out and back in while maintaining a strong plank line.'
        : 'Kick or step the feet back to plank, then bring them forward under control and stand.',
      eccentric: 'Use the reset or rest period to bring breathing down and rebuild the plank before the next rep.',
      phaseTitle,
      primaryPhaseLabel: isPlankJack ? 'JACK' : 'REP',
      secondaryPhaseLabel: 'RESET',
    };
  }

  if (has(/jumping jack|high knees|butt kick|fast feet/)) {
    const isJumpingJack = has(/jumping jack/);
    const isHighKnees = has(/high knees/);
    const isButtKicks = has(/butt kick/);
    const drill = isJumpingJack ? 'jumping jacks' : isHighKnees ? 'high knees' : isButtKicks ? 'butt kicks' : 'fast feet';
    return {
      howTo: isJumpingJack
        ? 'Perform classic jumping jacks: feet jump out as arms reach overhead, then feet jump in as arms return to your sides.'
        : isHighKnees
          ? 'Run in place with quick arm action and drive alternating knees toward hip height for the prescribed interval.'
          : isButtKicks
            ? 'Jog in place and pull alternating heels toward your glutes while keeping knees under the hips.'
            : 'Stay in an athletic stance and tap the feet rapidly in place with short, quiet contacts.',
      hits: `Primarily trains cardio, foot rhythm, calves, and hip coordination.${supportText}`,
      why: `${humanizeToken(drill)} are simple upright conditioning drills that raise heart rate quickly without setup time.`,
      setup: 'Clear a small patch of floor, stay tall, and keep knees soft. Use march-in-place if impact needs to be lower.',
      movement: isJumpingJack
        ? 'Land softly on each out-in jump and keep the arms moving in rhythm without shrugging.'
        : isHighKnees
          ? 'Drive knees up from the hips, pump the arms, and keep foot contacts quick under your body.'
          : isButtKicks
            ? 'Keep posture tall, cycle the heels back quickly, and avoid leaning forward to chase the movement.'
            : 'Keep the hips low, chest proud, and feet moving fast without drifting around the room.',
      feel: 'Breathing should rise and lower legs may burn, but contacts should stay light and controlled.',
      mistake: isJumpingJack
        ? 'Landing stiff-legged or letting the arms lag behind the feet.'
        : 'Letting posture collapse as speed increases. Keep the torso tall and shorten the range before form gets messy.',
      concentric: 'Move through the fast part of each rep with crisp rhythm and quiet foot contacts.',
      eccentric: 'Use the reset or easy interval to march, breathe, and bring posture back before the next push.',
      phaseTitle,
      primaryPhaseLabel: isJumpingJack ? 'JUMP' : isHighKnees ? 'DRIVE' : 'QUICK',
      secondaryPhaseLabel: 'RESET',
    };
  }

  if (has(/skater|line hop|shuffle/)) {
    const isSkater = has(/skater/);
    const isLineHop = has(/line hop/);
    return {
      howTo: isSkater
        ? 'Bound side to side like a speed skater, landing on one foot with the opposite leg sweeping behind you.'
        : isLineHop
          ? 'Hop quickly over an imaginary line, side to side or front to back, for the prescribed interval.'
          : 'Shuffle laterally in short, quick steps, staying low and reversing direction under control.',
      hits: `Primarily trains cardio, lateral footwork, calves, glutes, and balance.${supportText}`,
      why: 'Lateral conditioning drills train side-to-side movement that straight-ahead cardio misses.',
      setup: 'Use a flat surface with enough room to move side to side. Keep landings quiet and scale the distance before chasing speed.',
      movement: isSkater
        ? 'Push off one foot, travel sideways, land softly, and absorb through the hip before bounding back.'
        : isLineHop
          ? 'Keep hops small and quick, knees soft, and torso quiet as the feet clear the line.'
          : 'Stay in an athletic stance, push the floor sideways, and keep the feet from crossing.',
      feel: 'You should feel lungs, calves, and outer hips working while balance stays under control.',
      mistake: 'Letting knees cave inward or landing loudly. Shorten the hop or shuffle distance until landings are clean.',
      concentric: isSkater ? 'Push laterally and bound to the other side.' : 'Move quickly across the line or shuffle lane with springy foot contacts.',
      eccentric: 'Absorb the landing softly, regain balance, and immediately prepare for the next direction change.',
      phaseTitle,
      primaryPhaseLabel: isSkater ? 'BOUND' : 'HOP',
      secondaryPhaseLabel: 'LAND',
    };
  }

  if (has(/battle rope/)) {
    return {
      howTo: 'Use anchored battle ropes for timed waves, slams, or alternating arms. Work hard for the interval, then rest before the next round.',
      hits: `Primarily trains cardio, shoulders, lats, grip, and trunk bracing.${supportText}`,
      why: 'Battle ropes create a high heart-rate conditioning effect with very little lower-body impact.',
      setup: 'Stand in an athletic stance with knees soft, ribs down, and one rope end in each hand. Step closer to make waves easier or back up to add tension.',
      movement: 'Create strong rope waves by moving from the shoulders and trunk while keeping the neck relaxed. For slams, lift and drive the ropes down hard.',
      feel: 'Shoulders, grip, and lungs should fatigue quickly while the low back stays stable.',
      mistake: 'Standing upright and yanking only with the arms. Stay braced, use the trunk, and keep waves consistent.',
      concentric: 'Drive the ropes into fast waves or powerful slams for the work interval.',
      eccentric: 'Rest fully enough to restore shoulder rhythm and breathing before the next round.',
      phaseTitle,
      primaryPhaseLabel: 'WAVES',
      secondaryPhaseLabel: 'RESET',
    };
  }

  if (has(/jump rope/)) {
    return {
      howTo: 'Use small, quick hops while turning the rope from the wrists. Work for the prescribed time, then rest before the next round.',
      hits: `Primarily trains cardio, calves, rhythm, and foot stiffness.${supportText}`,
      why: 'Jump rope delivers high conditioning density with simple equipment and easy interval structure.',
      setup: 'Use a rope length that reaches roughly armpit height when stood on. Pick a flat surface and keep elbows close to the ribs.',
      movement: 'Stay tall, bounce lightly off the balls of the feet, and keep jumps low. The rope turns from the wrists, not big shoulder circles.',
      feel: 'Calves and lungs should work quickly, but contacts should stay light and springy.',
      mistake: 'Jumping too high or whipping the rope with the shoulders. Both waste energy and make the drill fall apart.',
      concentric: 'During the work round, keep quick low hops and steady wrist turns until the timer ends.',
      eccentric: 'During rest, shake out the calves, reset the rope, and restart only when rhythm is ready.',
      phaseTitle,
      primaryPhaseLabel: 'JUMP',
      secondaryPhaseLabel: 'RESET',
    };
  }

  if (has(/boxing|kickboxing|martial.?arts|mma|shadow boxing|heavy bag/)) {
    return {
      howTo: 'Work in boxing rounds: move your feet, keep your guard up, and throw crisp combinations for the prescribed interval.',
      hits: `Primarily trains cardio, shoulders, trunk rotation, coordination, and footwork.${supportText}`,
      why: 'Boxing-style conditioning raises heart rate while training rhythm, coordination, and upper-body endurance without needing a machine.',
      setup: has(/heavy bag/) ? 'Wrap hands, use gloves, set a timer, and stand close enough to reach the bag without locking the elbows.' : 'Clear a small space, set a timer, keep hands by the face, and imagine a target in front of you.',
      movement: 'Stay light on the feet. Throw jab-cross combinations, add slips or pivots, then reset guard before the next combo.',
      feel: 'Breathing should climb, shoulders should fatigue, and footwork should stay controlled.',
      mistake: 'Dropping the hands and arm-punching while standing still. Keep guard, rotate the trunk, and keep moving.',
      concentric: 'During the round, flow through footwork and combinations without holding your breath.',
      eccentric: 'Between rounds, lower intensity, shake out the shoulders, and reset stance and guard.',
      phaseTitle,
      primaryPhaseLabel: 'ROUND',
      secondaryPhaseLabel: 'RESET',
    };
  }

  if (has(/no-jump|step-touch|low-impact|march/)) {
    return {
      howTo: 'Cycle through march-in-place, step-touch, side taps, and light punches for the prescribed time. Keep it low impact: no jumping jacks required.',
      hits: `Primarily trains easy cardio and coordination with minimal joint impact.${supportText}`,
      why: 'Low-impact cardio keeps the heart rate moving without repeated jumping or hard landings.',
      setup: 'Clear enough floor space to step side to side. Wear shoes with traction and keep the pace conversational.',
      movement: 'March tall, step side-to-side, tap lightly, and add relaxed punches if desired. Keep knees soft and land quietly.',
      feel: 'You should feel warm and lightly out of breath, not hammered.',
      mistake: 'Making it too intense too soon. The point is steady joint-friendly movement, not max-effort HIIT.',
      concentric: 'Move continuously through the low-impact pattern and keep steps light.',
      eccentric: 'Use slower marching or smaller steps whenever breathing climbs above the intended easy effort.',
      phaseTitle: 'Cardio Execution',
      primaryPhaseLabel: 'MOVE',
      secondaryPhaseLabel: 'MODIFY',
    };
  }

  return {
    howTo: isIntervals
      ? 'Perform the prescribed work interval with crisp movement, then use the recovery interval to reset before the next round.'
      : 'Perform continuous cardio at the prescribed pace, time, or heart-rate zone.',
    hits: `Primarily trains the cardiovascular system${supportText}.`,
    why: isIntervals
      ? 'Intervals alternate high effort with recovery so you can accumulate quality hard work without turning every minute into a grind.'
      : 'Steady cardio builds aerobic capacity and weekly conditioning volume.',
    setup: 'Set a timer and choose equipment or space that matches the exercise name. Start easy for the first minute before settling into the target effort.',
    movement: isIntervals ? 'Push during the work block, then deliberately back off during recovery.' : 'Keep rhythm smooth and effort consistent.',
    feel: isIntervals ? 'Hard blocks should challenge breathing; recovery blocks should bring it down.' : 'Effort should feel repeatable and controlled.',
    mistake: isIntervals ? 'Going so hard early that later rounds collapse.' : 'Letting pace drift too high and turning easy cardio into a hard workout.',
    concentric: isIntervals ? 'Use the work interval for the prescribed hard effort.' : 'Hold the target pace or zone with smooth breathing.',
    eccentric: isIntervals ? 'Use the recovery interval to slow down, breathe, and prepare for the next repeat.' : 'Adjust pace, resistance, or incline to stay in the target effort.',
    phaseTitle,
    primaryPhaseLabel: isIntervals ? 'WORK' : 'PACE',
    secondaryPhaseLabel: isIntervals ? 'RECOVER' : 'CONTROL',
  };
}

export function buildExerciseGuide(ex: ExerciseLibraryItem): ExerciseGuide {
  if (isCardioExercise(ex)) {
    return buildCardioExerciseGuide(ex);
  }

  const primary = humanizeToken(ex.primary_muscle) || 'the target muscle';
  const secondary = (ex.secondary_muscles ?? []).map(humanizeToken).filter(Boolean);
  const equipment = humanizeToken(ex.equipment) || 'the equipment';
  const supportText = secondary.length ? ` with help from ${joinParts(secondary)}` : '';
  const pattern = detectMovementPattern(ex.name, ex.primary_muscle ?? '');
  const p = primary.toLowerCase();
  const sec = secondary.map(s => s.toLowerCase());

  const phaseDescriptions: Record<MovementPattern, { concentric: string; eccentric: string; why: string; setup: string; movement: string; feel: string; mistake: string }> = {
    curl: {
      concentric: `As you curl the weight up, the ${p} contracts and shortens — pulling your forearm toward your upper arm. Peak contraction happens at the top: squeeze hard and hold for a beat to maximize tension.`,
      eccentric: `Lowering is where real growth happens. Control the descent over 2–3 seconds as the ${p} lengthens under load. Rushing the lowering phase throws away half the stimulus.`,
      why: `The elbow flexion arc puts the ${p} under tension through its full range. With a supinated (underhand) grip, the forearm rotation adds a secondary function the ${p} is designed for, making curls uniquely effective.`,
      setup: `Stand tall, pin your elbows to your sides. Grab the ${equipment.toLowerCase()} with a shoulder-width underhand grip. Brace your core so only your forearms move.`,
      movement: `Initiate from the ${p} — not from your wrists or shoulders. The upper arm stays fixed. Drive the weight up, squeeze at the top, then lower with control.`,
      feel: `You should feel a deep burn in the front of your upper arm. If your shoulder or forearm is dominating, you're probably swinging or using too much weight.`,
      mistake: `Swinging the torso to heave the weight up. This shifts load to your lower back and delts. Keep your upper arms pinned — only your forearms move.`,
    },
    extension_elbow: {
      concentric: `As you straighten your arm (or push the weight away), the ${p} fires and shortens, driving your elbow toward full extension. The lockout at the end is pure tricep output.`,
      eccentric: `As you bend the elbow (lowering toward your skull on a skull crusher, or descending in a dip), the ${p} lengthens under load. Overhead variations create the biggest eccentric stretch because the long head spans both joints.`,
      why: `All pushing and straightening movements require elbow extension — the ${p}'s primary job. The ${p} makes up roughly two-thirds of your upper arm, so developing it adds more arm size than bicep work alone.`,
      setup: `Position yourself so the ${p} starts in a stretched position. For overhead work, keep elbows pointing forward and close together.`,
      movement: `Drive from elbow extension — push the weight away by straightening your arm. Think "push my elbow straight" rather than "move the weight." Lock out fully at the top.`,
      feel: `You should feel the back of your upper arm working — the horseshoe shape should harden and contract. Avoid letting elbows flare wide, which shifts load to the chest.`,
      mistake: `Letting elbows flare out or cut the range short. Flaring shifts work to shoulders/chest. Partial reps skip the deepest stretch where the long head grows most.`,
    },
    press_horizontal: {
      concentric: `As you press the weight away from your chest, the ${p} shortens and contracts — driving the arms from a bent, lowered position to full extension.`,
      eccentric: `Lowering the bar to your chest stretches the ${p} under load. This bottom-range stretch is a key growth stimulus — don't bounce; control the descent.`,
      why: `The horizontal pushing motion aligns with the ${p}'s fiber direction — from the sternum and clavicle outward. Both shoulder flexion and horizontal adduction happen simultaneously.`,
      setup: `Lie flat (or at the target angle), retract and depress your shoulder blades into the bench, plant your feet. Grip at roughly 1.5x shoulder width.`,
      movement: `Lower with control to your chest or chin level, then press explosively. Think "push the bar away from you." Keep wrists stacked over elbows.`,
      feel: `You should feel a stretch across your chest at the bottom and a squeeze when your arms come together at the top.`,
      mistake: `Flaring elbows to 90° puts massive stress on the shoulder joint. Aim for elbows ~45–75° from your torso.`,
    },
    fly: {
      concentric: `As your arms come together in front of you, the ${p} performs horizontal adduction — bringing the upper arms toward the midline of the body.`,
      eccentric: `Opening your arms wide stretches the ${p} fibers across a longer range than any pressing movement. This deep stretch under load is the fly's biggest advantage.`,
      why: `The ${p}'s primary action is horizontal adduction. Flies isolate this motion without triceps helping to lock out, keeping tension on the ${p} through the full arc.`,
      setup: `Set up with a slight bend in the elbows (maintain this angle throughout). Use a light enough weight that you can fully control the arc.`,
      movement: `Think "hugging a barrel" — arc the arms in a wide circle rather than bending them. Lead with your elbows on the way down, and squeeze at the peak.`,
      feel: `A deep stretch across your chest at the bottom. If you feel it in your biceps or shoulder instead, reduce the weight and focus on form.`,
      mistake: `Turning a fly into a press by bending the elbows more as the weight gets heavy. Go lighter to maintain the isolation.`,
    },
    row: {
      concentric: `Pulling the weight toward your torso involves the ${p} retracting the scapula and extending the shoulder. The ${p} shortens as your elbow drives back past your torso.`,
      eccentric: `Letting the weight back out with control stretches the ${p} fibers and allows the scapula to protract. This controlled lowering builds thickness in the back.`,
      why: `Rows align the pulling motion with the ${p}'s fiber direction — running diagonally across the back. The more horizontal the pull, the more the ${p} works.`,
      setup: `Hinge at the hips with a neutral spine. Keep the ${equipment.toLowerCase()} below your shoulders at the start. Engage your lats before pulling.`,
      movement: `Drive your elbows back (not up). Think "elbow to pocket" for lower-back engagement or "elbow to ear" for upper-back.`,
      feel: `A tight squeeze between your shoulder blades at the peak and a stretch across your back at full arm extension.`,
      mistake: `Rounding the lower back and using momentum to heave the weight. A rounded spine under load is a spinal injury risk.`,
    },
    pulldown: {
      concentric: `As you pull the bar down toward your collarbone, the ${p} adducts and extends the shoulder — pulling your upper arms down and back.`,
      eccentric: `Allowing the bar to rise back to full arm extension stretches the entire back musculature under tension. Control this phase.`,
      why: `The pulldown angle closely mimics the ${p}'s line of pull — fibers run from the outer edges of the back to the upper arm and are maximally loaded when the arms are overhead.`,
      setup: `Sit with thighs under the pads, lean back very slightly (~10–15°). Grab the bar just wider than shoulder-width with an overhand grip.`,
      movement: `Initiate by depressing your shoulders (push them down) before bending your elbows. Think "elbows to your back pockets."`,
      feel: `You should feel the sides of your back engaging — the "wings" under your armpits.`,
      mistake: `Pulling with your arms instead of your back. If your biceps fatigue first, you're arm-pulling. Think of your hands as hooks.`,
    },
    press_vertical: {
      concentric: `Pressing overhead contracts the ${p} as you drive your arms upward and outward, extending the shoulder joint.`,
      eccentric: `Lowering the weight back to shoulder height stretches the deltoids and engages the rotator cuff as stabilizers.`,
      why: `Vertical pressing loads the deltoid in its primary function — shoulder abduction and flexion. The overhead position removes chest involvement.`,
      setup: `Stand tall or sit upright with core braced. Hold the ${equipment.toLowerCase()} at shoulder height with elbows at ~90°. Keep your lower back from arching.`,
      movement: `Press straight up. At the top, shrug slightly to elevate the scapula — this full overhead position is important for shoulder health.`,
      feel: `The outer and front of your shoulders should burn. If your traps dominate, you're shrugging too early.`,
      mistake: `Letting the lower back hyperextend to compensate for poor shoulder mobility. Brace the core and keep the ribcage down.`,
    },
    raise: {
      concentric: `Raising the weight abducts or flexes the shoulder, contracting the target portion of the deltoid.`,
      eccentric: `Slowly lowering back down under control keeps the deltoid under tension through the full range.`,
      why: `Raises isolate specific heads of the deltoid by changing the plane. Lateral raises hit the medial head; front raises target the anterior head; rear raises target the posterior head.`,
      setup: `Use a lighter weight than you think. The deltoid is a relatively small muscle and raises are pure isolation.`,
      movement: `Lead with the elbow, not the hand. Keep a slight bend in the arm. Raise to parallel in a smooth arc.`,
      feel: `A burning sensation at the top and outer part of your shoulder. If your traps are cramping, you're shrugging.`,
      mistake: `Shrugging the traps to assist the raise. Think "keep shoulders away from ears" throughout the movement.`,
    },
    squat: {
      concentric: `Driving up from the bottom, the ${p} extend the knee and hip simultaneously, generating force against the floor.`,
      eccentric: `Descending into the squat puts the ${p} and glutes under the highest load — the muscles lengthen under bodyweight and external load.`,
      why: `The squat's knee flexion and hip flexion angles load the ${p} exactly at the range they're designed to work.`,
      setup: `Feet shoulder-width or slightly wider, toes turned out 15–30°. Brace the core before descending.`,
      movement: `Send hips back and down, not just down. Keep your chest up and knees tracking over your toes. Drive through your full foot.`,
      feel: `A deep burn in the front of the thighs (quads) and the glutes at the bottom.`,
      mistake: `Knees caving inward (valgus collapse) on the way up. Push your knees out to match your toe angle.`,
    },
    hinge: {
      concentric: `Driving the hips forward to extend them, the ${p} (hamstrings and glutes) contract and shorten, pulling the torso back to upright.`,
      eccentric: `Hinging the hips back stretches the ${p} and hamstrings under load. This is the most important phase for posterior chain development.`,
      why: `Hip hinges load the ${p} and hamstrings in hip extension — their primary function.`,
      setup: `Stand with feet hip-width. With a barbell, grip just outside your legs. Keep the bar close to your body. Brace hard before lifting.`,
      movement: `"Push the floor away" on the concentric rather than "pull the weight up." Maintain a neutral spine.`,
      feel: `A deep stretch in the back of your thighs on the way down, and glute contraction at lockout.`,
      mistake: `Rounding the lumbar spine. This shifts load to the spinal erectors in a compromised position — a frequent injury mechanism.`,
    },
    lunge: {
      concentric: `Pushing through the front heel extends the hip and knee, contracting the ${p} and glutes together.`,
      eccentric: `Stepping forward and lowering the back knee toward the ground stretches the ${p} and hip flexors under load.`,
      why: `Lunges expose and correct bilateral asymmetry — they train each leg independently.`,
      setup: `Step far enough forward that your front shin stays roughly vertical at the bottom. Keep your torso upright.`,
      movement: `Lower the back knee toward the floor with control. Drive through the front heel to return.`,
      feel: `A deep stretch in the back hip (hip flexor) and a squeeze in the front quad and glute.`,
      mistake: `Step too short, causing the front knee to shoot far past the toes.`,
    },
    hip_thrust: {
      concentric: `Driving the hips upward creates maximal hip extension, squeezing the ${p} at the very top.`,
      eccentric: `Lowering the hips back toward the floor stretches the ${p} fibers under load.`,
      why: `Hip thrusts are uniquely effective because the resistance is highest at full hip extension (the top), where the ${p} are fully contracted.`,
      setup: `Upper back against a bench, bar over the hips with a pad. Feet planted flat, about hip-width.`,
      movement: `Drive hips straight up, not forward. Squeeze hard at the top and hold for a beat. Keep your chin tucked.`,
      feel: `An intense contraction in the ${p} at the top. If your lower back is working harder, tuck your pelvis slightly.`,
      mistake: `Hyperextending the lower back at the top. Stop when your body forms a straight line from shoulders to knees.`,
    },
    calf_raise: {
      concentric: `Rising onto your toes contracts the ${p} — pushing the heel away from the ground.`,
      eccentric: `Lowering the heel as far below the step as possible stretches the ${p} fibers under tension.`,
      why: `The calf is a postural muscle that fires constantly during walking — making it highly fatigue-resistant. Overloading with heavy weight and slow eccentrics are the main growth stimuli.`,
      setup: `Stand on a step so your heels can drop below it. Use the ${equipment.toLowerCase()} for load.`,
      movement: `Full range every rep: heels drop all the way down, then rise all the way up.`,
      feel: `A burning stretch in the lower leg at the bottom and a tight squeeze at the top. 15–25 reps per set is often appropriate.`,
      mistake: `Partial reps (never dropping the heel) or bouncing at the bottom.`,
    },
    plank: {
      concentric: `There is no movement — the ${p} contract isometrically to resist spinal extension, flexion, and rotation.`,
      eccentric: `The challenge is sustaining tension — as fatigue sets in, the core wants to collapse. Maintaining position is active work.`,
      why: `The ${p} stabilizes the spine during virtually every compound lift. A strong plank transfers to better form in deadlifts, squats, overhead press, and rows.`,
      setup: `Forearms on the floor (elbows under shoulders), body in a straight line from head to heels. Squeeze your glutes and engage your core.`,
      movement: `This is a static hold. Push your elbows into the floor, think about "pulling your elbows toward your feet" to activate the lats.`,
      feel: `Tension throughout your entire mid-section — not just the front.`,
      mistake: `Letting the hips rise or sag. A sagging plank loads the lower back instead of the core.`,
    },
    crunch: {
      concentric: `Shortening the distance between your ribcage and pelvis by curling the spine — the ${p} contract and shorten.`,
      eccentric: `Lowering back down with control as the ${p} lengthen. Don't let your head fall to the floor.`,
      why: `The ${p} run vertically from the pelvis to the ribcage. Their primary function is spinal flexion — the exact motion in a crunch.`,
      setup: `Lie flat, knees bent. Hands behind your head or crossed on your chest — don't pull on your neck.`,
      movement: `Curl your ribcage toward your pelvis, not your head toward your knees. The movement is short.`,
      feel: `The burn should be directly in your abs. Neck or lower back pain means you're pulling with your neck.`,
      mistake: `Pulling on your neck or using momentum. True crunch range of motion is small — quality contraction beats large range.`,
    },
    generic: {
      concentric: `During the lifting/working phase, the ${p} shortens and contracts to produce force against the resistance.`,
      eccentric: `During the lowering/returning phase, the ${p} lengthens under load — this phase is critical for muscle growth. Control it for 2–3 seconds.`,
      why: ex.is_compound
        ? `This compound movement loads the ${p} while multiple joints move together, allowing heavier loads and greater total muscle recruitment${sec.length ? ` with support from ${joinParts(sec)}` : ''}.`
        : `The single-joint isolation keeps tension focused on the ${p} throughout the range, without other muscle groups sharing the load.`,
      setup: `Set yourself up so your body feels balanced, brace your torso, and position the ${equipment.toLowerCase()} so the movement starts under control.`,
      movement: `Move through a full, controlled range of motion. Think about driving the weight with ${p} rather than just swinging it.`,
      feel: `You should mostly feel this in the ${p}${sec.length ? `, with some support from ${joinParts(sec).toLowerCase()}` : ''}. Sharp or joint pain means stop.`,
      mistake: `Using too much momentum or shortening the range of motion. Both rob the ${p} of the stimulus you're there to provide.`,
    },
  };

  const pd = phaseDescriptions[pattern];

  return {
    howTo: ex.description
      ? ex.description
      : `Use ${equipment.toLowerCase()} with full control through the entire range of motion. Move deliberately — the goal is to load the ${p}, not just move the weight.`,
    hits: `Primarily targets the ${p}${supportText}. ${ex.is_compound ? `As a compound movement, multiple muscle groups contribute — but ${p} is the prime mover.` : `As an isolation movement, it keeps tension concentrated on the ${p}.`}`,
    why: pd.why,
    setup: pd.setup,
    movement: pd.movement,
    feel: pd.feel,
    mistake: pd.mistake,
    concentric: pd.concentric,
    eccentric: pd.eccentric,
    phaseTitle: 'Muscle Phase Breakdown',
    primaryPhaseLabel: '↑ LIFTING',
    secondaryPhaseLabel: '↓ LOWERING',
  };
}

export function getExerciseVideoUrl(exerciseName: string, equipment?: string | null): string {
  const concreteEquipment = String(equipment ?? '').trim();
  const broad = /^(gym|home|full|minimal|other|cardio)$/i.test(concreteEquipment);
  const query = `${broad || !concreteEquipment ? '' : `${concreteEquipment} `}${exerciseName} proper form tutorial`;
  return `https://m.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}
