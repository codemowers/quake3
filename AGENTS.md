# Project conventions

- Keep runtime ports fixed: HTTP 8080, gateway 8081, gateway health 8082,
  Nginx health 8083, and dedicated-server UDP 27961. Do not add environment
  variables or chart values for these ports. Gateway unit tests may use
  ephemeral ports.
- Kubernetes security contexts and runtime identity belong to admission policies;
  do not render them in the chart. Compose uses UID/GID 65535.
  Keep application files root:root and mode 755 in runtime images;
  do not create image accounts or chown application code to the runtime UID.
- Preserve the existing BFF-style authentication: the gateway owns OIDC
  Authorization Code with PKCE and signed, opaque session cookies; the browser
  holds no OAuth tokens. Passmower provisions the client, only `openid` is
  requested, and the verified subject supplies the player identity. Nginx
  checks the gateway session before serving assets and WebSocket upgrades.
- Run dependency installation and regression tests in Docker. Consult only
  engineering advisory when using the ee-west Driftmower MCP for this cleanup;
  do not deploy or inspect live workloads as part of it.
- Do not add Compose health checks. Kubernetes keeps its existing internal
  readiness probes.
- Keep the legacy single-arena Pod with one replica and Recreate updates.
  Run static ioq3ded directly as PID 1, without a startup script or Node runtime.
  Package qagame.qvm in the server image and cgame.qvm/ui.qvm in the web image.
  Read PAKs from /data, compiled QVMs from /app, mounted config from /config,
  and write disposable state to /state. Never copy QVMs/config at startup.
  Nginx runs with master_process off and user root so user-namespace
  UID 0 does not attempt chown/setuid with dropped capabilities. Compose
  still runs Nginx as UID 65535. Gateway
  sessions remain disposable in-memory state, with reauthentication after
  restart. Horizontal replication requires a separate architecture decision.
- Metrics use internal HTTP on 8082, without identity labels or public routing.
  Passmower and Mittwald remain platform-owned prerequisites; the chart owns
  only per-release OIDCClient and StringSecret declarations. Game data stays
  in a separate read-only image volume.
- Derive chart-owned names and selectors from the Helm release. The platform
  owns namespace creation. Ingress class, annotations, TLS issuer and secret
  follow the platform hosting conventions: values.yaml supplies a
  short hostname, websecure routing and the Let's Encrypt issuer. Admission
  expands hostnames and supplies the Certificate's <release>-tls secret name.
- Supply image.registryPrefix for bare image references; leave it empty for
  fully qualified references. Skaffold passes its resolved references directly.
  Developer publishing must use a verified development registry; production
  publishing belongs to trusted CI. Do not infer registry permissions from a
  registry hostname.
- This is an experimental deployment: reinstalling is acceptable. Do not add
  migration procedures or compatibility scaffolding for earlier chart versions.
- Use direct Helm values and YAML anchors for repetition within a document;
  do not introduce template helper files.
- Native UDP exposure is opt-in via udpLoadBalancer.enabled (default false),
  on fixed UDP 27961. ee-lte-1 uses the Cilium Service label pool: internal.
  Native clients bypass browser OIDC; preserve the BFF for browser traffic.
- Bind game UDP to ::1 and 127.0.0.1 when the LoadBalancer is disabled, and
  :: and 0.0.0.0 when enabled. Disable multicast to preserve loopback isolation.
  Compose uses wildcard listeners for its private container network.
  Use generic udpLoadBalancer.labels and annotations for Service metadata.
- Deployment mode examples live in chart/values.websocket-oidc.yaml,
  chart/values.udp-websocket-password.yaml and chart/values.udp-only-password.yaml.
  Set game.password as a Helm string, rendered into g_password in the server
  ConfigMap. Browser players enter it; never return the password via HTTP.
  Mittwald remains only for the OIDC session-signing secret.
- Helm generates network/password settings, renders game.cvars once as seta
  flags, and appends game.configTail as literal
  Quake config. Keep browser startup config and OIDC integration separate from
  the dedicated server configuration.
- Shareware is the default data build target. GitHub Actions builds executable
  images only; never download PAKs, build data images or push images there.
