# syntax=docker/dockerfile:1
# Excaliboard editor → static self-host bundle, served by nginx.
# NOTE: build is the full Vite monorepo build (mirrors `yarn build:selfhost`,
# the same path the cosmos CI uses). Not container-tested in this repo yet —
# `docker compose up` / the health-gated cosmos deploy is the integration test.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN npm install -g yarn@1.22.22 --force
# Vite resolves @excalidraw/* from packages/*/src, so the whole tree is needed.
COPY . .
RUN yarn install --frozen-lockfile --network-timeout 600000
RUN yarn build:selfhost   # -> excalidraw-app/build (self-destroying SW)

FROM nginx:1.27-alpine
# nginx.conf is mounted by docker-compose (it's outside the build context's
# allowlist) — see selfhost/docker-compose.yml.
COPY --from=build /repo/excalidraw-app/build /usr/share/nginx/html
