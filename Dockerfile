# syntax=docker/dockerfile:1
# NocoDB (community edition) built from source.
# Layout matches the official image: node docker/index.js in /usr/src/app.

ARG NODE_VERSION=24.14.0
ARG PNPM_VERSION=10.34.7
# Release version of the code. The API reads it from package.json.
ARG NC_VERSION=2026.09.1

############################
# Base: Node, pnpm, compilers
############################
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
# Compilers are needed for native modules (sqlite3, sharp, msgpackr-extract).
RUN apk add --no-cache python3 make g++ libc6-compat \
    && npm install -g pnpm@${PNPM_VERSION}
WORKDIR /build
# pnpm must use the Node of the image, not download its own.
COPY .npmrc ./
RUN sed -i '/^use-node-version/d' .npmrc

############################
# SDKs and integrations core: the nc-gui postinstall ("nuxt prepare") needs the built SDK,
# so build the SDKs before the full install (same order as "pnpm bootstrap").
############################
FROM base AS sdk
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store     pnpm install --frozen-lockfile --filter nocodb-sdk... --filter nocodb-sdk-v2...
RUN pnpm --filter nocodb-sdk run build:main \
    && pnpm --filter nocodb-sdk run build:module \
    && pnpm --filter nocodb-sdk-v2 run build

# The API imports @noco-integrations/core at run time, so build it too.
# Its install needs the built SDK ("file:" dependency).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    cd packages/noco-integrations \
    && pnpm install --frozen-lockfile --filter @noco-integrations/core... \
    && pnpm --filter @noco-integrations/core run build

############################
# Install the rest of the workspace (frozen lockfile)
############################
FROM sdk AS install
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter nocodb... --filter nc-gui...

############################
# Build: gui -> api bundle
############################
FROM install AS build
# Cap the V8 heap so the build does not take all the memory of the host.
ARG BUILD_MAX_OLD_SPACE=4096
ENV NODE_OPTIONS=--max-old-space-size=${BUILD_MAX_OLD_SPACE} \
    NUXT_TELEMETRY_DISABLED=1 \
    CI=true

# Static GUI (Nuxt, ssr: false) into packages/nc-gui/.output/public.
RUN cd packages/nc-gui && NODE_ENV=production pnpm exec nuxt generate

# API bundle: packages/nocodb/docker/index.js
RUN cd packages/nocodb \
    && pnpm exec rspack --config docker/rspack.config.js \
    && mkdir -p docker/public \
    && cp -r src/public/. docker/public/ \
    && cp -r ../nc-gui/.output/public docker/nc-gui

############################
# Production dependencies of the API only
############################
FROM base AS deps
ARG NC_VERSION
# Wait for the build stage. Both stages together would add up their memory.
COPY --from=build /build/packages/nocodb/docker/public/favicon.ico /tmp/after-build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
# Flat node_modules (no symlinks), like the official image.
# deploy installs from the workspace lockfile (frozen).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    npm_config_node_linker=hoisted \
    pnpm --filter nocodb --config.inject-workspace-packages=true deploy --prod /deploy

# The repository keeps a placeholder version. Set the release version.
RUN node -e "const f='/deploy/package.json',p=require(f);p.version=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(p,null,2))" "${NC_VERSION}"

# nocodb-sdk is inside the bundle. nc-lib-gui is not used by the bundle.
# Then remove files that are not needed at run time (types, maps, docs).
RUN cd /deploy/node_modules \
    && rm -rf nocodb-sdk nc-lib-gui sqlite3/deps \
    && find . -type d \( -name dist-types -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find . -type f \( -name '*.map' -o -name '*.md' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) \
         -not -path './typescript/*' -delete

############################
# Runtime
############################
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /usr/src/app
ENV NC_DOCKER=0.6 \
    NC_TOOL_DIR=/usr/app/data/ \
    NODE_ENV=production \
    PORT=8080

RUN apk --no-cache upgrade \
    && apk --no-cache add dumb-init curl jq \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=deps /deploy/node_modules ./node_modules
COPY --from=deps /deploy/package.json ./package.json
COPY --from=build /build/packages/nocodb/docker/index.js ./docker/index.js
COPY --from=build /build/packages/nocodb/docker/nc-gui ./docker/nc-gui
COPY --from=build /build/packages/nocodb/docker/public ./docker/public

RUN mkdir -p /usr/src/appEntry \
    && printf '%s\n' \
      '#!/bin/sh' \
      'if [ -n "${NC_TOOL_DIR}" ]; then' \
      '  mkdir -p "${NC_TOOL_DIR}"' \
      'fi' \
      'exec node docker/index.js' \
      > /usr/src/appEntry/start.sh \
    && chmod +x /usr/src/appEntry/start.sh

EXPOSE 8080
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/src/appEntry/start.sh"]
