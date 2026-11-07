'use strict';
/* Idle for Rhythia clone: balance and content tables. Everything tunable lives here. */

const CONFIG = {
  saveKey: 'rhythiaIdleClone.save.v1',
  settingsKey: 'rhythiaIdleClone.settings.v1',
  offlineCapHours: 8,
  health: 100,
  hitHeal: 1.5,
  missesToFail: 6,
  rpWeight: 0.97,
  rpMaxPlays: 99,
  seasonMinRp: 3500,
  xpBase: 10,
  maxLvl: 120,
  xpGain: 0.5,
  xpGrowth: 1.25,
  missXp: 0.3,
  patternXp: 1.5,
  gearMult: 1.22,
  speedMissExp: 3,
  nextPause: 4,
};

const TIERS = [
  { id: 'beginner', name: 'Beginner', min: 0, max: 3, color: '#5be37d' },
  { id: 'intermediate', name: 'Intermediate', min: 3, max: 5, color: '#ffd54f' },
  { id: 'hard', name: 'Hard', min: 5, max: 7, color: '#ff8a3d' },
  { id: 'expert', name: 'Expert', min: 7, max: Infinity, color: '#ff4f6d' },
];

const RANKS = [
  { name: 'Novice', rp: 0, color: '#7ed957', range: 'Below 1,500 RP' },
  { name: 'Expert', rp: 1500, color: '#1ba6c2', range: '1,500 to 2,499 RP' },
  { name: 'Candidate Master', rp: 2500, color: '#d2793a', range: '2,500 to 4,999 RP' },
  { name: 'Master', rp: 5000, color: '#c8473c', range: '5,000 to 9,999 RP' },
  { name: 'Candidate Grandmaster', rp: 10000, color: '#9b59b6', range: '10,000 RP and up' },
  { name: 'Grandmaster', rp: 10000, top: 30, color: '#ffffff', range: 'Top 30 (Global)' },
];
const GRANDMASTER_TOP = 30;

const SPEEDS = [0.75, 0.8, 0.87, 1, 1.15, 1.25, 1.35, 1.45, 1.55, 1.65, 1.8, 2]
  .map(rate => ({ rate, label: rate + '×', shard: rate > 1.45 ? String(rate) : null }));

