# Quake III in the browser

Source-built ioquake3 with a WebAssembly client, Nginx front end and an OIDC
WebSocket-to-UDP gateway. The static dedicated server runs directly as PID 1;
game PAKs live in a separate read-only image.

## Local development

Requires Docker Engine and Compose with `type: image` volume support.

```sh
docker build --target shareware-data -t quake3-data:latest game-data
docker compose up --build
```

Open <http://localhost:8080>. Compose allows anonymous play by default. For OIDC,
set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
`OIDC_REDIRECT_URI` (ending in `/auth/callback`) and `OIDC_SESSION_SECRET`
(at least 32 random bytes). Partial OIDC configuration fails startup.

Hard-refresh the browser after switching data images to replace cached PAKs.

## Kubernetes development

```sh
cp skaffold.env.example skaffold.env
```

Replace every `...` in `skaffold.env` with your development Kubernetes context,
platform-provisioned namespace and a registry repository verified to allow
development publishing. Skaffold loads this file automatically; Git ignores it.
See [Skaffold environment files](https://skaffold.dev/docs/environment/env-file/).

```sh
skaffold dev             # Shareware
skaffold dev -p retail   # Retail data with the space-map rotation overlay
```

The chart assumes platform admission for hostname expansion, certificate secret
naming and runtime security. Passmower, Mittwald and cert-manager must already be
available. Kubernetes must support image volumes. One arena runs in one Pod with
Recreate updates; game state and gateway sessions are disposable.

## Configuration

[chart/values.yaml](chart/values.yaml) documents the game flags, maps, MOTD,
password, ingress and image settings. `game.cvars` renders each flag once;
`game.configTail` contains literal map/rotation commands. Skaffold supplies
resolved image references; standalone Helm can use `image.registryPrefix`.

Deployment examples:

- [Browser with OIDC](chart/values.websocket-oidc.yaml) (default).
- [Browser and native UDP with a password](chart/values.udp-websocket-password.yaml).
- [Native UDP only with a password](chart/values.udp-only-password.yaml).
- [Shareware map rotation](chart/values.map-rotation.yaml).

Layer a deployment mode over the defaults and replace its example password.
Native clients connect on UDP 27961 and bypass browser OIDC. Browser OAuth tokens
stay in the gateway; restarting it requires players to sign in again.

For engine configuration and console commands, see the
[ioquake3 server guide](https://ioquake3.org/help/sys-admin-guide/) and
[player guide](https://ioquake3.org/help/players-guide/). This project uses UDP
27961 rather than upstream's default port. Browser startup settings live in
`web/index.html`; Compose server defaults live in `engine/server.cfg`.

Escape releases pointer lock; F9 opens the game menu.

## Checks

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/app" -w /app node:24.8.0-bookworm-slim \
  sh -c 'npm ci && npm run lint && npm test'
helm lint --strict chart
```

GitHub Actions runs regression tests and configuration checks and builds the
server, gateway and web images. It never pushes images, builds data images or
downloads game PAKs. Source pins and engine patches live in
`engine/Dockerfile` and `engine/patches/`; licensing is in [COPYING](COPYING).
