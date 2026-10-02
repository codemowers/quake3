# Gateway dependencies, regression tests, and runtime.
ARG NODE_IMAGE=node:24.8.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM dependencies AS test
COPY gateway/ ./gateway/
COPY engine/ ./engine/
COPY test/ ./test/
COPY web/ ./web/
RUN npm test

FROM ${NODE_IMAGE} AS web-gateway
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json gateway/auth.js gateway/gateway.js gateway/server.js ./
RUN chmod -R 755 /app
ENV NODE_ENV=production
EXPOSE 8081/tcp
ENTRYPOINT ["node", "/app/server.js"]
