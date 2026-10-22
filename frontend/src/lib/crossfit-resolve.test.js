import { describe, expect, it } from 'vitest'
import { norm, rawNameOf, resolveMovement } from './crossfit-resolve.js'
import { SHIPPED_ALIASES } from './crossfit-aliases.js'
import { EXIDX } from './exercises.js'

// Every movement of the 18 sample programs (2026-09-27 to 10-21), once per distinct spelling:
// raw (one movement as the parser splits it, slot label included) → the rawName the parser must
// return → the exercise it resolves to. null is "needs a pick": nothing in the catalogue is that
// movement, or the name could be several (NEEDS_PICK below lists them). The running club's
// interval lines ("8x400x1:30 de pausa") are not movements and are left out.
const FIXTURE = [
  // 09-27
  ['20 seg machine', 'machine', null],
  ['4 Burpees', 'burpees', '1160'],
  ['5 Knees to chest', 'knees to chest', '9819'],
  ['6 Hang Clean & Jerks', 'hang clean & jerks', '5122'],
  ['3 Clean & Jerks', 'clean & jerks', '5122'],
  ['12 High sumo pull 95/65', 'high sumo pull', '1199'],
  ['6 Sushy Rolls', 'sushy rolls', null],
  ['12 S2OH 95/65', 's2oh', '1200'],
  ['6 BMU', 'bmu', '0631'],
  ['12 Hang Clean & Jerks 95/65', 'hang clean & jerks', '5122'],
  ['7 DB Clean', 'db clean', '0295'],
  ['7 DB Hang Snatch R', 'db hang snatch', '10044'],
  ['7 DB Hang Snatch L', 'db hang snatch', '10044'],
  ['10 Devil Press ALT', 'devil press', '4164'],
  ['M1 12 KB Sit ups to Shoulder press', 'kb sit ups to shoulder press', '5072'],
  ['M2 8 DB´s Front Flys', 'db´s front flys', '0310'],
  ['8 DB´s Lateral Fly', 'db´s lateral fly', '0334'],
  ['12 KB´s High sumo pull 20KG/12KG', 'kb´s high sumo pull', '4132'],
  ['6 Pull ups estrictos', 'pull ups estrictos', '0652'],
  ['12 KB´s Gorilla Row 20KG/12KG', 'kb´s gorilla row', '7230'],
  ['6 Chin ups estrictos', 'chin ups estrictos', '1326'],
  ['6 KB´s Bend over row', 'kb´s bend over row', '6156'],
  ['6 KB´s Swings', 'kb´s swings', '0549'],
  ['50 Push ups', 'push ups', '0662'],
  ['15 Copas', 'copas', '0430'],
  ['15 DB´s Skull Cruches', 'db´s skull cruches', '0351'],
  ['18 DB´ s Bench press', 'db´ s bench press', '0289'],
  ['Max Diamond push ups', 'diamond push ups', '0283'],
  ['10x300mts Row', 'row', '1161'],
  ['15 Sit Wall Balls', 'sit wall balls', null],
  ['1x1000 mts Row', 'row', '1161'],
  // 09-28
  ['4 Squat Cleans', 'squat cleans', '5287'],
  ['4 FS', 'fs', '0042'],
  ['4 inch worms', 'inch worms', '1471'],
  ['8 Nastys', 'nastys', null],
  ['1 Clean', 'clean', '0648'],
  ['60 Front Squats 135/95 / 2', 'front squats', '0042'],
  ['1 FS 185/135', 'fs', '0042'],
  ['Max Bike', 'bike', '3893'],
  ['Row', 'row', '1161'],
  ['Ski', 'ski', '2142'],
  ['120 DB´s Lunges', 'db´s lunges', '0336'],
  ['60 DB´s Squat / 2', 'db´s squat', '0413'],
  ['56 mts Sled Push 100KG / 2', 'sled push', '4428'],
  ['28 mts Sled Push 200KG /2', 'sled push', '4428'],
  ['RUN 2K', 'run', '0685'],
  ['BIKE 5K /2', 'bike', '3893'],
  ['10 Back Squats 135/95', 'back squats', '0043'],
  ['DB BS', 'db bs', '0413'],
  ['10 DB Step up R', 'db step up', '0431'],
  ['10 DB Step UP L', 'db step up', '0431'],
  // 10-04
  ['3 Burpee Pull ups', 'burpee pull ups', null],
  ['5 Muscle Clean', 'muscle clean', '5075'],
  ['Push press', 'push press', '1200'],
  ['7 Blast Off Push ups', 'blast off push ups', null],
  ['1 Jerk', 'jerk', '1529'],
  ['Run 100', 'run', '0685'],
  ['15 T2B', 't2b', '3891'],
  ['10 C&J 135/95', 'c&j', '5122'],
  ['15 Pull ups', 'pull ups', '0652'],
  ['15 BMU', 'bmu', '0631'],
  ['M1 7 DB´s DL', 'db´s dl', '0300'],
  ['7 DB´s H. Cleans', 'db´s h. cleans', '4449'],
  ['7 DB´s Bend over Row', 'db´s bend over row', '0293'],
  ['M2 14 Hollow Crunches', 'hollow crunches', null],
  ['M3 14 BJO', 'bjo', '3887'],
  ['18 Sit ups', 'sit ups', '0736'],
  ['9 DB Split Row R', 'db split row', '0292'],
  ['18 Tuck Crunches', 'tuck crunches', '0871'],
  ['250 mts Row', 'row', '1161'],
  ['500 mts Bike', 'bike', '3893'],
  ['15 Strict Leg Raise', 'strict leg raise', '0472'],
  ['10 KB´s C&J 24KG/16KG', 'kb´s c&j', '4542'],
  ['15 Pull ups Estrictos', 'pull ups estrictos', '0652'],
  ['50 Dips', 'dips', '0251'],
  ['12-15 DB´s Tricep Kick Backs', 'db´s tricep kick backs', '0333'],
  ['12-15 DB´s Elevated Bench press', 'db´s elevated bench press', '0314'],
  ['12-15 DB´s sea saw press', 'db´s sea saw press', '3972'],
  ['12-15 Copas', 'copas', '0430'],
  ['Easy Row', 'easy row', '1161'],
  ['Mts Row', 'row', '1161'],
  ['Burpees', 'burpees', '1160'],
  // 10-05
  ['8 Push ups', 'push ups', '0662'],
  ['10 Reverse lunges', 'reverse lunges', '1581'],
  ['R1 12 DL', 'dl', '0032'],
  ['Max Squat Cleans 155/105', 'squat cleans', '5287'],
  ['15 Airsquats', 'airsquats', '3948'],
  ['M1 12 DB Split Squat 6/6', 'db split squat', '2960'],
  ['M2 12 DB Goblet Squats', 'db goblet squats', '1760'],
  ['R1 12 KB´s DL', 'kb´s dl', '3322'],
  ['Max Sled Push 100 KG/50KG', 'sled push', '4428'],
  ['100 Cal Bike', 'bike', '3893'],
  ['Run 1K', 'run', '0685'],
  ['15 Burpee BJ', 'burpee bj', null],
  ['30 DB´s Lunges', 'db´s lunges', '0336'],
  ['5 Back Squats', 'back squats', '0043'],
  ['3 Front Squats', 'front squats', '0042'],
  ['22 DB Step ups', 'db step ups', '0431'],
  ['22 DB Reverse Lunges', 'db reverse lunges', '0381'],
  // 10-06
  ['8 Blast Off push ups', 'blast off push ups', null],
  ['8 Pulse Squats', 'pulse squats', '3535'],
  ['8 S.Taps', 's.taps', '3699'],
  ['3 Press Estrictos', 'press estrictos', '1162'],
  ['6 Push Press', 'push press', '1200'],
  ['M1 2 Hang Cleans', 'hang cleans', '1520'],
  ['5 Jerks 135/95', 'jerks', '1529'],
  ['M8 1 Hang Clean', 'hang clean', '1520'],
  ['1 Jerk 245/165', 'jerk', '1529'],
  ['2 Wall Climbs', 'wall climbs', '5234'],
  ['4 DB´s Devil Press', 'db´s devil press', '4164'],
  ['8 DB´s Push press', 'db´s push press', '1700'],
  ['M1 20 Push ups', 'push ups', '0662'],
  ['M2 Max DB´s Farmer Hold', 'db´s farmer hold', null],
  ['8 DB´s Arnold Press', 'db´s arnold press', '2137'],
  ['16 DB´s Skull Cruches', 'db´s skull cruches', '0351'],
  ['M1 12 KB´s Swings High pull 20KG/12KG', 'kb´s swings high pull', '0548'],
  ['M2 12 Burpees', 'burpees', '1160'],
  ['2 DB´s Renegade Row', 'db´s renegade row', '2980'],
  ['12-15 DB´s Bicep curls', 'db´s bicep curls', '0294'],
  ['12-15 DB´s Bend over Flys', 'db´s bend over flys', '0378'],
  ['8 Chin ups', 'chin ups', '1326'],
  ['12-15 DB´s Martillos', 'db´s martillos', '0313'],
  ['12-15 DB Split Row', 'db split row', '0292'],
  ['Easy Bike', 'easy bike', '3893'],
  ['Ski', 'ski', '2142'],
  // 10-07
  ['12 Predator jacks', 'predator jacks', null],
  ['10 Jump Squats', 'jump squats', '0514'],
  ['8 Push ups Knee tap', 'push ups knee tap', '4162'],
  ['Max Run', 'run', '0685'],
  ['Swim', 'swim', '2870'],
  ['5 Pull ups Estrcitos', 'pull ups estrcitos', '0652'],
  ['15 Squats', 'squats', '3948'],
  ['40 seg plank', 'plank', '0463'],
  ['30 Sit ups', 'sit ups', '0736'],
  ['20 Leg Raises', 'leg raises', '1163'],
  ['10 Hollow Crunches', 'hollow crunches', null],
  ['30 Step ups', 'step ups', '0801'],
  ['15 Dips', 'dips', '0251'],
  ['30 Reverse Lunges', 'reverse lunges', '1581'],
  ['15 Dymond Push ups', 'dymond push ups', '0283'],
  ['40 mts Sled Push', 'sled push', '4428'],
  ['40 mts Sled Pull', 'sled pull', '9939'],
  ['40 mts Burpee BJ', 'burpee bj', null],
  ['Easy Run', 'easy run', '0685'],
  // 10-08
  ['4 Kips', 'kips', null],
  ['4 knees to chest', 'knees to chest', '9819'],
  ['4 Hang Snatch', 'hang snatch', '1522'],
  ['4 Back push press', 'back push press', '4857'],
  ['8 Squats', 'squats', '3948'],
  ['2 Snatch', 'snatch', '1533'],
  ['15 Cal Row', 'row', '1161'],
  ['7 BMU', 'bmu', '0631'],
  ['5 Snatch 155/105', 'snatch', '1533'],
  ['40 DU', 'du', '3885'],
  ['M2 9 DB´s Cleans', 'db´s cleans', '0295'],
  ['M3 18 Wall Balls', 'wall balls', '2458'],
  ['8 Step ups', 'step ups', '0801'],
  ['8Push ups', 'push ups', '0662'],
  ['Run 1K', 'run', '0685'],
  ['Bike 2.5K', 'bike', '3893'],
  ['20 KB Goblet Squat', 'kb goblet squat', '0534'],
  ['14 Mts Sled Pull & Push 200KG/150KG', 'sled pull & push', null],
  ['8 DB Devil Press', 'db devil press', '4164'],
  ['50 DB Step ups UNBROKEN', 'db step ups', '0431'],
  ['12-15 DB´s Strict Press', 'db´s strict press', '0426'],
  ['Max Leg raises', 'leg raises', '1163'],
  ['12-15 DB´s Lateral Flys to Front Flys', 'db´s lateral flys to front flys', '0335'],
  ['Max Tuck Crunches', 'tuck crunches', '0871'],
  ['24 Land Mine Press 12/12', 'land mine press', '5074'],
  ['Max Russian Twist', 'russian twist', '0687'],
  ['max Wall Balls Sentado', 'wall balls sentado', null],
  // 10-09
  ['4 Pop jacks', 'pop jacks', '7556'],
  ['8 Thrusters', 'thrusters', '3305'],
  ['12 Push ups', 'push ups', '0662'],
  ['2 Thruster', 'thruster', '3305'],
  ['Run 400 sincro', 'run', '0685'],
  ['20 Burpee BJO / 2', 'burpee bjo', '8704'],
  ['30 Clusters 95/65 / 2', 'clusters', '5188'],
  ['40 Lunges 95/65 / 2', 'lunges', '0612'],
  ['M1 14 mts Sled Drag 75KG/25KG', 'sled drag', '5143'],
  ['M2 14 DB Split Squat', 'db split squat', '2960'],
  ['M3 14 DB Goblet Sumo Squat', 'db goblet sumo squat', '7547'],
  ['16 Cal Row', 'row', '1161'],
  ['DB´s Clusters', 'db´s clusters', '2968'],
  ['20 KB Goblet Lunges', 'kb goblet lunges', null],
  ['35 Swings', 'swings', '0549'],
  ['50 KB High sumo pull', 'kb high sumo pull', '4132'],
  ['Run 700', 'run', '0685'],
  ['700 mts Ski', 'ski', '2142'],
  ['30 mts sled Push', 'sled push', '4428'],
  ['30 mts Sled Pull', 'sled pull', '9939'],
  ['50 mts Burpee Broad Jump', 'burpee broad jump', null],
  ['700 mts Row', 'row', '1161'],
  ['140 mts Farmer Walk', 'farmer walk', '2133'],
  ['70 mts Lunges', 'lunges', '0612'],
  ['70 Wall Balls', 'wall balls', '2458'],
  ['RUN10K', 'run', '0685'],
  // 10-11
  ['4 kips', 'kips', null],
  ['4 pull ups', 'pull ups', '0652'],
  ['4 Cleans', 'cleans', '0648'],
  ['4 Push press', 'push press', '1200'],
  ['3 Jerks', 'jerks', '1529'],
  ['M1 15 Wall Balls', 'wall balls', '2458'],
  ['M2 15 BJ', 'bj', '3650'],
  ['M3 10 Jerks 135/95', 'jerks', '1529'],
  ['M1 12 DB´s DL', 'db´s dl', '0300'],
  ['6 DB´s C&J', 'db´s c&j', '4439'],
  ['M2 12 Pull ups', 'pull ups', '0652'],
  ['6 T2B', 't2b', '3891'],
  ['M3 12 Sit ups', 'sit ups', '0736'],
  ['6 Hollow Crunches', 'hollow crunches', null],
  ['Max Plank', 'plank', '0463'],
  ['M1 12 DB´s Lateral Fly', 'db´s lateral fly', '0334'],
  ['max plank', 'plank', '0463'],
  ['M2 12 DB´s Front Fly', 'db´s front fly', '0310'],
  ['max crunches', 'crunches', '0274'],
  ['M3 12 DB´s High pull', 'db´s high pull', '5666'],
  ['max Leg raises', 'leg raises', '1163'],
  ['M3 15 Swings 24KG/16KG', 'swings', '0549'],
  ['8 Pull ups', 'pull ups', '0652'],
  ['4 Leg Raises', 'leg raises', '1163'],
  // 10-12
  ['10 DL Jump', 'dl jump', null],
  ['7 Push ups', 'push ups', '0662'],
  ['5 Squat Cleans', 'squat cleans', '5287'],
  ['1 Squat Clean', 'squat clean', '5287'],
  ['RUN 200 Sincro', 'run', '0685'],
  ['30 Squat Cleans 135/95 / 2', 'squat cleans', '5287'],
  ['10 Squat Cleans 225/155 / 2', 'squat cleans', '5287'],
  ['40 Cal Bike', 'bike', '3893'],
  ['Ski / 2', 'ski', '2142'],
  ['30 DB´s Lunges / 2', 'db´s lunges', '0336'],
  ['15 Sincro Burpees', 'burpees', '1160'],
  ['20 DB Reverse Lunge 10/10', 'db reverse lunge', '0381'],
  ['20 DB Split Squat 10/10', 'db split squat', '2960'],
  ['Run / 2', 'run', '0685'],
  ['70 KB´s DL 32KG/24KG / 2', 'kb´s dl', '3322'],
  ['Max Sled Push / 2', 'sled push', '4428'],
  // 10-13
  ['8 Push press', 'push press', '1200'],
  ['8 Lunges', 'lunges', '0612'],
  ['2 Press Estrictos', 'press estrictos', '1162'],
  ['4 Push Press', 'push press', '1200'],
  ['M1 5 Hang Cleans 185/135', 'hang cleans', '1520'],
  ['M2 5 Jerks 185/135', 'jerks', '1529'],
  ['9 DB Snatch R', 'db snatch', '3888'],
  ['9 DB Push press R', 'db push press', '1700'],
  ['9 DB Snatch L', 'db snatch', '3888'],
  ['9 DB Push press L', 'db push press', '1700'],
  ['Push ups', 'push ups', '0662'],
  ['M1 14 Leg Raises', 'leg raises', '1163'],
  ['M2 14 DB´s Lateral Flys', 'db´s lateral flys', '0334'],
  ['M3 14 BB Land Mine Press 7/7', 'bb land mine press', '5074'],
  ['M1 18 Swings 24KG/16KG', 'swings', '0549'],
  ['M2 18 Cal ski', 'ski', '2142'],
  // 10-14
  ['Run 400', 'run', '0685'],
  ['Ski800', 'ski', '2142'],
  ['Bike 1200', 'bike', '3893'],
  ['20 Push us', 'push us', '0662'],
  ['30 Squats', 'squats', '3948'],
  ['M1 12 DB´s Bend over Row', 'db´s bend over row', '0293'],
  ['M2 18 Sit ups', 'sit ups', '0736'],
  ['M3 12 DB´s Skull Cruches', 'db´s skull cruches', '0351'],
  ['M4 18 Russian Twist', 'russian twist', '0687'],
  ['M5 12 DB´s Bench press', 'db´s bench press', '0289'],
  ['20 Dips', 'dips', '0251'],
  ['30 Lunges', 'lunges', '0612'],
  ['100 Burpees', 'burpees', '1160'],
  ['14 Mts Sled Push', 'sled push', '4428'],
  ['20 DB´s Lunges', 'db´s lunges', '0336'],
  ['1 Set Max Wall Balls', 'wall balls', '2458'],
  // 10-15
  ['4 Burpee Pull ups', 'burpee pull ups', null],
  ['6 Snatch', 'snatch', '1533'],
  ['1 Snatch', 'snatch', '1533'],
  ['21 Burpees', 'burpees', '1160'],
  ['18 Snatch 95/65', 'snatch', '1533'],
  ['9 BMU', 'bmu', '0631'],
  ['20 Wall Balls', 'wall balls', '2458'],
  ['10 DB´s Cleans', 'db´s cleans', '0295'],
  ['10 Pulse Squats', 'pulse squats', '3535'],
  ['7 Pop jacks', 'pop jacks', '7556'],
  ['30 KB High Pull to Squat', 'kb high pull to squat', null],
  ['14 Mts Sled Pull + Drag Just Arms 75KG/25KG', 'sled pull + drag just arms', '9939'],
  ['1K Row', 'row', '1161'],
  ['30 Burpees', 'burpees', '1160'],
  // 10-16
  ['4 Knees to chest', 'knees to chest', '9819'],
  ['1 Thruster', 'thruster', '3305'],
  ['30 Hang Cleans 135/95 / 2', 'hang cleans', '1520'],
  ['30 HPU / 2', 'hpu', '3947'],
  ['30 Jerks 135/95 /2', 'jerks', '1529'],
  ['30 Devil Press / 2', 'devil press', '4164'],
  ['30 Trhusters 135/95 / 2', 'trhusters', '3305'],
  ['30 T2B / 2', 't2b', '3891'],
  ['Bike 800 Parner A', 'bike', '3893'],
  ['30 DB´s Hang Cleans / 2', 'db´s hang cleans', '4449'],
  ['30 Push ups / 2', 'push ups', '0662'],
  ['30 Wall Balls /2', 'wall balls', '2458'],
  ['30 Swings / 2', 'swings', '0549'],
  ['Run 400 Sincro Parner C', 'run', '0685'],
  ['30 Leg Raises / 2', 'leg raises', '1163'],
  ['Run 800', 'run', '0685'],
  ['30 Cal Row', 'row', '1161'],
  ['30 DB´s Farmer Lunges', 'db´s farmer lunges', '0336'],
  ['15 Burpees', 'burpees', '1160'],
  ['100 Wall Balls', 'wall balls', '2458'],
  // 10-18
  ['6 pull ups', 'pull ups', '0652'],
  ['2 Jerks', 'jerks', '1529'],
  ['12 DL 155/105', 'dl', '0032'],
  ['9 Hang Cleans 155/105', 'hang cleans', '1520'],
  ['6 Jerks 155/105', 'jerks', '1529'],
  ['M1 16 BJO', 'bjo', '3887'],
  ['M3 16 DB Hang Snatch R', 'db hang snatch', '10044'],
  ['M1 40 seg max Sit ups', 'sit ups', '0736'],
  ['M2 40 seg max DB´s Lateral + Front Fly', 'db´s lateral + front fly', '0335'],
  ['M3 25 Seg KB Farmer Bends  R', 'kb farmer bends', null],
  ['12 KB´s DL 24/16', 'kb´s dl', '3322'],
  ['9 KB´s Hang Cleans 24/16', 'kb´s hang cleans', '0535'],
  ['6 KB´s Jerks 24/16', 'kb´s jerks', '0527'],
  ['50 Dips', 'dips', '0251'],
  // 10-19
  ['100 Front Squats 135/95', 'front squats', '0042'],
  ['100 DB´s Bench Press', 'db´s bench press', '0289'],
  ['100 DL 135/95', 'dl', '0032'],
  ['Run 1.6K', 'run', '0685'],
  ['100 DB´s Front Squats', 'db´s front squats', '2966'],
  ['100 DB´s DL', 'db´s dl', '0300'],
  // 10-20
  ['2K Ski', 'ski', '2142'],
  [' 4K Bike', 'bike', '3893'],
  ['R1 15 Jerks 135/95', 'jerks', '1529'],
  ['M1 6 Renegade Row', 'renegade row', '2980'],
  ['M2 12 HPU', 'hpu', '3947'],
  ['Max hollow', 'hollow', '1246'],
  ['9 Cal Ski', 'ski', '2142'],
  ['21 Swings', 'swings', '0549'],
  ['M2 12 DB High sumo pull', 'db high sumo pull', null],
  // 10-21
  ['20/15 Cal Row', 'row', '1161'],
  ['10 Wall Balls', 'wall balls', '2458'],
  ['3 Burpees', 'burpees', '1160'],
  ['Sit ups', 'sit ups', '0736'],
  ['M.Climbers', 'm.climbers', '0630'],
  ['Russian Twist', 'russian twist', '0687'],
  ['100 Push ups', 'push ups', '0662'],
]