/* Mods. `points` multiplies points; `stars` multiplies the star rating for RP. */
const MODS = [
  { id: 'nofail', short: 'NF', name: 'No Fail', color: '#5be37d', points: 0.5, excludes: ['sd'], tip: 'Infinite health', effect: 'No skill XP. Each miss cuts the map stars by 5% for RP. Points ×0.5.' },
  { id: 'sd', short: 'SD', name: 'Sudden Death', color: '#ff4f6d', points: 1.4, excludes: ['nofail'], tip: 'One miss fails the map', effect: 'Points ×1.4. Double Consistency XP, ×1.5 Aim, Precision and Reading XP, Stamina trains on every note.' },
  { id: 'hr', short: 'HR', name: 'Hard Rock', color: '#ff8a3d', points: 1.4, stars: 1.12, excludes: ['hr2', 'ez'], tip: 'Smaller hitbox, bigger playfield', effect: 'Stars ×1.12 for RP. Points ×1.4, double Precision XP.' },
  { id: 'hr2', short: 'HR+', name: 'Hard Rock+', color: '#ff5a3d', points: 1.7, stars: 1.2, excludes: ['hr', 'ez'], shard: 'hr2', tip: 'An even smaller hitbox and bigger playfield', effect: 'Stars ×1.2 for RP. Points ×1.7, triple Precision XP.' },
  { id: 'ghost', short: 'GH', name: 'Ghost', color: '#c38bff', points: 1.3, stars: 1.08, excludes: ['ghost2'], tip: 'Notes vanish near the cursor', effect: 'Stars ×1.08 for RP. Points ×1.3. ×2.5 Reading XP, ×1.3 Precision and Consistency XP.' },
  { id: 'ghost2', short: 'GH+', name: 'Ghost+', color: '#a070ff', points: 1.6, stars: 1.15, excludes: ['ghost'], shard: 'ghost2', tip: 'Notes vanish much sooner', effect: 'Stars ×1.15 for RP. Points ×1.6. ×4 Reading XP, ×1.5 Precision and Consistency XP.' },
  { id: 'chaos', short: 'CH', name: 'Chaos', color: '#ff8fc8', points: 1.15, excludes: ['chaos2'], tip: 'Notes drift into place', effect: 'Points ×1.15. ×1.5 Reading XP, ×1.3 Aim and Consistency XP.' },
  { id: 'chaos2', short: 'CH+', name: 'Chaos+', color: '#ff5fae', points: 1.3, excludes: ['chaos'], shard: 'chaos2', tip: 'Notes drift in from twice as far', effect: 'Points ×1.3. ×2.2 Reading XP, ×1.5 Aim and Consistency XP.' },
  { id: 'spin', short: '360', name: '360', color: '#5fd4ff', points: 1.15, excludes: ['spin2'], tip: 'The playfield rotates', effect: 'Points ×1.15. ×1.5 Aim XP, ×1.3 Reading XP, Spins trains on every note.' },
  { id: 'spin2', short: '360+', name: '360+', color: '#2fb4ff', points: 1.3, excludes: ['spin'], shard: 'spin2', tip: 'The playfield rotates twice as fast', effect: 'Points ×1.3. ×2.2 Aim XP, ×1.5 Reading XP, Spins trains twice as much.' },
  { id: 'ez', short: 'EZ', name: 'Easy', color: '#9be3a8', points: 0.5, stars: 0.8, excludes: ['hr', 'hr2', 'pf', 'ac'], tip: 'Bigger hitbox, smaller playfield, misses cost half', effect: 'Stars ×0.8 for RP. Points ×0.5, half the XP.' },
  { id: 'pf', short: 'PF', name: 'Perfect', color: '#ffd166', points: 1.5, stars: 1.04, excludes: ['sd', 'nofail', 'ac', 'ez'], shard: 'pf', tip: 'One miss fails and the hitbox is smaller', effect: 'Stars ×1.04 for RP. Points ×1.5. Double Consistency XP, ×1.8 Precision XP.' },
  { id: 'ac', short: 'AC', name: 'Accuracy Challenge', color: '#f4a261', points: 1.15, excludes: ['nofail', 'pf', 'ez'], shard: 'ac', tip: 'Fails once accuracy drops under 95%', effect: 'Points ×1.15. ×1.6 Consistency XP.' },
  { id: 'fl', short: 'FL', name: 'Flashlight', color: '#ffe08a', points: 1.5, stars: 1.12, shard: 'fl', tip: 'Only the area around the cursor is visible', effect: 'Stars ×1.12 for RP. Points ×1.5. ×3 Reading XP.' },
  { id: 'bl', short: 'BL', name: 'Blinds', color: '#b9c4d6', points: 1.3, stars: 1.05, shard: 'bl', tip: 'Misses close blinds over the playfield', effect: 'Stars ×1.05 for RP. Points ×1.3. ×1.8 Reading XP, ×1.3 Consistency XP.' },
  { id: 'fi', short: 'FI', name: 'Fade In', color: '#9ad0ff', points: 1.3, stars: 1.06, excludes: ['co'], shard: 'fi', tip: 'Notes appear late in their approach', effect: 'Stars ×1.06 for RP. Points ×1.3. Double Reading XP.' },
  { id: 'co', short: 'CO', name: 'Cover', color: '#8fb3c9', points: 1.15, stars: 1.03, excludes: ['fi'], shard: 'co', tip: 'The far part of the approach is covered', effect: 'Stars ×1.03 for RP. Points ×1.15. ×1.5 Reading XP.' },
  { id: 'st', short: 'ST', name: 'Strict Tracking', color: '#7ee0d2', points: 1.2, stars: 1.04, shard: 'st', tip: 'Slower aim, slides miss twice as often', effect: 'Stars ×1.04 for RP. Points ×1.2. ×1.5 Aim XP, double Slides XP.' },
  { id: 'mirror', short: 'MR', name: 'Mirror', color: '#7fe0c4', points: 1, cycle: ['Off', 'Horizontal', 'Vertical', 'Double'], tip: 'Flips the playfield', effect: 'Looks different, plays the same.' },
  { id: 'anon', short: 'AN', name: 'Anonymous', color: '#ffd54f', points: 1, tip: 'Keeps plays off the leaderboard', effect: 'Plays stay off the map boards.' },
];
const MOD_GROUPS = [
  { name: 'Difficulty', ids: ['nofail', 'ez', 'sd', 'pf', 'ac'] },
  { name: 'Harder', ids: ['hr', 'hr2', 'ghost', 'ghost2', 'chaos', 'chaos2', 'spin', 'spin2'] },
  { name: 'Vision', ids: ['fl', 'bl', 'fi', 'co', 'st'] },
  { name: 'Other', ids: ['mirror', 'anon'] },
];
const MOD_FX = {
  hitbox: { hr: 0.9, hr2: 0.8, ez: 1.25, pf: 0.95 },
  field: { hr: 1.25, hr2: 1.38, ez: 0.87 },
  read: { ghost: 0.85, ghost2: 0.75, chaos: 0.9, chaos2: 0.8, fl: 0.8, fi: 0.88, co: 0.94 },
  aim: { spin: 0.9, spin2: 0.8, st: 0.9 },
  blindRead: 0.3, acLine: 0.95, acFrom: 20, spinRate: 0.35, spin2Rate: 0.7,
};

/* Pattern bits carried by each generated note. */
const P = { jumps: 1, stacks: 2, slides: 4, streams: 8, bursts: 16, walls: 32, spins: 64, vibros: 128, quantum: 256, offgrid: 512, stamina: 1024, oneshot: 2048, techs: 4096, unconv: 8192 };

