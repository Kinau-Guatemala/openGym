// The box feed's format and allowlist (api/box-feed.js), for the app: the api builds feed.json
// with it, a member's app reads one back through the same allowlist. One copy, imported across
// like api/coach/core, so the two sides cannot drift.
export * from '../../../api/box-feed.js'
