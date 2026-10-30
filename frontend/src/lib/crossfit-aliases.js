// The box's dialect and gym shorthand, read as catalogue exercises: norm(rawName) → exercise id
// (see crossfit-resolve.js for both). Built from the box's posted programs; a user's own pick for
// a name (S.exAliases) always wins over this table.
//
// Keys are already normalised (singular words, no ´s, "&" as "and"); the test checks each one is
// its own norm() and that every id exists. A name that could mean several exercises (a plain
// "lunges" both with and without a barbell) maps to the everyday one, and the user re-picks.
export const SHIPPED_ALIASES = {
  // Monostructural: what "Row/Ski/Bike" means at the box. "machine" (any of them) is left to a pick.
  'row': '1161', 'easy row': '1161',
  'ski': '2142', 'easy ski': '2142',
  'bike': '3893', 'easy bike': '3893', 'echo bike': '3893', 'assault bike': '3893', 'bike erg': '3893',
  'run': '0685', 'easy run': '0685',
  'swim': '2870',
  'sled push': '4428',
  'sled pull': '9939', 'sled pull drag just arm': '9939',
  'sled drag': '5143',
  'farmer walk': '2133',

  // Barbell
  'clean': '0648', 'squat clean': '5287', 'hang clean': '1520', 'muscle clean': '5075',
  'clean and jerk': '5122', 'c and j': '5122', 'hang clean and jerk': '5122',
  'jerk': '1529', 'snatch': '1533', 'hang snatch': '1522',
  'dl': '0032', 'fs': '0042', 'front squat': '0042', 'back squat': '0043', 'bs': '0043',
  'thruster': '3305', 'trhuster': '3305', 'cluster': '5188',
  'push press': '1200', 'back push press': '4857', 'press estricto': '1162', 's2oh': '1200',
  'high sumo pull': '1199',
  'land mine press': '5074', 'bb land mine press': '5074',

  // Dumbbell (DB, DB´s). A skull crusher with no equipment printed is the dumbbell one at the box.
  'db bench press': '0289', 'db elevated bench press': '0314',
  'db skull cruch': '0351', 'skull cruch': '0351', 'skull crusher': '0351', 'copa': '0430', 'db tricep kick back': '0333',
  'db bicep curl': '0294', 'db martillo': '0313', 'martillo': '0313',
  'db strict press': '0426', 'db sea saw press': '3972', 'db arnold press': '2137', 'db push press': '1700',
  'db front fly': '0310', 'db lateral fly': '0334', 'db lateral fly to front fly': '0335',
  'db lateral front fly': '0335', 'db bend over fly': '0378', 'db high pull': '5666',
  'db bend over row': '0293', 'db split row': '0292', 'db renegade row': '2980', 'renegade row': '2980',
  'db clean': '0295', 'db h clean': '4449', 'db hang clean': '4449', 'db c and j': '4439',
  'db snatch': '3888', 'db hang snatch': '10044', 'db dl': '0300',
  'db devil press': '4164', 'devil press': '4164', 'db cluster': '2968',
  'db squat': '0413', 'db bs': '0413', 'db front squat': '2966', 'db goblet squat': '1760', 'db goblet sumo squat': '7547',
  'db split squat': '2960', 'db step up': '0431', 'db lunge': '0336', 'db farmer lunge': '0336',
  'db reverse lunge': '0381',

  // Kettlebell (KB, KB´s). A Russian swing is the eye-level swing, the catalogue's kettlebell swing.
  // KB OHS is printed 5/5 (per side), and the one-arm overhead squat is the catalogue's only KB one.
  'kb swing': '0549', 'swing': '0549', 'kb swing high pull': '0548',
  'russian swing': '0549', 'kb russian swing': '0549', 'russian kb swing': '0549',
  'kb oh': '1566', 'kb overhead squat': '1566',
  'kb high sumo pull': '4132', 'kb dl': '3322', 'kb c and j': '4542',
  'kb hang clean': '0535', 'kb jerk': '0527', 'kb bend over row': '6156', 'kb gorilla row': '7230',
  'kb goblet squat': '0534', 'kb sit up to shoulder press': '5072',

  // Gymnastics and body weight
  't2b': '3891', 'knee to chest': '9819', 'k2c': '9819', 'bmu': '5194', 'rmu': '0631',
  'pull up': '0652', 'pull up estricto': '0652', 'pull up estrcito': '0652',
  'chin up': '1326', 'chin up estricto': '1326',
  'push up': '0662', 'push us': '0662', 'hpu': '3947', 'diamond push up': '0283', 'dymond push up': '0283',
  'push up knee tap': '4162', 'dip': '0251',
  // A kip swing (hollow to arch, hanging from the bar) is the catalogue's scapular pull-up swing.
  'kip': '10948', 'kip swing': '10948', 'kipping swing': '10948',
  's tap': '3699', 'shoulder tap': '3699', 'plank s tap': '3699', 'plank shoulder tap': '3699',
  'ankle toach': '0006', 'ankle touch': '0006', 'ankle tap': '0006',
  'burpee': '1160', 'burpee bjo': '8704', 'bjo': '3887', 'bj': '3650', 'du': '3885',
  'squat': '3948', 'airsquat': '3948', 'air squat': '3948', 'jump squat': '0514', 'pulse squat': '3535',
  'lunge': '0612', 'reverse lunge': '1581', 'step up': '0801',
  'sit up': '0736', 'crunch': '0274', 'tuck crunch': '0871', 'leg raise': '1163', 'strict leg raise': '0472',
  'russian twist': '0687', 'plank': '0463', 'hollow': '1246', 'm climber': '0630',
  'inch worm': '1471', 'pop jack': '7556', 'wall climb': '5234',
  'wall ball': '2458',
}