const SKILLS = [
  { id: 'aim', name: 'Aim', color: '#8aa4ff', core: true, blurb: 'How fast the cursor reaches the next note.', trains: 'every note, more on long moves' },
  { id: 'precision', name: 'Precision', color: '#5fd4ff', core: true, blurb: 'How far off-centre a hit can land.', trains: 'every note' },
  { id: 'reading', name: 'Reading', color: '#c38bff', core: true, blurb: 'How dense a section can get before it turns into noise.', trains: 'dense sections and speed mods' },
  { id: 'consistency', name: 'Consistency', color: '#5be37d', core: true, blurb: 'How often you miss for no reason at all.', trains: 'holding long combos' },
  { id: 'stamina', name: 'Stamina', color: '#ff8a3d', bits: P.stamina, blurb: 'Long dense sections and long maps.', trains: 'stamina sections, long maps, speed-ups and Sudden Death' },
  { id: 'jumps', name: 'Jumps', color: '#ffd54f', bits: P.jumps, blurb: 'Notes far apart from each other.', trains: 'jumps' },
  { id: 'streams', name: 'Streams', color: '#ff8fc8', bits: P.streams, blurb: 'Long runs of notes one after another.', trains: 'streams' },
  { id: 'slides', name: 'Slides', color: '#7fe0c4', bits: P.slides, blurb: 'Short runs swept through in one motion.', trains: 'slides' },
  { id: 'bursts', name: 'Bursts', color: '#ff6b9a', bits: P.bursts | P.walls, blurb: 'Very short, very dense runs, up to full walls.', trains: 'bursts and walls' },
  { id: 'spins', name: 'Spins', color: '#9ad1ff', bits: P.spins, blurb: 'Notes turning around the edges of the grid.', trains: 'spins' },
  { id: 'vibros', name: 'Vibros', color: '#ffb36b', bits: P.vibros, blurb: 'Fast flicks back and forth between two sides.', trains: 'vibros' },
  { id: 'stacks', name: 'Stacks', color: '#b8b8d0', bits: P.stacks, blurb: 'Notes stacked one behind another.', trains: 'stacks' },
  { id: 'quantum', name: 'Quantum', color: '#d38bff', bits: P.quantum | P.offgrid, blurb: 'Notes off the grid lines, or outside the grid.', trains: 'quantum and off-grid notes' },
];
const ASC_SKILLS = [
  { id: 'oneshot', name: 'One Shot', color: '#ff7a7a', bits: P.oneshot, asc: true, blurb: 'Notes where one miss ends the play.', trains: 'one-shot notes, Sudden Death and low health' },
  { id: 'techs', name: 'Techs', color: '#7fd0ff', bits: P.techs, asc: true, blurb: 'Unusual patterns that fit no other kind.', trains: 'techs' },
  { id: 'unconv', name: 'Unconventional', color: '#e0a3ff', bits: P.unconv, asc: true, blurb: 'Whole sections of very unusual patterns.', trains: 'unconventional sections' },
];
const SKILL_GROUPS = [
  { id: 'core', name: 'Fundamentals', ids: ['aim', 'precision', 'reading', 'consistency'] },
  { id: 'speed', name: 'Speed', ids: ['stamina', 'streams', 'bursts', 'vibros'] },
  { id: 'flow', name: 'Movement', ids: ['jumps', 'slides', 'spins'] },
  { id: 'place', name: 'Timing & space', ids: ['stacks', 'quantum'] },
];
const ASC_GROUP = { id: 'asc', name: 'Ascended', ids: ['oneshot', 'techs', 'unconv'] };

