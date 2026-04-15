/**
 * Exercise guide — generates detailed exercise breakdowns including
 * movement phases, setup cues, and common mistakes.
 * Shared between HomeScreen and EditProfileScreen exercise libraries.
 */

export interface ExerciseLibraryItem {
  id?: number;
  name: string;
  description?: string | null;
  primary_muscle?: string;
  secondary_muscles?: string[];
  equipment?: string;
  is_compound?: boolean;
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

export function buildExerciseGuide(ex: ExerciseLibraryItem): ExerciseGuide {
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
  };
}

export function getExerciseVideoUrl(exerciseName: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${exerciseName} proper form`)}`;
}
