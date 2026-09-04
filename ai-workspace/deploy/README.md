# Deploy — `ai-workspace` (Node, zero dependencies)

The app is a single Node 20 process: `server.js` + `lib/` + `public/`, no `node_modules`,
no build step, no database server. Everything below exists to make that process restart
safely, keep its data, and answer a load balancer's health probes.

Files added for deployment:

| File | Purpose |
|---|---|
| `package.json` | `npm start` / `dev` / `smoke` / `check` / `docker:*` targets, `engines` pinning (Node ≥20 <23), provenance metadata. No dependencies, so `npm install` is a no-op |
| `.nvmrc` | `20` — pins the runtime for nvm/volta/`setup-node` |
| `Dockerfile` | `node:20-alpine`, non-root `app` user, explicit `COPY` (no `COPY . .`), OCI revision labels, `HEALTHCHECK`, exec-form `CMD` so SIGTERM reaches Node |
| `.dockerignore` | Keeps `.env`, `data/`, `tests/`, `node_modules/`, generated demos and git metadata out of the build context |
| `docker-compose.yml` | One-service runner with named volume, healthcheck, log rotation, `no-new-privileges` |
| `Procfile` | `web: node server.js` for Heroku-style builders |
| `render.yaml`, `fly.toml`, `railway.json` | PaaS manifests (see placement table below) |
| `.env.example` | Template + an explicit note that **only `PORT` is read by the server** |
| `scripts/smoke.js` | Boots the build (or probes a deployed URL) and asserts health, static shell, bootstrap, 404 and bad-request paths, plus graceful SIGTERM exit |
| `deploy/systemd/ai-workspace.service` | VM/OCI Compute unit with strict sandboxing |
| `deploy/systemd/ai-workspace.env` | `EnvironmentFile` template |
| `deploy/nginx/ai-workspace.conf` | TLS termination, SSE-safe proxying, 51 MB body limit, gated health probes, basic-auth stand-in for the missing app auth |
| `deploy/backup-data.sh` | `backup` / `show` / `restore` for `data/` (JSON store **and** `master.key`) |
| `deploy/github-actions.yml` | CI/CD gates that this build can actually pass (syntax → smoke → image build → container smoke) |

## The one invariant that matters

`./data/` holds `*.json` **and `master.key`**. That key is what decrypts every stored
provider API key (AES-256-GCM, `lib/store.js`). There is no recovery path: an ephemeral
filesystem, a lost volume, or a container recreated without a mount means users re-enter
every key, and any archive of the JSON without the key is so much noise.

So: mount a persistent volume at `/app/data` (Docker/Fly) or keep `data/` on the VM disk
and back it up (`deploy/backup-data.sh`). Anything that recreates the container without
that mount is a data-loss event, not a restart.

## Runtime contract

| Item | Value | Source |
|---|---|---|
| Entrypoint | `node server.js` | `package.json` `start` |
| Listen | `0.0.0.0:$PORT`, default `3000` | `server.js` (`HOST` is hardcoded `0.0.0.0`) |
| Liveness | `GET /api/health/live` → `200 {"ok":true,"uptime":…}` | for LB/restart decisions |
| Readiness | `GET /api/health/ready` → `200 {"ok":true,"credentials":N,"files":N}` | gate traffic on this |
| Deep health | not implemented (plan §33 `/deep` needs Postgres/Redis, absent here) | — |
| Shutdown | `SIGTERM` → flush store → exit (3 s internal cap) | `server.js` |
| Max body | 50 MB uploads / 30 MB JSON | `server.js` |
| Store | `./data/*.json`, debounced 200 ms + atomic rename | `lib/store.js` |
| Concurrency | single process; scale by replicas, no shared state to coordinate (see limits) | — |

## 1 · Docker (anywhere: laptop, VM, OCI)

```bash
cd ai-workspace
docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" -t ai-workspace:local .
docker run -d --name ai-workspace -p 3000:3000 -v ai-workspace-data:/app/data ai-workspace:local
docker inspect --format '{{json .State.Health}}' ai-workspace   # status should go "healthy"
curl -fsS localhost:3000/api/health/ready
```

Bind mount instead of a named volume, if you want `rsync`-able backups:

```bash
install -d -m 0700 -o 10001 -g 10001 /var/lib/ai-workspace/data   # image uid/gid = 10001
docker run -d -p 3000:3000 -v /var/lib/ai-workspace/data:/app/data ai-workspace:local
```

`npm run docker:build` / `docker:run` / `compose:up` wrap the same commands.

## 2 · docker compose (single VM)

```bash
cd ai-workspace
docker compose up --build -d
docker compose logs -f web
docker compose down            # volume survives; `down -v` deletes it (and the keys)
```

