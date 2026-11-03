# Deploying the Kinau fork

How the `Kinau-Guatemala/openGym` fork is run: on a home server with Docker Compose, and on Railway. Both use the images the fork publishes itself. The general self-hosting guide ([SELF_HOSTING.md](SELF_HOSTING.md)) still applies; this page only covers what is specific to the fork.

## What the fork publishes

| Artifact | Where | When |
| --- | --- | --- |
| `ghcr.io/kinau-guatemala/opengym-api:edge` | GitHub Container Registry | every push to `main` (`docker-publish.yml`) |
| `ghcr.io/kinau-guatemala/opengym-web:edge` | GitHub Container Registry | every push to `main` |
| Signed APK, `gt.kinau.opengym` | GitHub release of the tag | every `v*` tag (`android-release.yml`) |

After the first publish, make both packages **public** so neither target needs registry credentials:
github.com/orgs/Kinau-Guatemala/packages → `opengym-api` / `opengym-web` → Package settings → Change visibility → Public.

Check with `docker logout ghcr.io && docker pull ghcr.io/kinau-guatemala/opengym-web:edge`.

Release tags follow upstream with a counter: `v1.4.1-kinau.1`, `v1.4.1-kinau.2`, … After pulling in an upstream release, start again at its version: the sync with upstream 1.4.3 (Nov 2026) makes the next tag `v1.4.3-kinau.1`. Never mark these as pre-releases, because the in-app updater reads `releases/latest`.

## Home server (Docker Compose)

1. Clone the fork and create the env file:

   ```bash
   git clone git@github.com:Kinau-Guatemala/openGym.git && cd openGym
   cp .env.example .env
   ```

2. Point Compose at the fork's images with a `compose.override.yml` next to `docker-compose.yml`:

   ```yaml
   services:
     api:
       image: ghcr.io/kinau-guatemala/opengym-api:edge
     web:
       image: ghcr.io/kinau-guatemala/opengym-web:edge
   ```

   Or skip the override and build from source with `docker compose up -d --build`.

