# Airlock fixtures: disclosed demo destination (data page + airlock-forms-v1 controlled forms).
# Build from the REPOSITORY ROOT (the service imports packages/contracts):
#   docker build -f apps/fixtures/Dockerfile -t airlock-fixtures:dev .
# Base pinned by multi-arch index digest: oven/bun:1.3.2-slim
#   sha256:5f8d4f7d804311e9dfa3cdaa623ab1d5e9025419dd6531252492b4397be6476c
# The build stage bundles src + @airlock/contracts + zod (exact 3.25.76, the version in bun.lock) into
# one file; the runtime stage holds only that bundle. Run non-root, --read-only, --cap-drop ALL,
# no-new-privileges, with a writable volume at AIRLOCK_FIXTURES_DATA_DIR (default /data).
FROM oven/bun:1.3.2-slim@sha256:5f8d4f7d804311e9dfa3cdaa623ab1d5e9025419dd6531252492b4397be6476c AS build
WORKDIR /build
RUN echo '{"name":"fixtures-build","private":true}' > package.json && bun add --exact zod@3.25.76
COPY packages/contracts/package.json node_modules/@airlock/contracts/package.json
COPY packages/contracts/src node_modules/@airlock/contracts/src
COPY apps/fixtures/src apps/fixtures/src
COPY apps/fixtures/data apps/fixtures/data
RUN bun build apps/fixtures/src/index.ts --target=bun --outfile /out/fixtures.js

FROM oven/bun:1.3.2-slim@sha256:5f8d4f7d804311e9dfa3cdaa623ab1d5e9025419dd6531252492b4397be6476c
WORKDIR /app
COPY --from=build /out/fixtures.js ./fixtures.js
RUN chmod -R a-w /app && mkdir -p /data && chown bun:bun /data && chmod 700 /data
USER bun
ENV AIRLOCK_FIXTURES_LISTEN=0.0.0.0:3100 \
    AIRLOCK_FIXTURES_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3100
ENTRYPOINT ["bun", "fixtures.js"]
