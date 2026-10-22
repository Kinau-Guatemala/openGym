/* The data categories the consent screen names (FR-09/10).
 *
 * Its own tiny module so a screen that only needs to *say* what would leave — the mobile setup
 * screen, before anything AI-related has been loaded — can import five strings without pulling
 * the payload builder and the exercise catalogue behind it. payload.js re-exports it, and
 * builds from it, so the screen cannot drift from the payload. */
export const DATA_CATEGORIES = Object.freeze([
  'plan',        // routines, exercises, sets/reps, schedule, progression settings
  'training',    // logged sets, targets, effort ratings, durations, PRs, session notes in the review window
  'bodyweight',  // weigh-ins in the window and your goal weight
  'profile',     // the intake answers you gave the Coach, including any limitations
  'prefs',       // unit, language, effort scale
  'image'        // a routine image you share to be read, sent once and never stored
]);

// Bumping this re-prompts everyone: it means what we share, or who we share it with, changed.
// Here rather than in the client, because the server holds a parse-wod job to it as well.
// 2: the training line names the session notes, which the payload carries and version 1 never
// mentioned. 3: the `image` category.
export const CONSENT_VERSION = 3;
