# Airlock browser runtime: headless Chromium + the fixed runner, nothing else.
#
# Base: official Playwright image, pinned by multi-arch index digest. The playwright-core npm
# version (package-lock.json) MUST equal the image tag version; bump both or neither.
#   mcr.microsoft.com/playwright:v1.63.0-noble
#   index digest sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
#   (amd64 sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7,
#    arm64 sha256:a0f4498920a5dbac63196d9140ed738ef00470f27e2e74029abd8850b7bd5717)
#
# Run it ONLY with the hardened flags in demo.sh / the supervisor browser profile: non-root pwuser,
# --read-only, tmpfs /tmp and /run/airlock, --cap-drop ALL, no-new-privileges, seccomp=seccomp/chromium.json,
# an --internal network whose only peer is the per-attempt egress proxy.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    AIRLOCK_RUNNER_SOCKET=/run/airlock/runner.sock

WORKDIR /opt/airlock
COPY package.json package-lock.json ./
# Headless Chromium only: drop Firefox, WebKit, the headed Chromium build and ffmpeg, then the
# package managers, so the runtime filesystem carries only what the runner launches.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-* /ms-playwright/ffmpeg-* \
           /ms-playwright/chromium-[0-9]* \
 && rm -rf /root/.npm /usr/lib/node_modules/npm /usr/lib/node_modules/corepack /usr/lib/node_modules/yarn \
           /usr/bin/npm /usr/bin/npx /usr/bin/corepack /usr/bin/yarn /usr/bin/yarnpkg \
 && test "$(node -p 'require("playwright-core/package.json").version')" = "1.63.0" \
 && ls -d /ms-playwright/chromium_headless_shell-*
COPY src/ ./
RUN node --check runner.mjs && node --check client.mjs && chmod -R a-w /opt/airlock

USER pwuser
HEALTHCHECK --interval=5s --timeout=5s --start-period=5s --retries=12 \
  CMD ["sh", "-c", "echo '{\"schemaVersion\":1,\"op\":\"status\"}' | node /opt/airlock/client.mjs >/dev/null"]
ENTRYPOINT ["node", "/opt/airlock/runner.mjs"]