// The names no shipped alias or clear search hit covers: the first time one shows up, the user
// picks the exercise and the pick is remembered (S.exAliases).
const NEEDS_PICK = [
  'machine', 'sushy rolls', 'sit wall balls', 'nastys', 'burpee pull ups', 'blast off push ups',
  'hollow crunches', 'burpee bj', 'db´s farmer hold', 'predator jacks', 'kips', 'sled pull & push',
  'wall balls sentado', 'kb goblet lunges', 'burpee broad jump', 'dl jump', 'kb high pull to squat',
  'kb farmer bends', 'db high sumo pull',
]

describe('crossfit resolve: the sample programs', () => {
  it.each(FIXTURE)('%s → rawName %j → %s', (raw, rawName, exId) => {
    expect(rawNameOf(raw)).toBe(rawName)
    expect(resolveMovement({ rawName }).exId).toBe(exId)
  })

  it('lists every unresolved name as needing a pick, and nothing else', () => {
    const open = [...new Set(FIXTURE.filter(([, , id]) => id === null).map(([, rawName]) => rawName))]
    expect(open.sort()).toEqual([...NEEDS_PICK].sort())
  })
})

describe('crossfit resolve: user aliases', () => {
  it('a pick saved for one day resolves the next day\'s line', () => {
    const userAliases = {}
    const monday = rawNameOf('5 Hang Cleans 185/135')
    userAliases[norm(monday)] = { exId: '4449', _ts: 1 }   // the user picked the dumbbell version
    const tuesday = rawNameOf('9 Hang Cleans 155/105')
    expect(resolveMovement({ rawName: tuesday }, userAliases)).toEqual({ exId: '4449', via: 'user' })
  })

  it('one key for the spellings of a name', () => {
    expect(norm('DB´s Hang Cleans')).toBe('db hang clean')
    expect(norm('db´ s hang clean')).toBe('db hang clean')
    expect(norm("DB's  hang-clean")).toBe('db hang clean')
    expect(norm('Elevación')).toBe('elevacion')
    expect(norm('C&J')).toBe('c and j')
  })

  it('reads -es plurals in the singular, and plain -s plurals still', () => {
    expect(norm('Crunches')).toBe(norm('crunch'))
    expect(norm('Tuck Crunches')).toBe('tuck crunch')
    expect(norm('push presses')).toBe(norm('push press'))
    expect(norm('push press')).toBe('push press')
    expect(norm('boxes')).toBe('box')
    expect(norm('Hang Cleans')).toBe('hang clean')
    expect(norm('lunges')).toBe('lunge')
    expect(norm('leg raises')).toBe('leg raise')
    expect(norm('pull ups')).toBe('pull up')
  })

  it('is idempotent', () => {
    const names = [...FIXTURE.map(([raw, rawName]) => [raw, rawName]).flat(), 'boxes', 'push presses', 'glasses', 'buzzes', 'sizes', "DB´ s", 'C&J']
    for (const s of names) expect(norm(norm(s)), s).toBe(norm(s))
  })

  it('a pick for a name the table already knows wins over the table', () => {
    expect(resolveMovement({ rawName: 'copas' }, { copa: { exId: '1741', _ts: 1 } })).toEqual({ exId: '1741', via: 'user' })
  })

  it('a removed pick ({ _ts } only) falls back to the table', () => {
    expect(resolveMovement({ rawName: 'copas' }, { copa: { _ts: 2 } })).toEqual({ exId: '0430', via: 'shipped' })
  })
})

