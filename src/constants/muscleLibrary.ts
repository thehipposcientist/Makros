/**
 * Muscle Library — educational data for each major muscle group.
 * Content is written to teach biomechanics, not just name muscles.
 */

export interface MuscleEntry {
  id: string;
  name: string;           // scientific name
  commonName: string;     // everyday name
  bodyRegion: string;     // e.g. "Upper Arm · Front"
  emoji: string;
  icon: string;
  svgUrl?: string;
  tagColor: string;       // hex for the section tag
  shortDescription: string;
  location: string;
  structure: string;
  primaryFunction: string;
  phases: {
    concentric: string;   // what it does when shortening (lifting phase)
    eccentric: string;    // what it does when lengthening (lowering phase)
    isometric?: string;   // when it holds without moving
  };
  howToFeel: string;
  mindMuscleConnection: string;
  bestExercises: string[];
  commonMistakes: string;
  growthTip: string;
  recoveryNote: string;
}

export const MUSCLE_LIBRARY: MuscleEntry[] = [
  // ── Arms ─────────────────────────────────────────────────────────────────────
  {
    id: 'biceps',
    name: 'Biceps Brachii',
    commonName: 'Biceps',
    bodyRegion: 'Upper Arm · Front',
    emoji: '💪',
    icon: 'fitness-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-1.8790f8a0b3b9.svg',
    tagColor: '#4A9EE8',
    shortDescription: 'The two-headed muscle on the front of your upper arm responsible for bending the elbow and rotating the forearm.',
    location: 'Runs along the front of your upper arm, from the shoulder (at two attachment points on the scapula) down to the radius bone in your forearm. It has two heads: the long head runs along the outer side of your arm, the short head along the inner side.',
    structure: 'Composed of two distinct muscle bellies (heads) that merge into a single tendon. The long head sits more laterally and creates the bicep "peak" when viewed from the front. The short head adds width when viewed from the front.',
    primaryFunction: 'Flexes the elbow (bends the arm), supinates the forearm (rotates your palm from facing down to facing up), and assists in shoulder flexion (raises the arm forward).',
    phases: {
      concentric: 'When you curl the weight up, the biceps contracts and shortens. As your elbow bends from a straight position (~170°) toward full flexion (~30°), the muscle fibers slide closer together, pulling your forearm toward your upper arm. The peak contraction happens at the top of the curl — you can feel the muscle harden and bunch up. The forearm is also being rotated (supinated) simultaneously if you are using a supinated (underhand) grip.',
      eccentric: 'Lowering the weight is where significant growth happens. As your elbow extends and the weight descends, the biceps is actively lengthening under tension — resisting the pull of gravity. This controlled lengthening creates tiny tears in the muscle fibers that, when repaired, make the muscle thicker and stronger. Rushing through the lowering phase wastes this stimulus. Aim for 2–3 seconds on the way down.',
      isometric: 'At the top of a curl, holding the contraction keeps the biceps fully shortened under tension. This isometric hold amplifies time-under-tension and increases the metabolic stress signal for hypertrophy.',
    },
    howToFeel: 'Before your set, squeeze your fist and flex your elbow without any weight — feel the front of your upper arm harden. That tightening is your biceps contracting. During the curl, focus on initiating the movement from that same spot rather than thinking about moving the weight.',
    mindMuscleConnection: 'Try this: hold a light dumbbell with a fully supinated grip (palm up). Slowly curl it while watching your bicep in a mirror. At the top, squeeze hard for 1 second. Focus on the muscle shortening rather than the weight moving. This attentional focus increases muscle fiber recruitment by up to 22% (research-backed).',
    bestExercises: [
      'Barbell Curl — heaviest load, both heads work equally',
      'Dumbbell Curl with Supination — adds the twisting component for full range of function',
      'Incline Dumbbell Curl — stretches the long head more at the bottom due to the angled position',
      'Preacher Curl — removes momentum and forces full elbow flexion strength',
      'Hammer Curl — shifts focus to the brachialis (deeper arm muscle) and forearm',
      'Cable Curl — maintains constant tension throughout the entire range of motion',
    ],
    commonMistakes: 'Swinging the torso to heave the weight up. This shifts the load to your lower back and shoulders rather than the biceps. The upper arms should stay pinned to your sides — only the forearm should move. Also: cutting the range short (not fully extending at the bottom loses the eccentric stretch; not fully curling at the top loses peak contraction).',
    growthTip: 'The long head (outer bicep — creates the peak) is maximally stretched when your arm is behind your body. To target it, do incline curls on a bench set to ~45–60°. The short head (inner bicep — adds width) is better targeted with arms in front of the body, like preacher curls.',
    recoveryNote: 'Biceps recover relatively fast (48–72 hrs) but are also worked heavily during all back pulling movements. Soreness after rows is partly bicep soreness. Account for this overlap in your weekly programming — direct bicep work 2× per week is sufficient for most people.',
  },
  {
    id: 'triceps',
    name: 'Triceps Brachii',
    commonName: 'Triceps',
    bodyRegion: 'Upper Arm · Back',
    emoji: '🦾',
    icon: 'arrow-up-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-5.8a2b934b5486.svg',
    tagColor: '#C07840',
    shortDescription: 'The three-headed muscle on the back of your upper arm that makes up about two-thirds of your arm\'s total size.',
    location: 'Spans the entire back of your upper arm, from behind the shoulder to the elbow. The three heads originate at different points: the long head at the scapula, the medial head at the back of the humerus (deep, not visible), and the lateral head on the outer side of the humerus.',
    structure: 'Three heads (long, lateral, medial) that converge into a single thick tendon attaching to the olecranon — the bony point of your elbow. The long head is the largest and crosses both the elbow and shoulder joints, making it sensitive to upper arm position. The lateral head creates the horseshoe shape visible from the outside. The medial head provides baseline strength throughout the range.',
    primaryFunction: 'Extends the elbow (straightens the arm). The long head also extends and adducts the shoulder. Triceps are engaged in every pushing movement: press, push, dip.',
    phases: {
      concentric: 'When you push weight away (like a press) or straighten your arm (like a pushdown), the triceps contracts and shortens. As the elbow moves from bent to straight, the three heads fire sequentially — the medial head activates throughout, the lateral head adds force in the mid-range, and the long head contributes more when the arm is raised overhead. The lockout at the top is pure tricep dominance.',
      eccentric: 'As you bend your elbow (lowering a bar toward your skull on a skull crusher, or descending in a push-up), the triceps lengthen under load. This eccentric phase with triceps is particularly effective for building the long head because the long head is stretched across both the elbow and shoulder simultaneously. Overhead tricep exercises create the biggest eccentric stretch.',
      isometric: 'Locking out at the top of any press briefly maintains full tricep contraction. In a plank or push-up hold, the triceps isometrically stabilize the elbow joint.',
    },
    howToFeel: 'Straighten your arm fully and try to push your elbow into hyperextension (don\'t actually force it). Feel the back of your upper arm harden. That is your triceps. During exercises, think about "pushing the elbow straight" rather than "pushing the weight away."',
    mindMuscleConnection: 'Take a cable pushdown and use an extremely light weight. Straighten your arm fully and hold for 3 seconds, squeezing as hard as possible. Feel the horseshoe shape on the back of your arm contract. Now you know what tricep contraction feels like — replicate that focus with heavier weights.',
    bestExercises: [
      'Overhead Tricep Extension — maximally stretches the long head (largest portion)',
      'Close-Grip Bench Press — heaviest load you can use for tricep extension',
      'Skull Crusher — isolated elbow extension with good eccentric emphasis',
      'Cable Pushdown — constant tension, easy to feel the muscle working',
      'Dips (tricep-focused with upright torso) — compound movement for overall mass',
      'Diamond Push-Ups — bodyweight option that heavily loads all three heads',
    ],
    commonMistakes: 'Flaring the elbows out during pushdowns and skull crushers. When elbows move sideways, the movement becomes more of a shoulder exercise. Keep elbows pointing straight back. Also: not fully extending at the end of each rep — the peak contraction at full extension is the primary strength stimulus for the triceps.',
    growthTip: 'The long head (largest of the three) is only fully stretched when your arm is overhead. This makes overhead tricep extensions uniquely effective — research shows overhead extension positions produce 30–40% more long head activation than pushdowns. Include at least one overhead tricep movement per week.',
    recoveryNote: 'Triceps are indirectly worked in all chest and shoulder pressing. If you train chest Monday, shoulders Wednesday, and then direct arms Friday, your triceps have been loaded 3 days in a row. Be mindful of this accumulation — if triceps feel fatigued going into a pressing day, reduce tricep volume that week.',
  },

  // ── Chest ─────────────────────────────────────────────────────────────────────
  {
    id: 'chest',
    name: 'Pectoralis Major',
    commonName: 'Chest / Pecs',
    bodyRegion: 'Chest',
    emoji: '🫀',
    icon: 'shield-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-4.c9fa9a228bc8.svg',
    tagColor: '#E85858',
    shortDescription: 'The large fan-shaped muscle covering the front of your chest, responsible for pushing movements and horizontal arm motion.',
    location: 'Covers the front of the ribcage, attaching to the clavicle (upper portion / clavicular head), the sternum and ribs (lower portion / sternal head), and the front of the humerus (upper arm). The two portions have somewhat different angles of pull, which is why incline and flat presses feel different.',
    structure: 'Divided into the clavicular head (upper chest, from collarbone) and the sternal head (lower and mid chest, from sternum). Both merge into one tendon on the arm. The clavicular head is often underdeveloped because flat pressing barely activates it — it requires a more upward angle.',
    primaryFunction: 'Horizontal adduction of the arm (bringing the arm across your body — like a bear hug motion). Flexion of the shoulder (upper portion). Internal rotation of the arm. Every pushing movement away from your chest uses the pec major.',
    phases: {
      concentric: 'On the push (pressing a bar off your chest or pushing up from a push-up), the pec major contracts, pulling your upper arm across your chest. Think of it as the muscle trying to squeeze your two arms together — the pressing movement is just a result of that action. The muscle shortens from its longest point (arms fully stretched out to the sides) to its shortest (arms pushed straight out in front). Cue: "Bend the bar in half" or "squeeze a grapefruit between your pecs" to activate the right pattern.',
      eccentric: 'As the bar or your body descends (lowering phase), the pec major lengthens under tension — this is where the real stretch stimulus comes from. The deeper you lower (elbows slightly below the bench level on a press, or chest to the floor on push-ups), the more the pec major is stretched. Research shows this loaded stretch is a primary driver of chest hypertrophy. Never cut the lowering phase short.',
      isometric: 'In the bottom position of a flye or a cable crossover hold, the chest is under intense stretch tension. Holding here 1–2 seconds per rep significantly increases the growth signal.',
    },
    howToFeel: 'Stand in a doorframe and push both hands against the frame (hands at chest height, elbows bent). Without moving your hands, try to push them together — feel your chest tighten. That squeeze is your pec major firing. Replicate this feeling during all pressing and flye movements.',
    mindMuscleConnection: 'Most people use too much triceps on pressing movements. To shift focus to the chest: slightly widen your grip, keep your elbows angled at ~75° from your torso (not flared 90° out, not tucked close to your body), and think of "pushing your elbows together" rather than "pushing the weight up." The weight moving is just the side effect of your pecs contracting.',
    bestExercises: [
      'Flat Barbell/Dumbbell Bench Press — primary mass builder for mid/lower chest',
      'Incline Barbell/Dumbbell Press (30–45°) — targets the clavicular (upper) head',
      'Cable Flye — constant tension throughout the full range, excellent for the stretch',
      'Dumbbell Flye — emphasizes the stretch at the bottom; use light weight',
      'Dips (forward lean) — hits the lower chest with good compound loading',
      'Push-Ups with wide grip — underrated for chest development with full range',
    ],
    commonMistakes: 'Cutting the range of motion short (not lowering the bar all the way to the chest). This removes the eccentric stretch entirely. Also: bench pressing with elbows flared 90° out — this puts dangerous shear force on the shoulder joint and reduces pec activation. Elbows should be at 45–75° from your torso.',
    growthTip: 'Most people overtrain flat pressing and undertrain the upper chest (clavicular head). The upper chest requires an inclined angle — 15–45° incline. If your upper chest is underdeveloped, replace one flat press day with incline work. Cable flyes in the crossover are excellent because you can adjust the cable height to match different chest fiber angles.',
    recoveryNote: 'The pecs are big muscles that handle heavy loads. They typically need 48–72 hours of recovery. If you bench Monday, your chest will still be recovering for direct training on Wednesday. Most people do well with 2 chest-focused sessions per week, with at least 72 hours between them.',
  },

  // ── Back ─────────────────────────────────────────────────────────────────────
  {
    id: 'lats',
    name: 'Latissimus Dorsi',
    commonName: 'Lats',
    bodyRegion: 'Back · Sides',
    emoji: '🪽',
    icon: 'layers-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-12.6a5de7a0e373.svg',
    tagColor: '#35C46A',
    shortDescription: 'The large wing-shaped muscles of your mid-back that give the torso its V-taper and drive all pulling movements.',
    location: 'The broadest muscles in the human body. They originate along the lower spine (T7 to L5 vertebrae), the sacrum, the iliac crest, and the lower ribs. They insert on the front of the humerus — meaning they pull the arm down and back.',
    structure: 'A large flat muscle with multiple attachment points along the spine and pelvis, fanning outward and upward to attach at the front of the upper arm. The fiber direction is diagonal, which means different fiber portions are recruited by different movement angles. The lower fibers (thickest portion) are best developed by rows; the upper fibers by pulldowns.',
    primaryFunction: 'Pulls the arm downward and backward (shoulder extension). Adducts the arm toward the body (bringing a raised arm down to your side). Internal rotation of the shoulder. The lat is the primary mover in all pulling movements: rows, pulldowns, and pull-ups.',
    phases: {
      concentric: 'On a pull-up, the lat fires to pull your body upward as it shortens, drawing your upper arm from above your head down toward your hip. On a row, the lat fires as you pull the handle toward your stomach, again drawing the arm toward the body. The key mechanical action is the elbow driving down and back — "elbow to hip pocket" is a useful cue. At full contraction, your elbows are below and behind your shoulders.',
      eccentric: 'As you lower from a pull-up or let the cable return on a pulldown, the lats lengthen under load. A full stretch at the top — arms fully extended overhead, allowing the shoulder blades to rise — gives the lat a complete eccentric range. Many people shorten this phase by not fully extending. The stretch at the top of a pulldown is where significant growth stimulus occurs.',
      isometric: 'The lats isometrically stabilize the shoulder during heavy pressing movements — they prevent the shoulder from being pulled forward. This is why lat engagement is often cued during bench press.',
    },
    howToFeel: 'Stand up and try to tuck your elbows into your back pockets without moving your arms forward. Feel the sides of your back tighten — that\'s your lats. Another approach: someone touches the sides of your back (behind the armpits) and you try to flex there. Once you can feel them, replicate that engagement during rows and pulldowns.',
    mindMuscleConnection: 'Most people row with their biceps and rear delts rather than their lats. To force lat engagement: before each pull, initiate the movement by depressing your shoulder blades (pulling them down, away from your ears) and then drive your elbows toward the floor/your hips. The biceps should feel like hooks holding the handle — not the prime mover.',
    bestExercises: [
      'Pull-Up / Chin-Up — gold standard for lat development; wide grip for lats, closer grip also works the upper back',
      'Lat Pulldown — same movement, easier to load precisely',
      'Barbell Row — hits the lower lats (pulls the arm toward the hip)',
      'Dumbbell Row — allows greater range of motion with a stretch at the bottom',
      'Seated Cable Row — constant tension, excellent for mid and lower lat fibers',
      'Straight-Arm Pulldown — isolates the lat without bicep involvement',
    ],
    commonMistakes: 'Shrugging the shoulders up during pulldowns and rows. This shifts work to the traps and reduces lat involvement. Before initiating any pull, consciously push your shoulders DOWN (depress the scapulae). Also: pulling the bar behind the neck — this position strains the cervical spine and has no benefit over pulling to the chest.',
    growthTip: 'For maximum lat width, prioritize overhead pulling (pull-ups, pulldowns) — the lat is most stretched with arms overhead. For lat thickness (the "meatier" look), rows that pull the elbows toward the hip are better. Both are needed for complete lat development.',
    recoveryNote: 'The lats are large muscles with high recovery capacity, but they\'re involved in almost all pulling exercises. If you do pull-ups on Monday and rows on Thursday, they\'ve been worked twice — plan accordingly. Most people can handle 2–3 direct lat training sessions per week.',
  },
  {
    id: 'traps',
    name: 'Trapezius',
    commonName: 'Traps',
    bodyRegion: 'Upper Back · Neck',
    emoji: '🗻',
    icon: 'triangle-outline',
    svgUrl: '',
    tagColor: '#A070E8',
    shortDescription: 'A large diamond-shaped muscle spanning the back of your neck, upper back, and mid-back. Often only the upper portion is trained, while the mid and lower traps are neglected.',
    location: 'Originates from the base of the skull, down the entire cervical spine (neck vertebrae), and all the way to the T12 vertebra in the mid-back. Inserts on the clavicle, the acromion (top of shoulder), and the spine of the scapula. This creates three functionally distinct regions: upper, middle, and lower traps.',
    structure: 'Upper fibers run diagonally downward from the skull/neck to the shoulder. Middle fibers run horizontally from the spine to the shoulder blade. Lower fibers run diagonally upward from the mid-back to the shoulder blade. Each region has different actions and is worked by different exercises.',
    primaryFunction: 'Upper traps: elevate the scapula (shrug). Middle traps: retract the scapula (pull shoulder blades together). Lower traps: depress the scapula (pull shoulder blades down and in). All three portions work together to rotate the scapula during overhead pressing — essential for shoulder health.',
    phases: {
      concentric: 'For upper traps (shrug): the shoulders rise as the traps contract, shortening the distance between the ear and shoulder. For mid/lower traps (row or face pull): the shoulder blades retract and depress as the traps pull them toward the spine and downward. The feeling is a "pinch" between the shoulder blades at full contraction.',
      eccentric: 'In a shrug, lowering the weight lets the traps lengthen, providing a stretch across the upper back. In rows and face pulls, as the arms extend forward, the shoulder blades protract, lengthening the mid and lower traps. A full protraction at the end of the row allows a complete eccentric range.',
    },
    howToFeel: 'For upper traps: shrug your shoulders toward your ears. Feel the muscles right at the junction of your neck and shoulders bulge. For mid traps: try to pinch a pencil between your shoulder blades. For lower traps: depress your shoulder blades (push them away from your ears while seated) — you\'ll feel activation in the mid-back, lower than where most people think.',
    mindMuscleConnection: 'Most people massively overdevelop their upper traps (from heavy shrugs, dead hangs, and stress) while leaving mid and lower traps undertrained. Prioritize exercises where you pull your shoulder blades DOWN and TOGETHER rather than UP.',
    bestExercises: [
      'Face Pull — best overall trap exercise, hits all three portions',
      'Barbell Shrug — upper trap mass builder',
      'Rear Delt Raise / Reverse Fly — middle and lower traps',
      'Y-T-W raises — lower and mid trap activation (use light weight)',
      'Dead Hangs — passive lower trap stretch',
      'Any Row — recruits mid traps during the retraction phase',
    ],
    commonMistakes: 'Only training upper traps with shrugs. Overdeveloped upper traps combined with weak lower traps create the "shoulder-to-ear" posture that looks rounded from the side. Mid and lower trap work is crucial for posture and shoulder health.',
    growthTip: 'Lower trap weakness is extremely common and causes forward shoulder posture. Spend as much time on face pulls and Y raises as you do on shrugs. A 1:1 ratio of upper to lower trap exercises is a good starting point.',
    recoveryNote: 'Upper traps are engaged in nearly every exercise (stabilizing the shoulder). They are often chronically tight rather than fatigued. Stretching the upper traps (ear to shoulder) and direct lower trap strengthening should be part of a balanced routine.',
  },

  // ── Shoulders ─────────────────────────────────────────────────────────────────
  {
    id: 'deltoids',
    name: 'Deltoid',
    commonName: 'Shoulders / Delts',
    bodyRegion: 'Shoulders',
    emoji: '🎯',
    icon: 'body-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-2.e1e1205a3202.svg',
    tagColor: '#F0A040',
    shortDescription: 'The three-headed cap of muscle covering the shoulder joint. Each head has a different function and requires different exercises to fully develop.',
    location: 'Wraps around the entire shoulder joint like a cap. The anterior (front) head originates on the front of the clavicle. The medial (side) head originates on the acromion. The posterior (rear) head originates on the spine of the scapula. All three insert together on the deltoid tuberosity of the humerus.',
    structure: 'Three distinct heads with different origin points mean they don\'t always work together. The anterior delt is heavily recruited during all pressing movements. The medial delt is the primary mover in lateral raises. The posterior delt is the main mover in rear delt raises and face pulls — and is frequently undertrained.',
    primaryFunction: 'Anterior delt: forward shoulder flexion (raising arm forward). Medial delt: arm abduction (raising arm sideways). Posterior delt: shoulder extension and horizontal abduction (pulling arm back and out).',
    phases: {
      concentric: 'Lateral raise: as you lift the dumbbells from your sides to shoulder height, the medial delt contracts and shortens. Overhead press: the anterior and medial delts both fire to push the weight overhead. The anterior delt is most active in the lower half of the press; the medial delt takes over in the upper half. Rear delt raise: pulling the elbows back contracts the posterior delt.',
      eccentric: 'Lateral raise: lowering the weight back to the sides — the medial delt lengthens under load. Since there\'s little eccentric tension at the very bottom (gravity has no leverage), the effective range is roughly the top 80% of the movement. Overhead press: lowering the bar provides eccentric loading for both the anterior and medial delts.',
      isometric: 'Holding a lateral raise at shoulder height (arm parallel to the floor) is an intense isometric hold for the medial delt. Even a 1–2 second hold here significantly increases time under tension.',
    },
    howToFeel: 'Anterior delt: raise one arm straight in front of you to shoulder height — feel the front of your shoulder. Medial delt: raise your arm to the side (like a T) — feel the top/outer part of your shoulder. Posterior delt: sit slightly forward and pull your elbow back and up — feel the back of your shoulder near the shoulder blade.',
    mindMuscleConnection: 'The common error on lateral raises is using the upper traps to shrug the weight up. To prevent this: at the start of each rep, push your shoulder blades DOWN before you raise your arms. Lead with your elbows (not your hands) and aim to have your pinkies slightly higher than your thumbs at the top — this internal rotation position maximally activates the medial delt.',
    bestExercises: [
      'Overhead Press (barbell or dumbbell) — best mass builder for anterior and medial delts',
      'Lateral Raise — primary isolation for medial delt width',
      'Cable Lateral Raise — better than dumbbells because tension is maintained at the bottom',
      'Face Pull — best exercise for the posterior delt (and also hits mid traps)',
      'Rear Delt Flye / Reverse Pec Deck — isolates the posterior delt',
      'Arnold Press — hits all three heads through the rotational arc',
    ],
    commonMistakes: 'Using momentum to swing lateral raises up — the traps and momentum do the work, not the medial delt. Also: neglecting the posterior delt. Most people press and raise but never pull backward. The posterior delt is crucial for shoulder balance and injury prevention.',
    growthTip: 'The medial delt (which creates the "wide shoulders" look) is only active when your arm is in a specific position relative to your torso. It is maximally active at about 90° of arm abduction (arm straight out to the side). Below that, the trap takes over; above that, the supraspinatus takes over. Lateral raises to exactly shoulder height are therefore the optimal range.',
    recoveryNote: 'Shoulders are involved in all pressing and pulling movements. They rarely get a true rest day unless you plan one. If you train chest, back, and shoulders across a week, your shoulders may actually be working 5 out of 7 days. Keep direct shoulder volume moderate (10–15 sets/week) and prioritize sleep for joint recovery.',
  },

  // ── Legs ─────────────────────────────────────────────────────────────────────
  {
    id: 'quads',
    name: 'Quadriceps Femoris',
    commonName: 'Quads',
    bodyRegion: 'Upper Leg · Front',
    emoji: '🦵',
    icon: 'footsteps-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-10.b1445ea1acf6.svg',
    tagColor: '#4A9EE8',
    shortDescription: 'Four muscles on the front of your thigh that extend (straighten) the knee. The largest muscle group in the body by mass.',
    location: 'Cover the entire front of the thigh, from the hip to just below the knee. The four heads are: rectus femoris (front, crosses the hip joint), vastus lateralis (outer thigh), vastus medialis (inner thigh, the "teardrop"), and vastus intermedius (deep, under the rectus femoris).',
    structure: 'The rectus femoris is unique — it crosses both the hip and the knee, which is why hip position affects quad activation during squats. The VMO (vastus medialis oblique, the teardrop shape just above the knee) is the final muscle to fire during knee extension and the first to weaken — it\'s critical for knee stability.',
    primaryFunction: 'Extension of the knee (straightening the leg). The rectus femoris also flexes the hip (raises the knee). The quads are the primary movers in squats, leg press, and any knee-dominant lower body exercise.',
    phases: {
      concentric: 'When you stand up from a squat, press a leg press away, or extend a leg curl machine, the quads are contracting — shortening to straighten the knee. The hardest point (sticking point) is usually just above parallel, where the quads have to generate maximum force to straighten the knee from a deeply bent position. At full extension, the quads are at their shortest — this is peak contraction.',
      eccentric: 'Descending into a squat is an eccentric quad contraction. Your quads are lengthening while under load, controlling the rate at which you descend. The eccentric portion of a squat (going down) is equally — if not more — important for quad development than the concentric (going up). Slow, controlled descents (3–4 seconds) dramatically increase quad hypertrophy stimulus. DOMS after leg day is almost entirely from the eccentric.',
      isometric: 'At the bottom of a squat hold (pause squat), the quads are isometrically contracting to maintain position against gravity. This builds strength in the weakest range and improves joint stability.',
    },
    howToFeel: 'Sit in a chair and extend one leg fully, squeezing the front of your thigh. Feel all four muscles on the front of your leg harden. Then slowly lower it — that controlled descent is exactly the eccentric contraction that builds quad size. During squats, focus on this same "front of thigh working" sensation.',
    mindMuscleConnection: 'Most people think of squats as a full-body movement and lose focus. For quad emphasis: narrow your stance slightly, keep your torso more upright, and focus on pushing your knees forward over your toes (forward knee travel increases quad activation). Think "knees forward, sit straight down" rather than "hips back."',
    bestExercises: [
      'Back Squat — most complete quad development, also trains glutes and hamstrings',
      'Front Squat — greater torso upright position = more quad activation',
      'Leg Press — high volume quad work with minimal spinal loading',
      'Bulgarian Split Squat — unilateral, high quad activation per leg',
      'Leg Extension — full isolation of the quads, especially the VMO',
      'Hack Squat — machine-based, very high quad activation with reduced back stress',
    ],
    commonMistakes: 'Cutting squat depth short ("high squats"). Partial depth means the quads never get a full stretch at the bottom, which reduces the growth stimulus. Full depth (hip crease below the top of the knee) is safe for most people when the technique is correct.',
    growthTip: 'The rectus femoris (the head that crosses the hip) is only fully stretched when the hip is extended AND the knee is flexed simultaneously — like at the top of a leg curl or during walking lunges. This is why the rectus femoris is often undertrained. Include exercises where your hip is extended during knee flexion for complete quad development.',
    recoveryNote: 'Quads are the largest muscle group and produce the most DOMS. After a heavy leg day, quads may be sore for 48–96 hours. Plan easy "active recovery" on off days (walking, cycling at low intensity) to clear metabolic waste and speed recovery.',
  },
  {
    id: 'hamstrings',
    name: 'Hamstrings',
    commonName: 'Hamstrings',
    bodyRegion: 'Upper Leg · Back',
    emoji: '🦿',
    icon: 'walk-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-11.54ef31755917.svg',
    tagColor: '#E86820',
    shortDescription: 'Three muscles on the back of your thigh responsible for bending the knee and extending the hip — critical for sprinting, jumping, and hip hinge movements.',
    location: 'Span the entire back of the thigh, from the sitting bones (ischial tuberosity of the pelvis) to just below the knee. The three muscles are: biceps femoris (outer, has two heads), semimembranosus (inner, deeper), and semitendinosus (inner, superficial). All three cross both the hip and knee joint.',
    structure: 'Because the hamstrings cross two joints, they are sensitive to the position of both the hip and knee. They are longest (and most active) when the hip is flexed AND the knee is extended simultaneously — like in the bottom of a Romanian deadlift. This dual-joint nature makes them uniquely prone to strain when rapidly stretching and contracting (as in sprinting).',
    primaryFunction: 'Knee flexion (bending the leg). Hip extension (driving the hip forward, as in standing from a deadlift). The hamstrings also assist in tibial rotation. They are the primary movers in hip hinge exercises and assist the glutes in all hip extension movements.',
    phases: {
      concentric: 'In a leg curl, the hamstrings contract to pull the heel toward the glutes — shortening across the knee joint. In a deadlift or hip thrust, the hamstrings (with the glutes) contract to drive the hips from flexed to extended. At full hip extension (lockout at the top of a deadlift), the hamstrings are at their shortest.',
      eccentric: 'The eccentric phase for hamstrings is particularly important — and particularly productive for growth. In a Romanian deadlift, lowering the weight means the hamstrings are lengthening under load as the hip flexes. Research shows eccentric-only hamstring training (Nordic curls) is one of the most effective hypertrophy and injury-prevention protocols. The stretch at the bottom of an RDL is a powerful growth signal.',
      isometric: 'During a deadlift, the hamstrings isometrically maintain the bent-knee angle throughout the lift, preventing the knees from buckling. During sprinting, the hamstrings have a brief isometric hold right before footstrike to control the leg\'s forward swing.',
    },
    howToFeel: 'Stand up and bend your knee slightly, pulling your heel toward your glute — feel the back of your thigh engage. For a hip extension component, lean forward at the hip while keeping your back straight — feel the hamstrings stretch as you lean forward and contract as you return upright. This is the basic pattern of a Romanian deadlift.',
    mindMuscleConnection: 'On leg curls, most people use too much momentum and jerk the weight. Instead: very slowly curl the heel toward the glutes (2 seconds up), pause and squeeze for 1 second at the top, then lower over 3 seconds. At the bottom, let the weight fully extend before curling again. This deliberate tempo completely changes the exercise.',
    bestExercises: [
      'Romanian Deadlift — best hamstring exercise for hypertrophy (maximizes hip flexion stretch)',
      'Nordic Curl — extraordinary eccentric hamstring exercise for size and injury prevention',
      'Lying Leg Curl — isolation with constant tension throughout the range',
      'Seated Leg Curl — unique advantage: hip is flexed during the exercise, stretching the hamstrings MORE at the start',
      'Good Morning — excellent hip hinge pattern for hamstring loading',
      'Stiff-Leg Deadlift — similar to RDL but legs mostly straight',
    ],
    commonMistakes: 'Rounding the lower back during Romanian deadlifts to reach further down. This removes tension from the hamstrings and loads the spine. Hinge at the hip and maintain a neutral spine — go only as far down as you can with a flat back.',
    growthTip: 'The seated leg curl is underrated. Because the hip is flexed during the exercise, the hamstrings start in an even more stretched position than in the lying version — research shows this increases muscle damage and growth signal. Include at least one seated variation per week.',
    recoveryNote: 'Hamstrings are the most commonly strained muscle in athletes. Proper warm-up, avoiding ballistic stretching cold muscles, and progressive overloading (not sudden jumps in weight) are critical. If you feel a sharp pull in the back of your thigh during exercise, stop immediately.',
  },
  {
    id: 'glutes',
    name: 'Gluteus Maximus',
    commonName: 'Glutes',
    bodyRegion: 'Hips · Glutes',
    emoji: '🍑',
    icon: 'ellipse-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-8.fbdfb46f3bc0.svg',
    tagColor: '#D4A843',
    shortDescription: 'The largest and most powerful muscle in the human body. Essential for hip extension, stabilizing the pelvis, and generating power in every lower body movement.',
    location: 'Covers the back of the pelvis and upper thigh. Originates from the posterior ilium (back of the pelvic bone), sacrum, and coccyx (tailbone). Inserts on the gluteal tuberosity of the femur and the iliotibial band (IT band). The gluteus medius and minimus sit above and to the side of the maximus, abducting the leg and stabilizing the pelvis.',
    structure: 'The gluteus maximus has two primary fiber directions — upper fibers and lower fibers — that are somewhat differently recruited depending on hip angle. The upper fibers work more during hip abduction (like side-lying raises). The lower fibers are the main drivers of hip extension. The gluteus medius (the outer hip muscle) is crucial for single-leg stability and pelvic alignment during walking and squatting.',
    primaryFunction: 'Hip extension (driving the hip from flexed to neutral/extended — like standing up from a deadlift). Hip external rotation (turning the foot outward). Hip abduction (moving the leg out to the side). The glutes are primary movers in all running, jumping, climbing, and heavy lifting.',
    phases: {
      concentric: 'In a hip thrust, the glutes contract powerfully to drive the hips from the floor to full extension. The key action is the pelvis posteriorly tilting while the hip extends — essentially "squeezing your glutes as hard as possible" at lockout. In squats, the glutes contribute most in the lower third of the movement and at lockout. In deadlifts, the glutes drive hip extension in the top half.',
      eccentric: 'Lowering from a hip thrust or descending into a squat: the glutes lengthen under load, controlling the rate of hip flexion. In a split squat, the rear leg glute stretches at the bottom of the movement. The loaded stretch of the glute is a key growth stimulus — full range of motion is essential.',
      isometric: 'During single-leg exercises (step-ups, lunges), the glutes of the working leg isometrically prevent the pelvis from dropping on the opposite side. This pelvis-stabilizing function of the gluteus medius is often the weakest link for people with knee pain.',
    },
    howToFeel: 'Lie on your back, knees bent, feet flat on the floor. Bridge your hips up by squeezing your glutes as hard as possible. Feel the top of your butt (not your lower back) doing the work. If you feel it more in your lower back than your glutes, you\'re likely hyperextending. Squeeze the glutes — don\'t just push the hips up.',
    mindMuscleConnection: 'Many people feel squats and deadlifts in their quads and back rather than their glutes. To shift focus to glutes: widen your stance slightly, point your toes outward 30–45°, and think about "pushing the floor apart" with your feet (this cue promotes external rotation which activates the glutes). At the top of any hip extension exercise, squeeze the glutes hard and hold for 1 second.',
    bestExercises: [
      'Barbell Hip Thrust — highest glute EMG of any exercise; go heavy',
      'Back Squat (wide stance) — great glute activation especially in the bottom third',
      'Romanian Deadlift — loads the glutes in a stretched position',
      'Bulgarian Split Squat — one of the best single-leg glute exercises',
      'Cable Kickback — isolates the glute without quad involvement',
      'Glute Bridge / Hip Thrust with band — for activation and higher rep work',
    ],
    commonMistakes: 'Not reaching full hip extension. Many people stop short of locking out at the top of hip thrusts and squats — this means the glutes never reach peak contraction. Also: letting the lower back hyperextend at lockout instead of squeezing the glutes. You should feel the squeeze in the glutes, not a pinch in the lower back.',
    growthTip: 'The glutes respond well to both heavy compound work AND higher-rep isolation. Combine hip thrusts (3–5 sets of 8–12 reps, heavy) with banded work or cable kickbacks (3 sets of 15–25 reps) in the same session for optimal stimulus. The glutes have a high proportion of fast-twitch fibers (respond to heavy loading) AND slow-twitch fibers (respond to volume).',
    recoveryNote: 'The glutes are large and recover quickly relative to their size. Most people can train them directly 2–4 times per week. They also recover well with active movement — walking, cycling — because these activities use the glutes at low intensity which promotes blood flow.',
  },

  // ── Core ─────────────────────────────────────────────────────────────────────
  {
    id: 'core',
    name: 'Rectus Abdominis & Core Complex',
    commonName: 'Core / Abs',
    bodyRegion: 'Abdomen & Torso',
    emoji: '🔩',
    icon: 'radio-button-on-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-6.592f938fa8c7.svg',
    tagColor: '#20A8A0',
    shortDescription: 'The core is not just "abs" — it\'s a complex of deep and surface muscles that stabilize the spine, transfer force between the upper and lower body, and control intra-abdominal pressure.',
    location: 'The core includes the rectus abdominis (front, the "six pack"), external and internal obliques (sides), transverse abdominis (the deepest layer, like a corset), erector spinae (the back column muscles), and the multifidus (deep spine stabilizers).',
    structure: 'The rectus abdominis runs vertically from the pubic bone to the sternum. It is interrupted by tendinous intersections (the bands that create the "six pack" appearance). The obliques run diagonally. The transverse abdominis is the deepest layer — it wraps around the entire torso like a belt and is responsible for spinal stability and the "bracing" action used during heavy lifts.',
    primaryFunction: 'Spinal flexion (crunching the torso forward — rectus abdominis). Lateral flexion (bending sideways — obliques). Rotation of the torso (obliques). Anti-rotation and spinal stabilization (deep core, transverse abdominis). The deep core provides the cylinder of pressure that protects the spine during all loaded movements.',
    phases: {
      concentric: 'In a crunch, the rectus abdominis contracts to flex the spine, drawing the ribcage toward the pelvis. In a cable rotation, the obliques contract to rotate the torso. In a hanging leg raise, the hip flexors initiate the movement while the lower rectus abdominis stabilizes the pelvis. Key: the "ab flex" is a spinal flexion — the ribcage should move toward the pelvis, not just the head moving forward.',
      eccentric: 'The controlled lowering in a crunch lets the abs lengthen. In a cable rotation, returning to the start position is the eccentric phase. Slow, controlled returns greatly increase time under tension and hypertrophy stimulus. Full extension (lying flat with abs stretched) before each crunch rep allows a complete eccentric range.',
      isometric: 'Planks are almost entirely isometric core work. The transverse abdominis braces to prevent the spine from sagging. The obliques prevent lateral rotation. During heavy squats and deadlifts, the bracing (Valsalva maneuver) is an intense isometric core contraction — arguably the most important core function in strength training.',
    },
    howToFeel: 'Stand up and cough — feel the deep tightening across your entire midsection. That is your transverse abdominis bracing. This is the contraction you need during all heavy lifts. Another: try to "pull your belly button toward your spine" without holding your breath. The tension you feel is the TA activating.',
    mindMuscleConnection: 'For visible ab development, two things matter: (1) reducing body fat through diet, and (2) building the rectus abdominis to increase size. For the best muscle contraction during crunches, think of "bringing your ribcage to your pelvis" rather than "lifting your head." The abs only pull from where they attach — the sternum and ribs moving toward the pubic bone.',
    bestExercises: [
      'Cable Crunch — allows progressive overload (add weight like any other muscle)',
      'Hanging Leg Raise — high hip flexor AND lower ab activation with full range',
      'Ab Wheel Rollout — advanced, huge anti-extension core challenge',
      'Plank — best for deep core and transverse abdominis bracing endurance',
      'Pallof Press — anti-rotation strength, trains core stability under load',
      'Bicycle Crunch — hits both rectus and obliques through rotation',
    ],
    commonMistakes: 'Ignoring the deep core and only doing surface crunches. True core stability (especially for spine health) comes from the transverse abdominis, not the six-pack. Bracing before every heavy set is a core exercise. Also: pulling on the neck during crunches — this indicates the abs are not doing the work.',
    growthTip: 'The rectus abdominis is a muscle — it responds to progressive overload like any other. Add weight to cable crunches, use a heavier ab wheel, or move to more advanced hanging leg variations. Endlessly doing bodyweight crunches without increasing difficulty will not build visible abs (diet determines whether they are visible).',
    recoveryNote: 'The deep stabilizing muscles (transverse abdominis, multifidus) can be trained daily because they primarily function isometrically and recover quickly. The rectus abdominis and obliques should be treated like any other muscle — 48 hours between direct training sessions. Bracing during squats and deadlifts trains the core intensely even on "non-ab days."',
  },

  // ── Calves ───────────────────────────────────────────────────────────────────
  {
    id: 'calves',
    name: 'Gastrocnemius & Soleus',
    commonName: 'Calves',
    bodyRegion: 'Lower Leg · Back',
    emoji: '🦶',
    icon: 'resize-outline',
    svgUrl: 'https://wger.de/static/images/muscles/main/muscle-7.edbd8c381b0c.svg',
    tagColor: '#40D8C0',
    shortDescription: 'Two distinct muscles that together form the calf. They are responsible for plantarflexion (pointing the foot) and are critical for walking, running, and jumping.',
    location: 'Gastrocnemius: the outer, visible muscle, originates from behind the femur (above the knee joint) and inserts via the Achilles tendon to the heel bone. Soleus: lies beneath the gastrocnemius, originates from the tibia and fibula (below the knee joint). Both insert on the Achilles tendon.',
    structure: 'The distinction between these two muscles determines what exercises work them best. Because the gastrocnemius crosses the knee joint, it is fully activated only when the knee is straight (like a standing calf raise). When the knee is bent, the gastrocnemius is already shortened across the knee and is less effective — which is when the soleus takes over. The soleus is often underdeveloped and actually makes up the majority of the calf\'s mass.',
    primaryFunction: 'Plantarflexion (pointing the foot downward, like pressing a gas pedal). Assists in knee flexion (gastrocnemius). The soleus also assists with blood circulation by pumping blood from the legs back toward the heart — it\'s sometimes called the "second heart."',
    phases: {
      concentric: 'When you rise up on your toes, the calf muscles contract and shorten, pulling the heel upward. In a standing calf raise, you go from the foot flat on the ground to rising onto the ball of the foot. The peak contraction is at the top — the heel as high as possible, toes pressing into the surface.',
      eccentric: 'Lowering the heel BELOW the starting position (if using a step or platform) provides a deep calf stretch. This full eccentric range (heel dropping below the toes) is where much of the calf growth stimulus comes from. Many people skip this by doing partial calf raises. The eccentric stretch should be slow and controlled (2–3 seconds).',
    },
    howToFeel: 'Simply rise up on your toes — feel the two muscles on the back of your lower leg tighten. For the soleus specifically: sit in a chair, feet flat, then rise up on your toes while staying seated. Because the knee is bent, the gastrocnemius is shortened and the soleus has to do most of the work.',
    mindMuscleConnection: 'Calves are notoriously hard to grow because most people do fast, partial reps. Instead: use a full range of motion (heel fully lowered below the step, then fully raised), go slow on the way down (3 seconds), pause briefly at the bottom for a stretch, then raise deliberately. 15–20 slow, full reps will challenge the calves far more than 30 bouncy partial reps.',
    bestExercises: [
      'Standing Calf Raise — gastrocnemius emphasis (knee straight)',
      'Seated Calf Raise — soleus emphasis (knee bent) — often neglected and crucial',
      'Donkey Calf Raise — hip-hinged position stretches the gastrocnemius more',
      'Single-Leg Calf Raise — greater stretch per leg, harder to cheat',
      'Leg Press Calf Raise — allows very heavy loading safely',
      'Jump Rope — high-frequency calf stimulus through athletic movement',
    ],
    commonMistakes: 'Doing only standing calf raises. This primarily trains the gastrocnemius and neglects the soleus — which can make up 60–70% of the calf muscle mass. Include seated calf raises in every calf session.',
    growthTip: 'Calves respond well to high frequency (3–5 days per week) and high rep ranges (15–25 reps) because of their high proportion of slow-twitch muscle fibers. They are also under-recovered by most gym-goers because walking and standing throughout the day means they never fully rest. Consider doing calf work at the START of a session when they are fresh, not at the end.',
    recoveryNote: 'Calves are used constantly in daily life (walking, standing) so they are in a permanent state of mild use. True deep DOMS in calves (after hill running or very intense calf training) can last 3–5 days. The Achilles tendon and plantar fascia can become strained with excessive sudden loading — increase calf training volume gradually.',
  },
];

/** Group muscle entries by body region for display. */
export function getMusclesByRegion(): Record<string, MuscleEntry[]> {
  const regions: Record<string, MuscleEntry[]> = {};
  for (const m of MUSCLE_LIBRARY) {
    const region = m.bodyRegion.split(' · ')[0]; // e.g. "Upper Arm" → "Upper Arm"
    if (!regions[region]) regions[region] = [];
    regions[region].push(m);
  }
  return regions;
}