## 3 · Bare metal / OCI Compute VM (plan §28: private subnet, LB in front)

```bash
# one-time
useradd --system --home /opt/ai-workspace --shell /usr/sbin/nologin aiws
install -d -m 755 -o aiws -g aiws /opt/ai-workspace
git clone https://github.com/vijaykumarjogi266-star/webui /opt/ai-workspace/src
cp -R /opt/ai-workspace/src/ai-workspace /opt/ai-workspace/ai-workspace
install -m 644 /opt/ai-workspace/ai-workspace/deploy/systemd/ai-workspace.service /etc/systemd/system/
install -m 640 -o root -g aiws -d /etc/ai-workspace
systemctl daemon-reload && systemctl enable --now ai-workspace

# reverse proxy + TLS
install -m 644 /opt/ai-workspace/ai-workspace/deploy/nginx/ai-workspace.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/ai-workspace.conf /etc/nginx/sites-enabled/
htpasswd -c /etc/nginx/.ai-workspace-htpasswd admin    # the app has no auth yet; see §6
nginx -t && systemctl reload nginx
```

Deploy a new version = replace the tree, then restart (the store survives because it is
outside the app directory only if you mounted it; with `ProtectSystem=strict` the
`ReadWritePaths` line is what makes `data/` writable):

```bash
cd /opt/ai-workspace/src && git fetch && git checkout <sha>
rsync -a --delete --exclude data --exclude .env ./ai-workspace/ /opt/ai-workspace/ai-workspace/
systemctl restart ai-workspace && node /opt/ai-workspace/ai-workspace/scripts/smoke.js
```

## 4 · PaaS manifests — placement matters

| Manifest | Must live at | Notes |
|---|---|---|
| `Procfile` | app source root (`ai-workspace/`) | Heroku-style detectors read the build dir, so it is correct here |
| `render.yaml` | **repo root** | `cp ai-workspace/render.yaml render.yaml`; `rootDir: ai-workspace` is already set. Free plans have no persistent disk → keys vanish on redeploy |
| `fly.toml` | app root; use `fly deploy --path ai-workspace` | `[mounts]` gives real persistence (`fly volumes create ai_workspace_data --size 1 --region bom1`) |
| `railway.json` | **repo root** | `cp ai-workspace/railway.json railway.json`; `dockerfilePath` is already repo-root-relative. Add a Volume service for `/app/data` or accept ephemeral |

Anything not backed by a volume is a demo deployment: fine for a link you share for a
day, wrong for keys people typed in.

## 5 · Verify a deploy

```bash
node scripts/smoke.js                                  # local boot + routes + SIGTERM
SMOKE_URL=https://ai.example.com node scripts/smoke.js # against the deployed target
```

Exit 0 before you flip a load balancer. `SMOKE_URL` probes skip the spawn and just assert
the route contract, so it doubles as the post-deploy gate in the CI file.

## 6 · Read before exposing this publicly

The build is single-user and has **no authentication, no rate limiting, no per-user
isolation** (`BUILD_REVIEW.md` §3). Deployed open to the internet it is an anonymous
proxy to whoever holds a provider key, plus an open feedback inbox. Minimum for a public
host: the nginx basic-auth stand-in (or an OCI LB + IDCS/forward-auth in front), TLS
end-to-end, `/api/health/` reachable only from the LB/VN CIDR, and the `data/` dir at
`0700`. Plan sections §25 (threat model) and §28.1 (private subnets, NSG 3000 from LB
only) describe the real answer; the app-level fix belongs in the codebase, not the proxy.

## 7 · Backup, restore, rollback

```bash
APP_DIR=/opt/ai-workspace/ai-workspace deploy/backup-data.sh          # 0600 tar.gz in /var/backups
deploy/backup-data.sh show
deploy/backup-data.sh restore /var/backups/ai-workspace/ai-workspace-data-<stamp>.tar.gz
```

Copy archives off-box (`oci os object put -bn <bucket> --file …` or rclone/S3).
`deploy/backup-data.sh` verifies the tarball lists `data/master.key` before it prunes old
ones — the prune happens after, so a bad archive never silently becomes your only copy.

Rollback is redeploy-previous-tag + restart (no migrations, no schema, no cache to
flush); `data/` is forward-compatible across these builds because the store shape is
additive — but restoring an older `data/` over a newer one drops writes made since, so
snapshot before the restore.

## 8 · Scaling notes

State is a local JSON file, so **replicas do not share conversations or keys**: N
containers behind an LB are N separate apps. Keep `replicas: 1` until Postgres + Redis
(§9, §12) land, and scale a single box's worker capacity instead. Sticky sessions don't
fix it — the store, not the transport, is what is per-node.