describe('crossfit resolve: catalogue search', () => {
  it('takes a clear hit on the English name', () => {
    expect(resolveMovement({ rawName: 'giros rusos', name: 'russian twist' })).toEqual({ exId: '0687', via: 'search' })
    expect(resolveMovement({ rawName: 'k2e', name: 'hanging knees to elbows' })).toEqual({ exId: '3890', via: 'search' })
    expect(resolveMovement({ rawName: 'dominadas', name: 'pull-up' })).toEqual({ exId: '0652', via: 'search' })
  })

  it('leaves a name the catalogue has in several kinds to a pick', () => {
    expect(resolveMovement({ rawName: 'colgadas', name: 'hang clean' })).toEqual({ exId: null, via: null })
    expect(resolveMovement({ rawName: 'zancadas kb', name: 'kettlebell goblet lunge' })).toEqual({ exId: null, via: null })
  })

  it('leaves a vague or unknown name to a pick', () => {
    expect(resolveMovement({ rawName: 'nastys', name: 'nasty' })).toEqual({ exId: null, via: null })
    expect(resolveMovement({ rawName: 'machine' })).toEqual({ exId: null, via: null })
    expect(resolveMovement({ rawName: 'kips', name: 'kip swing' })).toEqual({ exId: null, via: null })
    expect(resolveMovement({})).toEqual({ exId: null, via: null })
  })
})

describe('crossfit aliases table', () => {
  it('keys are their own norm() and every id is a catalogue exercise', () => {
    for (const [key, id] of Object.entries(SHIPPED_ALIASES)) {
      expect(norm(key), key).toBe(key)
      expect(EXIDX[id]?.id, key).toBe(id)
    }
  })
})