/* Gear: 15 tiers per skill, each multiplies that skill's XP. Names are flavour. */
const GEAR = {
  aim: ['Budget mouse', 'Light mouse', 'Esports mouse', 'Hollow shell', 'Soft cable', 'Wireless receiver', 'High polling', 'Ultra polling', 'Slick feet', 'Cable holder', 'Tuned firmware', 'Carbon body', 'Drawing tablet', 'Area tuning', 'Signature edition'],
  precision: ['Stock sensitivity', 'Tuned sensitivity', 'Raw input', 'Accel off', 'DPI sweep', 'Sens calculator', 'Glass skates', 'Cloth surface', 'Glass surface', 'Custom cursor', 'Tiny cursor', 'Centre pip', 'Hairline cross', 'Pixel grid', 'Steady hands'],
  reading: ['60Hz screen', '75Hz screen', '144Hz screen', '165Hz screen', '240Hz screen', 'Low-lag mode', 'Strobe mode', '280Hz screen', '360Hz screen', 'Monitor arm', 'Eye-level stand', '480Hz screen', 'OLED panel', 'Dim room', 'Instant reads'],
  consistency: ['Warm-up map', 'Warm-up list', 'Daily routine', 'Practice diary', 'Replay study', 'Accuracy targets', 'Session clock', 'Fixed chair', 'Fixed desk', 'Weekly plan', 'Duo partner', 'Private coach', 'Tourney prep', 'Calm mind', 'Muscle routine'],
  stamina: ['Energy can', 'Water bottle', 'Real breaks', 'Good snacks', 'Stretch set', 'Ergo chair', 'Desk fan', 'Sleep plan', 'Morning walk', 'Morning jog', 'Grip trainer', 'Forearm set', 'Gym plan', 'Marathon maps', 'Iron wrist'],
  jumps: ['Small pad', 'Medium pad', 'Large pad', 'XL pad', 'Desk mat', 'Wider desk', 'Arm sleeve', 'Speed pad', 'Elbow rest', 'Jump drills', 'Flick trainer', 'Long-jump maps', 'Shoulder aim', 'Snap reflex', 'Blink hands'],
  streams: ['Metronome', 'Stream map', 'Tap trainer', 'Wrist brace', 'BPM ladder', 'Finger drills', 'Arm aim', 'Wrist aim', 'Hybrid aim', 'Long streams', 'Loose wrist', 'Death streams', 'Speed tuning', 'Muscle memory', 'Endless flow'],
  slides: ['Palm grip', 'Fingertip grip', 'Claw grip', 'Relaxed claw', 'Slide drills', 'Glide pad', 'Loose wrist', 'Curve practice', 'Path tracing', 'Arm flow', 'Slider maps', 'Light touch', 'Steady hand', 'Fluid motion', 'Liquid aim'],
  bursts: ['Coffee', 'Espresso', 'Burst drills', 'Reaction app', 'Click timing', 'Fast-twitch set', 'Wall map', 'Snap drills', 'Short bursts', 'Light switches', 'Speed trainer', 'Reflex games', 'Adrenaline', 'Lightning hands', 'Zero delay'],
  spins: ['Circle drills', 'Spin map', 'Shoulder warm-up', 'Round pad', 'Wide arm', 'Elbow pivot', 'Clockwise set', 'Anticlockwise set', 'Spiral maps', 'Orbit training', 'Spin ladder', 'Centrifuge', 'Gyro wrist', 'Spin instinct', 'Tornado arm'],
  vibros: ['Jitter drills', 'Tight grip', 'Featherweight mouse', 'Vibro map', 'Short-range set', 'Tense forearm', 'Micro moves', 'Shake control', 'Vibro ladder', 'Tremor control', 'Fine motor set', 'Steel fingers', 'Buzz maps', 'Hummingbird hands', 'Perfect jitter'],
  stacks: ['Patience', 'Stack drills', 'Timing app', 'Offset tuning', 'Sharp eyes', 'Beat counting', 'Rhythm games', 'Drum lessons', 'Stack maps', 'Still cursor', 'Rhythm sense', 'Inner clock', 'Perfect timing', 'Metronome mind', 'Frame-perfect'],
  quantum: ['Grid skin', 'Quantum map', 'Cursor trail', 'Off-grid drills', 'Spatial drills', 'Depth sense', 'Grid-free reads', 'Quantum maps', 'Coordinate memory', 'Fractional aim', 'Side vision', 'Pattern intuition', 'Spatial memory', 'Sixth sense', 'Quantum mind'],
  oneshot: ['Deep breath', 'Steady pulse', 'Calm hands', 'Focus drills', 'Pressure practice', 'Clutch maps', 'Pulse monitor', 'No-retry runs', 'Final-note drills', 'Ice water', 'Tourney nerves', 'Sudden Death ladder', 'Cold blood', 'Unshaken', 'One and done'],
  techs: ['Pattern notebook', 'Odd-rhythm drills', 'Tech map', 'Slow replays', 'Rhythm breakdowns', 'Angle drills', 'Swing practice', 'Tech ladder', 'Mapper study', 'Improv sessions', 'Reflex reads', 'Off-beat sense', 'Tech maps', 'Adaptive hands', 'Read anything'],
  unconv: ['Open mind', 'Weird-map nights', 'Gimmick practice', 'Odd-section drills', 'Pattern library', 'Section loops', 'Mapper talks', 'Experimental maps', 'Chaos tolerance', 'Strange charts', 'Section memory', 'Wild reads', 'Unusual mastery', 'Anything goes', 'Unconventional mind'],
};
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/* Craft: four technique nodes per skill, each working in its own moment. [name, when, amount, text] */
const CRAFT = {
  aim: [['Loose grip', 'always', 0.04, 'Cursor 4% faster'], ['Second wind', 'after', 0.1, 'Cursor 10% faster after a miss'], ['Locked in', 'combo', 0.08, 'Cursor 8% faster on a 100+ combo'], ['Spin doctor', 'spin', 0.12, 'Cursor 12% faster with 360']],
  precision: [['Light touch', 'always', 0.03, 'Hitbox 3% bigger'], ['Settled', 'warm', 0.06, 'Hitbox 6% bigger when warm'], ['Needle', 'hr', 0.08, 'Hitbox 8% bigger on Hard Rock'], ['Last stand', 'end', 0.08, 'Hitbox 8% bigger near the end']],
  reading: [['Wide eyes', 'always', 0.04, 'Reads 4% denser'], ['Fresh eyes', 'start', 0.08, 'Reads 8% denser early on'], ['Dark room', 'ghost', 0.1, 'Reads 10% denser on Ghost'], ['Quick eyes', 'fast', 0.08, 'Reads 8% denser sped up']],
  consistency: [['Calm', 'always', 0.05, '5% fewer random misses'], ['In the zone', 'combo', 0.15, '15% fewer on a 100+ combo'], ['Shrug it off', 'after', 0.2, '20% fewer after a miss'], ['Closer', 'end', 0.15, '15% fewer near the end']],
  stamina: [['Pace yourself', 'later', 0.1, 'Tires 10% later'], ['Deep breath', 'always', 0.08, '8% fewer tired misses'], ['Second lungs', 'end', 0.2, '20% fewer tired near the end'], ['Warm engine', 'warm', 0.12, '12% fewer tired when warm']],
  jumps: [['Spring step', 'always', 0.06, '6% fewer jump misses'], ['Long reach', 'warm', 0.12, '12% fewer when warm'], ['Rebound', 'after', 0.2, '20% fewer after a miss'], ['Big finish', 'end', 0.15, '15% fewer near the end']],
  streams: [['Even hands', 'always', 0.06, '6% fewer stream misses'], ['Locked tempo', 'combo', 0.15, '15% fewer on a 100+ combo'], ['Regroup', 'after', 0.2, '20% fewer after a miss'], ['Kick', 'end', 0.15, '15% fewer near the end']],
  slides: [['Smooth sweep', 'always', 0.06, '6% fewer slide misses'], ['Glide', 'warm', 0.12, '12% fewer when warm'], ['Recover', 'after', 0.2, '20% fewer after a miss'], ['Flowing', 'combo', 0.15, '15% fewer on a 100+ combo']],
  bursts: [['Snap', 'always', 0.06, '6% fewer burst misses'], ['Fast twitch', 'fast', 0.15, '15% fewer sped up'], ['Reset', 'after', 0.2, '20% fewer after a miss'], ['Final push', 'end', 0.15, '15% fewer near the end']],
  spins: [['Orbit', 'always', 0.06, '6% fewer spin misses'], ['Steady head', 'combo', 0.15, '15% fewer on a 100+ combo'], ['Re-centre', 'after', 0.2, '20% fewer after a miss'], ['Whirl', 'fast', 0.15, '15% fewer sped up']],
  vibros: [['Jitter', 'always', 0.06, '6% fewer vibro misses'], ['Tremor', 'fast', 0.15, '15% fewer sped up'], ['Shake it off', 'after', 0.2, '20% fewer after a miss'], ['Hold steady', 'combo', 0.15, '15% fewer on a 100+ combo']],
  stacks: [['Double tap', 'always', 0.06, '6% fewer stack misses'], ['Rhythm sense', 'warm', 0.12, '12% fewer when warm'], ['Re-stack', 'after', 0.2, '20% fewer after a miss'], ['Stack up', 'end', 0.15, '15% fewer near the end']],
  quantum: [['Off-grid eye', 'always', 0.06, '6% fewer quantum misses'], ['Free hand', 'combo', 0.15, '15% fewer on a 100+ combo'], ['Float', 'after', 0.2, '20% fewer after a miss'], ['Unbound', 'fast', 0.15, '15% fewer sped up']],
  oneshot: [['Cool head', 'always', 0.06, '6% fewer one-shot misses'], ['Brace', 'after', 0.2, '20% fewer after a miss'], ['Nerves of steel', 'combo', 0.15, '15% fewer on a 100+ combo'], ['Last breath', 'end', 0.15, '15% fewer near the end']],
  techs: [['Loose eyes', 'always', 0.06, '6% fewer tech misses'], ['Adapt', 'warm', 0.12, '12% fewer when warm'], ['Re-read', 'after', 0.2, '20% fewer after a miss'], ['Improvise', 'fast', 0.15, '15% fewer sped up']],
  unconv: [['Open eyes', 'always', 0.06, '6% fewer unconventional misses'], ['Go with it', 'combo', 0.15, '15% fewer on a 100+ combo'], ['Shake loose', 'after', 0.2, '20% fewer after a miss'], ['Wild finish', 'end', 0.15, '15% fewer near the end']],
};
const TWIG_BOOST = new Set(['aim', 'precision', 'reading']);
const TWIGS = {
  clean: { names: ['Tidy', 'Clean', 'Spotless'], short: 'fewer misses' },
  tough: { names: ['Thick skin', 'Tough', 'Iron will'], short: 'less health lost' },
  study: { names: ['Notes', 'Review', 'Homework'], short: 'more XP' },
  clutch: { names: ['Nerve', 'Clutch', 'Ice veins'], short: 'at low health' },
};
const INSTINCTS = [
  { id: 'natural', name: 'Natural', max: 5, cost: 1, desc: r => `+${30 * r}% XP` },
  { id: 'headstart', name: 'Head start', max: 4, cost: 2, desc: r => `Start seasons at Lv ${5 * r}` },
  { id: 'gifted', name: 'Gifted', max: 5, cost: 3, desc: r => `+${3 * r} bonus levels` },
  { id: 'craft', name: 'Craft', max: 4, cost: 2, craft: true, desc: r => `${r} technique${r === 1 ? '' : 's'}` },
  { id: 'clean', name: 'Clean', max: 3, cost: 1, twig: true, desc: r => `${r}/3` },
  { id: 'tough', name: 'Tough', max: 3, cost: 1, twig: true, desc: r => `${r}/3` },
  { id: 'study', name: 'Study', max: 3, cost: 1, twig: true, desc: r => `${r}/3` },
  { id: 'clutch', name: 'Clutch', max: 3, cost: 1, twig: true, desc: r => `${r}/3` },
];

