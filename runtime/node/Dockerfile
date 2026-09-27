# Airlock offline Node runtime: airlock-runtime-node:<tag>
#
# Build via runtime/node/build.sh (stages a minimal context with the repository-relative layout).
#
# Base image pin: the multi-arch INDEX digest of node:24-slim (Node 24 = current Active LTS,
# Debian 12 "bookworm" slim). Resolved 2026-09-27 from registry-1.docker.io
# (library/node/manifests/24-slim, docker-content-digest):
#   index  sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
#   amd64  sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
#   arm64  sha256:24b8bc17702002d2ed0c1da9ad66c3ee507cc279d0856726662ff2b6fc35c149
#   (node v24.21.0, npm 11.19.0 — npm is used only in the deps stage and is absent from the image)

# ---- deps: the only step with network. npm ci verifies every tarball against the sha512
# `integrity` in the committed package-lock.json and refuses a lock/package.json mismatch;
# --ignore-scripts means no install script of any package ever runs.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS deps
WORKDIR /opt/airlock/node
COPY runtime/node/package.json runtime/node/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier \
 && npm ls --all --omit=dev > /opt/airlock/node/npm-ls.txt \
 && rm -rf /root/.npm

# ---- runtime
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# Remove every package manager: npm, npx, corepack, yarn (the base image ships all four). At runtime
# `npm i x`, `npx x`, `corepack enable` and `yarn add x` are "command not found", and there is no
# npm-cli.js left to invoke with `node` directly.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /usr/local/bin/docker-entrypoint.sh \
           /usr/local/include/node /root/.npm /root/.cache

COPY --from=deps --chown=root:root /opt/airlock/node /opt/airlock/node
# ESM and CJS resolution from /workspace/code/*.mjs walks up to /node_modules: point it at the baked,
# root-owned, read-only dependency tree (NODE_PATH does not apply to ESM imports).
RUN ln -s /opt/airlock/node/node_modules /node_modules

# The base image's `node` user is uid:gid 1000:1000; it owns only /workspace (a per-attempt tmpfs).
ENV HOME=/tmp \
    NODE_ENV=production \
    NO_UPDATE_NOTIFIER=1
RUN usermod --home /tmp node \
 && mkdir -p /workspace && chown 1000:1000 /workspace && chmod 0755 /workspace \
 && rm -rf /home/node

# Fixed runtime scripts: probe shim + Node port of the probe, runner, build self-check.
COPY --chown=root:root runtime/node/probe.sh runtime/node/probe.mjs runtime/node/run.sh runtime/node/image_check.mjs /opt/airlock/

RUN find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} + \
 && find /opt/airlock -type d -exec chmod 0555 {} + \
 && find /opt/airlock -type f -exec chmod 0444 {} + \
 && chmod 0555 /opt/airlock/probe.sh /opt/airlock/run.sh \
 && node /opt/airlock/image_check.mjs \
 && rm -rf /tmp/* /var/tmp/*

LABEL org.opencontainers.image.title="airlock-runtime-node" \
      airlock.base.index-digest="sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6" \
      airlock.role="node"

USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
