# Airlock egress proxy: one container per browser attempt, outside the browser sandbox.
# Base pinned by multi-arch index digest: oven/bun:1.3.2-slim
#   sha256:5f8d4f7d804311e9dfa3cdaa623ab1d5e9025419dd6531252492b4397be6476c
# No dependencies beyond Bun built-ins. Run non-root, --read-only, --cap-drop ALL,
# no-new-privileges; policy comes only from AIRLOCK_EGRESS_ALLOW / AIRLOCK_EGRESS_PORTS.
FROM oven/bun:1.3.2-slim@sha256:5f8d4f7d804311e9dfa3cdaa623ab1d5e9025419dd6531252492b4397be6476c
WORKDIR /app
COPY src ./src
RUN chmod -R a-w /app
USER bun
ENV AIRLOCK_EGRESS_LISTEN=0.0.0.0:3128
EXPOSE 3128
ENTRYPOINT ["bun", "src/index.ts"]