const PERKS = [
  { id: 'steady', name: 'Steady hands', max: 4, cost: 2, desc: r => `${5 * r}% fewer slips` },
  { id: 'bargain', name: 'Bargain hunter', max: 5, cost: 1, desc: r => `Gear costs ${8 * r}% less` },
  { id: 'crowd', name: 'Crowd favourite', max: 5, cost: 1, desc: r => `+${15 * r}% points` },
  { id: 'nightowl', name: 'Night owl', max: 4, cost: 2, desc: r => `Time away counts ${r} hour${r > 1 ? 's' : ''} longer` },
  { id: 'warmblood', name: 'Warm blood', max: 3, cost: 2, desc: r => `Fails cool you down ${25 * r}% less` },
  { id: 'collector', name: 'Collector', max: 3, cost: 1, desc: r => `Mastery stars pay ${50 * r}% more` },
  { id: 'scholar', name: 'Scholar', max: 5, cost: 2, desc: r => `+${8 * r}% XP on every skill` },
  { id: 'starstruck', name: 'Starstruck', max: 5, cost: 3, desc: r => `Each star gives ${10 + r}% XP instead of 10%` },
  { id: 'patron', name: 'Patron', max: 3, cost: 3, desc: r => `The star shop is ${5 * r}% cheaper` },
];

