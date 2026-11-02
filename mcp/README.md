# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Claude Code, Cursor, Cline, Continue, etc.) read your openGym
profile, log a workout you describe to it, and in HTTP mode change it once you approve: routines,
workouts, body-weight log, estimated 1RMs, muscle balance, and the CrossFit side: posted
programs, the hypertrophy gap, lift-day suggestions and records.

It reads from one of two sources:

- **file** (`OPENGYM_DATA`): your self-hosted `./data` directory, when the MCP runs on the
  same machine as the api. No extra authentication: it reads the same `state-<uid>.json` files
  the api writes, and never sees passkeys, VAPID keys or session secrets.
- **HTTP** (`OPENGYM_URL`): your instance's own api, for when the data is somewhere the MCP has
  no disk access to (a Railway deploy, a home server). It signs in with a pairing code, like the
  mobile app — see [HTTP mode](#http-mode-pairing).

It runs locally as a stdio process spawned by the LLM client and adds no new container. The file
source is read-only. `log_workout` writes through your server once it is paired (see
[Logging workouts](#logging-workouts)); the HTTP source's other write tools also write through
the api, and only after a dry run (see [Write tools](#write-tools)).

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Phase 1 of a multi-phase plan, plus the first write tools. See **Roadmap** below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Claude Code: `claude mcp add opengym -e OPENGYM_URL=https://gym.example.com -- node /absolute/path/to/openGym/mcp/src/index.js`
(or `-e OPENGYM_DATA=…` for the file source). For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

To let the agent change routines, the week plan and the log (HTTP mode only), add
`"OPENGYM_MCP_WRITES": "1"` to `env` (see [Write tools](#write-tools)).

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## HTTP mode (pairing)

1. In openGym, signed in as the profile the agent should read, open **Settings → Account →
   Pair the mobile app**. It shows a one-time code, valid for 5 minutes.
2. Redeem it from the machine the LLM client runs on:

   ```bash
   node src/index.js pair https://gym.example.com ABCD1234
   ```

   This calls `POST /api/pair/redeem` and stores `{ token, user }` in
   `~/.config/opengym-mcp/<host>[_<path>].json` (`$XDG_CONFIG_HOME` is honoured), mode `0600`.
3. Start the server with `OPENGYM_URL=https://gym.example.com` instead of `OPENGYM_DATA`.

Every start calls `GET /api/me`. Once the token is past half its life (`SESSION_DAYS`, 90 by
default) the api hands back a fresh one, which replaces the stored token, so a server you use
at least every few weeks never expires. Reads are `GET /api/data`, one per tool call. If the
token is refused (90 idle days, or *Sign out everywhere*), every tool answers with an `EAUTH`
error that says to pair again; once you have, the next tool call picks up the new token, with no
restart. A request that gets no answer within 20 s fails (`OPENGYM_TIMEOUT_MS` to change it).

**Security.** The token is a **full session of that profile**, the same the mobile app holds:
whoever has the file can read and change everything in it, and if the profile is an admin, the
admin dashboard too. Keep the file private (it is created `0600` in a `0700` directory; don't
sync it, commit it or paste it anywhere). To revoke it, use *Sign out everywhere* in Settings,
which ends every session of the profile, the phone's included. The token (and the pairing code)
only travel over **HTTPS**: an `http://` URL is refused unless it points at this machine
(`localhost`, `127.0.0.1`, `::1`), or you set `OPENGYM_ALLOW_HTTP=1` because the network in between
is trusted. Redirects are not followed (they would drop the token): use the final `https://`
address.

Text in a posted program came from a photo and is returned as `raw_untrusted` (and benchmark
names with a note saying so): the agent should treat it as data, never as instructions.

## Tools

Thirteen read tools and `log_workout`, plus four more write tools when `OPENGYM_MCP_WRITES=1`.

### Read tools

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |
| `get_wods` | The CrossFit programs saved for a date range: tracks, blocks, movements with the resolved exercise (an unconfirmed best guess is flagged `exercise_guess`, with its candidates), dose and Rx. Image text is marked untrusted. |
| `muscle_gap` | The hypertrophy gap: effective sets per week per muscle against the target, split into WOD / Pump / own lifting. |
| `suggest_lift_days` | Which of the next 7 days suit lower- and upper-body lifting around the usual runs and the posted WODs. |
| `crossfit_records` | Benchmark scores (Rx and scaled), lift PRs from WODs, the movements furthest from Rx, and gymnastics skills. |
| `log_workout` | *Writes.* "I did dumbbell curls, 12 kg, 12/12/10" → a logged session in your history, on every device. Needs pairing: [Logging workouts](#logging-workouts). |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

### Write tools

| Tool | What it changes |
|---|---|
| `create_routine` | Adds a routine built from catalogue exercise ids, with the app's defaults for anything not given (3 × 10 for weights). Unknown ids are refused. Returns the new `routine_id`. |
| `update_routine` | Renames a routine and/or replaces its exercise list. An exercise that stays keeps its other settings (rest, increment, superset). |
| `assign_weekday` | Puts routines on a weekday (Sunday=0 … Saturday=6), replacing what's there or adding to it. Other days are left as they are. |
| `log_session` | Logs a session already done from exact exercise ids, cardio included (a run with no phone at hand), filed the way the app files a past workout. For lifting described in words, `log_workout` is simpler. |

- **Off unless asked for.** The write tools are registered only when the server starts with
  `OPENGYM_MCP_WRITES=1`; otherwise the server is read-only and the client never sees them.
- **`dry_run` defaults to `true` on every write tool.** A dry run returns the change as a readable
  `diff`, and a `confirm` token (a hash of that diff), saving nothing.
  - `dry_run: false` needs that token back.
  - The change is computed again on the profile as it is when saved, and it is saved only if it
    makes the same diff. Otherwise it answers `ESTALE` and saves nothing. This also applies to the
    re-run after a conflict.
  - So a write can't happen without a dry run, and what is saved is exactly the diff that dry run
    showed.
  - **The token proves the diff is unchanged, not that a person approved it.** The agent receives
    the token from the dry run itself, so it can dry-run and then write in two calls on its own.
    The approval is yours to give in the client: leave the write tools on "ask every time" and
    never "always allow" them. Text from a posted program (`get_wods`) is untrusted, so an agent
    that has read it is exactly the case this matters for.
- **HTTP source only.** With `OPENGYM_DATA` the write tools answer `EROFS`: writing state files
  beside the api would race its own writes. Pair and use `OPENGYM_URL` instead.
- **How a write is saved.** One `GET /api/data` (the document, its revision and write id), the
  change applied to a copy, then `PUT /api/data` with `baseRev`/`baseWid` and **without**
  `stamped`, so the server stamps the change against its stored copy, at server time, the way it
  does for any API planner (`api/sync-stamps.js`). A phone that syncs later merges it like any
  other device's change.
  - If another device wrote in between, the PUT gets a 409. The change is then applied once more
    to the document that came back with it, and saved.
  - A second conflict in a row answers `ECONFLICT` and saves nothing.
  - A change that changes nothing isn't sent.

[`PLAYBOOK-hypertrophy.md`](PLAYBOOK-hypertrophy.md) is the procedure an agent follows to turn the
gap report into a 2-day lifting plan around CrossFit and runs.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## Logging workouts

`log_workout` lets you tell your LLM what you did instead of tapping it in:

> "Log today: dumbbell curls, 12 kg, three sets of 12 except the last was 10. Then planks, 3 × 60 s."

The LLM turns that into exercises and sets; the tool matches the exercises against your library,
builds the workout the way the app's Finish button does (PR badges, the next suggested weight,
warm-ups kept out of volume) and saves it through your openGym server, so every signed-in
device shows it within half a minute. Asking for the same thing twice logs it once.

Exercise names are matched the way a CSV import matches them. A common name resolves to the
library's default variant ("shoulder press" is the barbell one, "leg press" the 45° sled), and the
reply shows what it was matched to so the LLM can check with you. What it will not do is pick
between two entries: "lever chest press" is two in the library, and a name like that, or one that
matches nothing, comes back as a question with candidates. It only creates one of your own
exercises when you confirm the library has none.

It saves at most 20 workouts an hour (a forgotten week is fine, a client stuck in a loop is
not), and each save leaves one line on the MCP server's stderr with the workout's id, day and
the server revision it landed at. Workouts it logged have ids starting with `mw`.

### Pairing

Writes go through the api rather than straight into `./data`, because the api is what keeps a
phone's sync and this write from overwriting each other. So the MCP server needs your server's
address and a sign-in:

1. In the app, signed in as the profile to log into: **Settings → Account → Pair the mobile app**.
   It shows a one-time code (valid five minutes).
2. Turn the code into a token:

   ```bash
   node mcp/scripts/pair.mjs https://gym.example.com ABCD-1234
   ```

3. Add both to the MCP server's `env` in your client config:

   ```jsonc
   "env": {
     "OPENGYM_DATA": "/absolute/path/to/openGym/data",
     "OPENGYM_URL": "https://gym.example.com",
     "OPENGYM_TOKEN": "<the token pair.mjs printed>"
   }
   ```

Things to know about that token:

- It is a **full sign-in to your profile**, the same kind the paired phone app holds, not a
  workout-only key. Your client's config file holds it in plain text; treat it like a password.
- `OPENGYM_URL` has to be `https://` (plain `http://` only to `localhost`), so it never crosses a
  network in the clear.
- It lasts `SESSION_DAYS` (90 days by default). **Sign out everywhere** in Settings ends it at
  once. Either way `log_workout` then says the token was not accepted: pair again.
- Pairing again gets you a new token but does **not** end the old one. To retire a token you
  think has leaked, use Sign out everywhere (which also disconnects paired phones).
- In this fork, `OPENGYM_URL` also switches the read tools to the HTTP source ([HTTP mode](#http-mode-pairing)):
  they read through the api, and `OPENGYM_DATA` is not used. `node src/index.js pair` stores the
  token in a file, and `log_workout` uses that one when `OPENGYM_TOKEN` is not set.
- If the MCP server also reads a `./data` directory, the token has to belong to the same profile
  (`OPENGYM_UID`); a token for another one is refused. The server can be remote: without
  `OPENGYM_DATA` the read tools have nothing to read, but `log_workout` still works.

### What it does not do (yet)

- Cardio by time and speed, supersets, per-side sets. Log those in the app.
- Edit or delete a workout. Fix a mistake in the app's History.
- Complete a routine's session. A logged workout is freestyle: it counts in history, stats,
  1RM, PRs and the muscle map, and like any freestyle session it can inform a routine that has
  no history of its own, but it does not tick off a planned day or a coach week's session.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** File mode: the filesystem is the boundary — same as `docker compose` running
  on the user's box. No passkey material, VAPID keys, or session secrets ever cross it. HTTP
  mode and `log_workout`: the mobile app's pairing and the paired-session token it already
  uses; no new kind of credential, no new api route.
- **No telemetry.** File mode's read tools make no network call; HTTP mode and `log_workout`
  talk only to your own openGym server. The process exits when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
```

The tool tests seed state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on) and run twice (vitest projects `file` and `http`): once against the file
source and once against a stub api over real HTTP (`test/source.js`). The write path runs
against the real api (`test/write-api.test.js` boots `api/server.js` on a temp data directory,
so `cd api && npm ci` first): server stamping, a phone push after an MCP write, the 409 → retry
path, and that a dry run never writes. Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

`log_workout` has two more files: `write-tools.test.js` against a stand-in api (conflicts,
retries, a rejected token, dry runs, duplicates), and `log-workout.e2e.test.js` against the real
`api/server.js` on a temp data directory, which needs `npm ci` in `api/` (it skips without it on
a laptop and fails under `CI`). The workout it builds is tested in
`frontend/src/lib/log-workout.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Phase 2:** read+write over stdio, in pieces (#116). Writes go through the api's own
  `PUT /api/data` with the revision they read, as a paired device does, rather than into
  `state-<uid>.json` directly: the api is the one writer of that file, and its sync stamps are
  what keep a write from being undone by the next phone that merges.
  - **Done:** `log_workout`, on the paired-session token (`scripts/pair.mjs`).
  - **Done (fork):** the HTTP source with pairing, and the CrossFit read tools.
  - **Done (fork):** write tools over the HTTP source (server-stamped, `dry_run` by default):
    `create_routine`, `update_routine`, `assign_weekday`, `log_session`.
  - Next: `add_bodyweight`, `override_day`, log corrections.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
