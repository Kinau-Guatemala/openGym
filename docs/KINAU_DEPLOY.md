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

Release tags follow upstream with a counter: `v1.4.1-kinau.1`, `v1.4.1-kinau.2`, … After pulling in an upstream release (say 1.4.2), start again at `v1.4.2-kinau.1`. Never mark these as pre-releases, because the in-app updater reads `releases/latest`.

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
   ```

   Leave `API_TARGET` unset. The Anthropic and OpenAI coach providers are plain HTTPS calls and need no `coach` image.

4. Start the stack and create the profile:

   ```bash
   docker compose pull && docker compose up -d
   ```

   Open `https://gym.example.com` and create the profile with a passkey.

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

The CrossFit module's image parsing runs on the Coach with Anthropic or OpenAI.

1. **Settings → Account → Admin dashboard → AI Coach:**
   - **Set up the Coach**, turn the master switch on, and pick **Anthropic** or **OpenAI**;
   - paste the API key, **List models**, choose a vision-capable model, then **Test the Coach**.
2. Open **Plan → Coach** once and accept the consent screen. It lists the shared image.
3. Share a routine image to openGym (Android APK) or upload it on the CrossFit screen. It parses into the review screen.

`COACH_DISABLED=1` in the api environment switches the Coach off everywhere, whatever the admin card says.

## The Android app

Install the APK from the fork's latest GitHub release. It is `gt.kinau.opengym` and installs alongside the upstream app. Sign in or pair it with the instance. Turn on **Settings → Health Connect** so it writes workouts and reads runs. Updates are offered in-app from the fork's releases.

The release signing key lives outside the repository. Keep it in a password manager with its password, and back it up. If it's lost, the installed app can't be updated without uninstalling.