const PRESTIGE = { lvl: 50, step: 5, xp: 1.1, max: 5 };
const REBIRTH = { seasons: 5, seasonsLate: 10, xp: 1.25 };
const REBIRTH_UNLOCKS = [
  { id: 'longer', name: 'Longer away', desc: 'Time away counts for up to 12 hours instead of 8' },
  { id: 'kit', name: 'Starter kit', desc: 'Every season and skill prestige starts with the first 3 gear tiers' },
  { id: 'deep', name: 'Deep instincts', desc: 'Natural, Head start, Gifted and every perk go 2 ranks further' },
  { id: 'bright', name: 'Bright seasons', desc: 'Seasons pay 25% more stars' },
  { id: 'encore', name: 'Encore', desc: 'Points ×2, for good' },
  { id: 'heirloom', name: 'Heirloom', desc: 'Every later rebirth keeps 20% of your stars' },
  { id: 'devout', name: 'Devout', desc: 'Devotion goes 25 ranks further (75 per skill)' },
  { id: 'brighter', name: 'Brighter seasons', desc: 'Seasons pay another 25% more stars' },
  { id: 'insight', name: 'Insight', desc: 'Seasons pay 50% more instinct points' },
  { id: 'legend', name: 'Legend', desc: 'Points ×3, for good' },
  { id: 'fullkit', name: 'Full kit', desc: 'The starter kit gives the first 6 gear tiers' },
  { id: 'second', name: 'Second wind', desc: '×1.5 XP on every skill, for good' },
  { id: 'ovation', name: 'Standing ovation', desc: 'Points ×4, for good' },
  { id: 'quick', name: 'Quick start', desc: 'Every season and skill prestige starts skills 10 levels up' },
  { id: 'deeper', name: 'Deeper instincts', desc: 'Natural, Head start, Gifted and every perk go 2 more ranks further' },
  { id: 'brightest', name: 'Brightest seasons', desc: 'Seasons pay another 25% more stars' },
  { id: 'zealot', name: 'Zealot', desc: 'Devotion goes 25 more ranks further (100 per skill)' },
  { id: 'clarity', name: 'Clarity', desc: 'Seasons pay double instinct points' },
  { id: 'keeper', name: 'Keeper', desc: 'Heirloom keeps 40% of your stars' },
  { id: 'mythic', name: 'Mythic', desc: 'Points ×5 and ×1.5 XP on every skill, for good' },
];

const STAR_SHOP = [
  { id: 'coach', name: 'Coach', kind: 'boost', max: 10, cost: r => 4 + 3 * r, desc: r => `+${10 * r}% XP on every skill` },
  { id: 'sponsor', name: 'Sponsor', kind: 'boost', max: 10, cost: r => 3 + 2 * r, desc: r => `+${20 * r}% points` },
  { id: 'nightshift', name: 'Night shift', kind: 'boost', max: 4, cost: r => 10 + 10 * r, desc: r => `Time away counts ${r} hour${r > 1 ? 's' : ''} longer` },
  { id: 'gearbag', name: 'Gear bag', kind: 'boost', max: 3, cost: r => 15 + 10 * r, desc: r => `Every season starts with the first ${r} gear tier${r > 1 ? 's' : ''} of every skill` },
  { id: 'tutor', name: 'Tutor', kind: 'boost', max: 5, cost: r => 12 + 8 * r, desc: r => `Every season pays ${r} more instinct point${r > 1 ? 's' : ''}` },
  { id: 'stardust', name: 'Stardust trail', kind: 'look', max: 1, cost: () => 20, desc: () => 'A glittering gold cursor trail (Settings, Trail style)' },
  { id: 'comet', name: 'Comet trail', kind: 'look', max: 1, cost: () => 35, desc: () => 'A bright comet tail behind your cursor (Settings, Trail style)' },
  { id: 'fx_starlit', name: 'Starlit name', kind: 'look', fx: 'starlit', max: 1, cost: () => 30, desc: () => 'Your name shimmers gold on your profile' },
  { id: 'fx_ember', name: 'Ember name', kind: 'look', fx: 'ember', max: 1, cost: () => 40, desc: () => 'Your name glows like embers on your profile' },
  { id: 'fx_aurora', name: 'Aurora name', kind: 'look', fx: 'aurora', max: 1, cost: () => 50, desc: () => 'Your name drifts through aurora colours on your profile' },
];
const STAR_MILESTONES = [
  { at: 10, id: 'xp1', desc: '+5% XP on every skill' },
  { at: 25, id: 'cheap', desc: 'The star shop is 10% cheaper' },
  { at: 50, id: 'perk', desc: 'Every perk can go one rank further' },
  { at: 100, id: 'pts', desc: '+10% points' },
  { at: 250, id: 'devote', desc: 'Devotion costs 1 point less' },
  { at: 500, id: 'xp2', desc: '+25% XP on every skill' },
  { at: 1000, id: 'starborn', desc: 'The Starborn name effect, free' },
  { at: 2000, id: 'xp3', desc: '+50% XP on every skill' },
  { at: 3500, id: 'pts2', desc: '+25% points' },
  { at: 5000, id: 'cheap2', desc: 'The star shop is another 10% cheaper' },
  { at: 7500, id: 'instinct', desc: 'Seasons pay 3 more instinct points' },
  { at: 10000, id: 'xp4', desc: 'Double XP on every skill' },
];

