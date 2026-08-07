# syntax=docker/dockerfile:1

# Builder: compiles TypeScript. Nothing from this stage ships in the runtime image.
FROM node:26 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# .dockerignore excludes .env, .git, node_modules, dist, test/, docs/ -- the
# load-bearing control against a stray local .env landing in a layer, since
# this stage copies the whole build context.
COPY . .
RUN npm run build

# Runtime: dist/ and production dependencies only. No compiler, no source, no devDeps.
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Set by CI to the release commit SHA (src/version.ts reads this into
# ftd_exporter_build_info); defaults to "unknown" for a local/manual build.
ARG FTD_EXPORTER_COMMIT=unknown
ENV FTD_EXPORTER_COMMIT=${FTD_EXPORTER_COMMIT}

# Links the published GHCR package back to this repo (auto-detected by
# GitHub, per its container-registry docs) and identifies the image to
# scanners/SBOM tooling.
LABEL org.opencontainers.image.source="https://github.com/apilbeam101/ftd-metrics-exporter" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="ftd-metrics-exporter" \
      org.opencontainers.image.description="Prometheus exporter for Cisco FTD firewall health metrics (SCC/cdFMC and standalone on-prem FMC backends)"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Fixed non-zero UID/GID (not the image's default `node` user) so it's
# predictable for volume permissions and Kubernetes runAsUser.
RUN groupadd --gid 10001 ftd-exporter \
    && useradd --uid 10001 --gid ftd-exporter --no-create-home --shell /usr/sbin/nologin ftd-exporter
USER 10001:10001

EXPOSE 10049

# Reads METRICS_PORT and the TLS env vars so this stays correct under a
# non-default port or the native TLS listener, not just the shipped
# defaults. An explicit request timeout (not just Docker's own --timeout,
# which marks the check failed but does not reap the request) is required:
# against a hung server that accepts but never responds, a bare http.get
# with no timeout never fires its callback or its 'error' handler, leaking
# one Node process per check forever -- verified directly against a
# deliberately-hung server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "\
const https=require('node:https');const http=require('node:http');\
const port=process.env.METRICS_PORT||'10049';\
const tls=!!process.env.METRICS_TLS_CERT_PATH;\
const mod=tls?https:http;\
const opts={host:'127.0.0.1',port,path:'/healthz',timeout:3000};\
if(tls)opts.rejectUnauthorized=false;\
const req=mod.get(opts,(res)=>process.exit(res.statusCode===200?0:1));\
req.on('timeout',()=>{req.destroy();process.exit(1)});\
req.on('error',()=>process.exit(1));\
"

# Exec form: this process is PID 1 and receives SIGTERM directly, no shell
# wrapper to swallow it.
ENTRYPOINT ["node", "dist/index.js"]