3. Set the origin in `.env`. Passkeys need HTTPS on an exact hostname (see SELF_HOSTING.md for Caddy, Cloudflare Tunnel, Traefik or nginx in front):

   ```env
   RP_ID=gym.example.com
   ORIGIN=https://gym.example.com
   WEB_PORT=8080
   FIRST_USER_ADMIN=1      # the first profile created becomes admin
   # API_TARGET=coach      # only for the Coach on a Claude subscription (Agent SDK)
   ```

   Leave `API_TARGET` unset for the Anthropic, OpenAI or OpenAI-compatible coach providers: they are plain HTTPS calls and need no `coach` image. Set `API_TARGET=coach` here, in `.env`, only to run the Coach on a Claude subscription through the Agent SDK (see [The AI Coach](#the-ai-coach-both-targets)). The fork publishes no `coach` image, so that api is always built from source.

4. Start the stack and create the profile:

   ```bash
   docker compose pull && docker compose up -d                                          # API_TARGET unset
   docker compose pull web && docker compose up -d --build api && docker compose up -d  # API_TARGET=coach
   ```

   Open `https://gym.example.com` and create the profile with a passkey.

   **Updating** runs the same line again, after a `git pull` for the `coach` build. With `API_TARGET=coach`, never run a bare `docker compose pull`: it replaces the built api with the published default image, which has no Claude runtime, and the next `up -d` runs that.

5. Back up `./data`, for example with a nightly `tar czf opengym-$(date +%F).tgz data/`.

## Railway

Two services from the public images, plus one volume. Railway gives each service its own `PORT`. The `web` image uses `PORT` to mean *the api's port*, so pin it explicitly on both services.

### `api` service

| Setting | Value |
| --- | --- |
| Source | Docker image `ghcr.io/kinau-guatemala/opengym-api:edge` |
| Volume | mounted at `/data` |
| `DATA_DIR` | `/data` |
| `PORT` | `3000` |
| `RP_ID` | the web service's public hostname, e.g. `opengym-web.up.railway.app` or a custom domain |
| `ORIGIN` | `https://` + that hostname |
| `TRUST_PROXY` | `1` |
| `FIRST_USER_ADMIN` | `1` (remove once the admin profile exists) |
| Public networking | none, since only `web` talks to it |

### `web` service

| Setting | Value |
| --- | --- |
| Source | Docker image `ghcr.io/kinau-guatemala/opengym-web:edge` |
| `NGINX_PORT` | `8080` |
| Public networking | generate a domain, target port **8080** |
| `BACKEND` | `api.railway.internal` (the api service's private hostname) |
| `PORT` | `3000` (the api's port, which nginx proxies `/api` to) |
| `RESOLVER` | the `nameserver` from the web service's `/etc/resolv.conf`, **in brackets if it's an IPv6 address** (e.g. `[fd12::10]`); see the check below |
| `RESOLVER_IPV6` | `on` only if `api.railway.internal` has no IPv4 address |

### The DNS check (do this first)

nginx resolves `BACKEND` at runtime through `RESOLVER`. The Docker default `127.0.0.11` doesn't exist on Railway. After the first deploy, open a shell in the `web` service (Railway dashboard → service → Shell, or `railway ssh`) and run:

```sh
cat /etc/resolv.conf                 # the nameserver to use as RESOLVER
getent ahosts api.railway.internal   # IPv4 (A), IPv6 (AAAA), or both
```

Two independent settings come out of this:

- **`RESOLVER`** is the `nameserver` line from `resolv.conf`. If it's an IPv6 address (Railway's usually is, e.g. `fd12::10`), it **must be in brackets**: `RESOLVER=[fd12::10]`. Without brackets nginx reads the last group as a port and the web service won't start.
- **`RESOLVER_IPV6`** depends on what `getent` printed for `api.railway.internal`. If it shows at least one IPv4 address, leave it `off`. If it shows only IPv6 addresses, set it to `on`.

Redeploy `web`. Every `/api` call hanging is the symptom of a wrong resolver.

### Railway checklist

1. Create the project, then add the `api` service with its volume and variables, then `web`.
2. Run the DNS check and set `RESOLVER` and `RESOLVER_IPV6`.
3. Open the public domain, create the profile with a passkey, and log a workout.
4. Redeploy `api` and confirm the workout is still there, which proves the volume works.
5. Pair a second device (Settings → Account → Pair the mobile app) and confirm it syncs.

**Backups:** Railway volume snapshots, plus a periodic export (Settings → Export in the app, or `GET /api/data` with a session).

## The AI Coach (both targets)

The CrossFit module's image parsing runs on the Coach with Anthropic, OpenAI, an OpenAI-compatible endpoint (pick a vision model), or **Claude (Anthropic)** through the Agent SDK.

1. **Settings → Account → Admin dashboard → AI Coach:**
   - **Set up the Coach**, turn the master switch on, and pick **Anthropic** or **OpenAI**;
   - paste the API key, **List models**, choose a vision-capable model, then **Test the Coach**.

   **Or on a Claude subscription** (Pro/Max), with no per-token key:
   - build the api with the runtime in it: `API_TARGET=coach` in `.env`, then `docker compose up -d --build api` (`--build` matters: with a prebuilt `image:` set, compose would otherwise use the published default image, which has no runtime). Update it with `git pull && docker compose up -d --build api`, never a bare `docker compose pull` (step 4 of the home server setup);
   - on a machine where you use Claude Code, run `claude setup-token`, finish the browser sign-in and copy the token;
   - pick **Claude (Anthropic)**, **Add Claude Code token**, paste it, then **Test the Coach**.

   Who pays follows the credential: a setup token spends the Claude subscription it was made on, an Anthropic API key pasted under the same chip is billed to its Console account. A setup token binds to the first profile that uses it (see AI_COACH.md, *Whose account pays*). Use your own account, not a work subscription, unless your employer agrees.
2. Open **Plan → Coach** once and accept the consent screen. It lists the shared image.
3. Share a routine image to openGym (Android APK) or upload it on the CrossFit screen. It parses into the review screen.

`COACH_DISABLED=1` in the api environment switches the Coach off everywhere, whatever the admin card says.

## The box feed

Every program one account saves can be published to a public `feed.json`, so the box's members read the day's program without parsing the image themselves. The api pushes the file into a dedicated GitHub repo through the contents API; members read it from `https://raw.githubusercontent.com/<owner>/<repo>/main/feed.json`. No GitHub Actions or Pages are involved.

1. Create a **public** repo for it, e.g. `Kinau-Guatemala/holy-wods`, with a README saying what it is.
2. Create a fine-grained token (GitHub → Settings → Developer settings → Fine-grained tokens) for that repo only, with **Contents: read and write** and nothing else.
3. Set the api's environment (`.env` on the home server, the api service's variables on Railway):

   | Variable | Value |
   | --- | --- |
   | `BOX_FEED_UID` | the publishing account's id (Settings → Account → Account ID, signed in as that account) |
   | `BOX_FEED_REPO` | `owner/repo` |
   | `BOX_FEED_TOKEN` | the token |
   | `BOX_FEED_NAME` | the box's name, e.g. `Holy Program` |
   | `BOX_FEED_DAYS` | optional, past days kept (default 14); upcoming programs are always in |

   With any of the first four missing, publishing is off and nothing else changes.
4. Restart the api. It checks the account's programs at start, and after every save it waits 30 seconds for more saves (5 minutes at most after the first), then pushes once if what the feed carries changed. A failed push is retried after 1, 5 and 15 minutes, then waits for the next save.
5. **Admin dashboard → Box feed** shows when it last published, or the error. **Settings → CrossFit** on the publishing account shows the feed's link and a QR code for members to scan.

The feed carries each program's date, title, tracks, blocks and movements (printed text, dose, Rx, steps, the catalogue exercise it resolved to; a custom exercise goes without its id), the box name and when it was updated. Never logged scores, picks, notes or anything else from the account: the fields are an allowlist (`api/box-feed.js`). The token is only ever sent to GitHub, never to the app, the data folder or the logs. `DATA_DIR/box-feed.json` keeps the hash of the last push and its status.

## The Android app

Install the APK from the fork's latest GitHub release. It is `gt.kinau.opengym` and installs alongside the upstream app. Sign in or pair it with the instance. Turn on **Settings → Health Connect** so it writes workouts and reads runs. Updates are offered in-app from the fork's releases.

The release signing key lives outside the repository. Keep it in a password manager with its password, and back it up. If it's lost, the installed app can't be updated without uninstalling.