/* Shards: paid by seasons that reached the season RP and ran two hours or longer. */
const SEASON_SHARDS = 2, SEASON_SHARD_HOURS = 2;
const SHARD_UNLOCKS = [
  { id: '1.55', kind: 'speed', name: 'Speed 1.55×', cost: 4, desc: 'A faster speed: RP counts stars × 1.55.' },
  { id: '1.65', kind: 'speed', name: 'Speed 1.65×', cost: 8, after: '1.55', desc: 'RP counts stars × 1.65.' },
  { id: '1.8', kind: 'speed', name: 'Speed 1.8×', cost: 14, after: '1.65', desc: 'RP counts stars × 1.8.' },
  { id: '2', kind: 'speed', name: 'Speed 2×', cost: 24, after: '1.8', desc: 'Double speed: RP counts stars × 2.' },
  { id: 'hr2', kind: 'mod', name: 'Hard Rock+', cost: 10, desc: 'A harder Hard Rock: smaller hitbox, bigger playfield, stars ×1.2 for RP, points ×1.7, triple Precision XP.' },
  { id: 'ghost2', kind: 'mod', name: 'Ghost+', cost: 10, desc: 'A harder Ghost: notes vanish much sooner. Stars ×1.15 for RP, points ×1.6, ×4 Reading XP.' },
  { id: 'chaos2', kind: 'mod', name: 'Chaos+', cost: 6, desc: 'Notes drift in from twice as far. Points ×1.3, ×2.2 Reading XP, ×1.5 Aim and Consistency XP.' },
  { id: 'spin2', kind: 'mod', name: '360+', cost: 6, desc: 'The playfield turns twice as fast. Points ×1.3, ×2.2 Aim XP, Spins trains twice as much.' },
  { id: 'pf', kind: 'mod', name: 'Perfect', cost: 8 }, { id: 'ac', kind: 'mod', name: 'Accuracy Challenge', cost: 6 },
  { id: 'fl', kind: 'mod', name: 'Flashlight', cost: 12 }, { id: 'bl', kind: 'mod', name: 'Blinds', cost: 8 },
  { id: 'fi', kind: 'mod', name: 'Fade In', cost: 8 }, { id: 'co', kind: 'mod', name: 'Cover', cost: 6 }, { id: 'st', kind: 'mod', name: 'Strict Tracking', cost: 8 },
].map(u => { const m = MODS.find(x => x.id === u.id); return u.desc || !m ? u : Object.assign(u, { desc: `${m.tip}. ${m.effect}` }); });
const OVERDRIVE = { cost: 2, minutes: 30 };

const ASCEND = { rebirths: 10, mult: 2, trialGoal: 150, relicSlots: 2 };
const TRANSCEND = { asc: 5, mult: 10 };
const TRIALS = [
  { id: 'glass', name: 'Glass', rule: 'Misses cost double health', relic: 'mend' },
  { id: 'cold', name: 'Cold hands', rule: 'You never warm up', relic: 'ember' },
  { id: 'bare', name: 'Bare hands', rule: 'Gear gives no XP', relic: 'gloves' },
  { id: 'onelife', name: 'One life', rule: 'Every map is Sudden Death', relic: 'charm' },
  { id: 'dark', name: 'Lights out', rule: 'Every map has Flashlight', mod: 'fl', relic: 'lantern', asc: 2 },
  { id: 'blackout', name: 'Blackout', rule: 'Every map has Blinds', mod: 'bl', relic: 'shutter', asc: 2 },
  { id: 'hairline', name: 'Hairline', rule: 'Every map has Accuracy Challenge', mod: 'ac', relic: 'scope', asc: 2 },
  { id: 'frostbite', name: 'Frostbite', rule: 'Glass and Cold hands at once', rules: ['glass', 'cold'], relic: 'mend', lvl: 2, asc: 3 },
  { id: 'barebones', name: 'Bare bones', rule: 'Bare hands and One life at once', rules: ['bare', 'onelife'], relic: 'charm', lvl: 2, asc: 3 },
];
const RELICS = [
  { id: 'mend', name: 'Mending', desc: 'Hits heal twice as much', desc2: 'Hits heal three times as much' },
  { id: 'ember', name: 'Ember', desc: 'You are always fully warmed up' },
  { id: 'gloves', name: 'Old gloves', desc: 'Gear never needs the skill level' },
  { id: 'charm', name: 'Lucky charm', desc: 'The first miss in each map costs nothing', desc2: 'The first two misses in each map cost nothing' },
  { id: 'lantern', name: 'Lantern', desc: 'Double Reading XP' },
  { id: 'shutter', name: 'Shutter', desc: 'Double Consistency XP' },
  { id: 'scope', name: 'Scope', desc: 'Double Precision XP' },
];
const ASC_MILESTONES = { 2: ['A 3rd relic slot', 'Trials with Flashlight, Blinds and Accuracy Challenge'], 3: ['Trials II: two rules at once, for stronger relics'], 4: ['A 4th relic slot'], 5: ['Transcendence opens'] };
const ECHO_NODES = [
  { id: 'resonance', name: 'Resonance', desc: '×1.5 XP and points per rank', costs: [1, 2, 3] },
  { id: 'memory', name: 'Memory', desc: 'Keep the first 3 rebirth unlocks through every reset (5 at rank 2)', costs: [2, 3] },
  { id: 'relic', name: 'Relic case', desc: 'One more relic slot', costs: [2] },
  { id: 'focus', name: 'Focus', desc: 'Trials need half the stars', costs: [1] },
];

const MASTERY_BITS = [{ bit: 1, name: 'Pass' }, { bit: 2, name: 'S rank' }, { bit: 4, name: 'Full combo or 1.35×' }];
const GRADE_COLORS = { SS: '#ffe27a', S: '#ffd54f', A: '#5be37d', B: '#7c9dff', C: '#c38bff', D: '#ff4f6d', F: '#ff4f6d' };

/* First-hour goals: one at a time, each paying a few minutes of income. */
const GOALS = [
  { id: 'pass3', text: 'Pass 3 maps', need: 3, min: 3, floor: 25 },
  { id: 'gear', text: 'Buy your first gear (Skills, then Gear)', need: 1, min: 5, floor: 50 },
  { id: 'lv10', text: 'Get any skill to Lv 10', need: 10, min: 5, floor: 100 },
  { id: 'mod', text: 'Turn on a mod or a faster speed in map select, then pass a map with it', need: 1, min: 8, floor: 150 },
  { id: 'pass20', text: 'Pass 20 maps', need: 20, min: 8, floor: 200 },
  { id: 'rp500', text: 'Reach 500 RP', need: 500, min: 10, floor: 300 },
  { id: 'gear5', text: 'Own 5 gear tiers on one skill', need: 5, min: 10, floor: 400 },
  { id: 'inter', text: 'Pass an Intermediate map', need: 1, min: 12, floor: 600 },
];

const ACHIEVEMENTS = [
  { id: 'plays1', name: 'First steps', desc: 'Pass a map' },
  { id: 'plays50', name: 'Regular', desc: 'Pass 50 maps' },
  { id: 'plays500', name: 'Veteran', desc: 'Pass 500 maps' },
  { id: 'fc0', name: 'Flawless', desc: 'Full combo a map' },
  { id: 'ss0', name: 'Double S', desc: 'Get an SS grade' },
  { id: 'clear3', name: 'Intermediate', desc: 'Pass a 3-star map' },
  { id: 'clear5', name: 'Hard mode', desc: 'Pass a 5-star map' },
  { id: 'clear7', name: 'Expert', desc: 'Pass a 7-star map' },
  { id: 'clear10', name: 'Ten stars', desc: 'Pass a 10-star map' },
  { id: 'rp1500', name: 'Expert title', desc: 'Reach 1,500 RP' },
  { id: 'rp5000', name: 'Master title', desc: 'Reach 5,000 RP' },
  { id: 'speed145', name: 'Need for speed', desc: 'Pass a map at 1.45× or faster' },
  { id: 'season1', name: 'New season', desc: 'Finish a season' },
  { id: 'rebirth1', name: 'Reborn', desc: 'Take a rebirth' },
  { id: 'ascend1', name: 'Ascended', desc: 'Take an Ascension' },
  { id: 'lv50', name: 'Half century', desc: 'Get a skill to Lv 50' },
  { id: 'lv120', name: 'Maxed', desc: 'Get a skill to Lv 120' },
  { id: 'gear15', name: 'Full set', desc: 'Own every gear tier on one skill' },
  { id: 'mods3', name: 'Mod stack', desc: 'Pass a map with three mods on' },
  { id: 'daily', name: 'Daily grind', desc: 'Clear a daily map' },
];

/* Bot players for the online list, chat and leaderboards. */
const BOT_NAMES = ['Mochi', 'Vexa', 'Kiro', 'Luma', 'Pepperoni', 'Sable', 'Zinnia', 'Orbit', 'Nova', 'Juniper', 'Tallow', 'Quill', 'Rune', 'Iris', 'Fennel', 'Halcyon', 'Pixel', 'Maru', 'Clover', 'Ash', 'Bramble', 'Echo', 'Comet', 'Dusk', 'Ferris', 'Glint', 'Haze', 'Indigo', 'Jet', 'Kestrel', 'Lark', 'Mint', 'Nimbus', 'Opal', 'Plum', 'Quartz', 'Rook', 'Sprout', 'Tide', 'Umber', 'Vale', 'Wisp', 'Yarrow', 'Zephyr', 'Byte', 'Cinder', 'Drift', 'Ember', 'Flux', 'Gale'];
const BOT_LINES = ['gg', 'that stream section is brutal', 'anyone else grinding the daily?', 'finally hit expert title!', 'what speed do you run for RP?', 'my aim is so bad today', 'ghost mod is free rp honestly', 'season reset in 10 min, wish me luck', 'how many stars for a rebirth?', 'first SS on a 6 star lets go', 'hr+ is worth every shard', 'does anyone play with lanes on?', 'warm-up bar is at full, time to push', 'who is #1 right now', 'that map cover is gorgeous', 'tip: queue long maps before you sleep', 'lol failed at 99%', 'new patch notes are up', 'is 1.45x a big jump from 1.35x?', 'my bot keeps failing jumps', 'overdrive go brrr', 'got my first relic!', 'be right back, food', 'hello everyone', 'weekly challenge done, easy badge'];
const COUNTRIES = ['US', 'DE', 'JP', 'BR', 'GB', 'FR', 'PL', 'CA', 'AU', 'KR', 'NL', 'SE', 'FI', 'ES', 'IT', 'MX', 'AR', 'RU', 'TR', 'ID'];

const PATCH_NOTES = [
  { v: '1.0', date: '2026-11-07', notes: ['First release of the clone: every screen of the original game rebuilt from scratch.', 'Maps come from the public Rhythia catalogue; note charts are generated per map.', 'Online features run locally with bot players, since there is no game server.'] },
];
