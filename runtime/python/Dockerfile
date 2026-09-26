# syntax=docker/dockerfile:1
# Airlock pinned Python runtime image: airlock-runtime-python:<profileId>
#
# Build from the REPOSITORY ROOT (the context must contain profiles/ and runtime/):
#   docker build -f runtime/python/Dockerfile --build-arg PROFILE=tabulate-365 \
#       --build-arg ADAPTER_MODULE=airlock_adapter_tabulate -t airlock-runtime-python:tabulate-365 .
# runtime/python/build.sh <profileId> does this after prepare-profile.sh has verified the base tree.
#
# Base image pin. Tag in FROM; the digest observed via `docker image inspect python:3.12-slim`
# on the build host (2026-09-26, linux/arm64 dev machine, Docker 29.5.2):
#   python:3.12-slim = sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
#   (Python 3.12.14, Debian 13.7 "trixie" slim)
# build.sh records the base digest it actually built from and the image id/digest it produced;
# the supervisor records the image digest it actually ran (RuntimeInspection.imageDigest).
FROM python:3.12-slim

ARG PROFILE
ARG ADAPTER_MODULE
RUN test -n "$PROFILE" && test -n "$ADAPTER_MODULE" \
 || { echo "build-args PROFILE and ADAPTER_MODULE are required" >&2; exit 1; }

# No pip, no network, no bytecode writes at runtime. PIP_NO_INDEX is belt-and-braces: the sandbox
# has no network anyway, and the profile schema declares no runtime dependencies (tabulate has
# none), so nothing is ever installed into this image beyond the base interpreter.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_INDEX=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/workspace

# Non-root identity 1000:1000 with HOME=/workspace. /workspace is the only writable location and is
# always supplied by the supervisor as a per-attempt volume or tmpfs (the rootfs is read-only).
RUN groupadd --gid 1000 airlock \
 && useradd --uid 1000 --gid 1000 --home-dir /workspace --no-create-home --shell /bin/bash airlock \
 && mkdir -p /workspace /opt/airlock/base /opt/airlock/profile \
 && chown 1000:1000 /workspace && chmod 0755 /workspace

# Fixed runtime scripts (root-owned, executable, not writable).
COPY --chown=root:root runtime/python/adapter.py runtime/python/materialize.py runtime/python/collector.py \
     runtime/python/probe.sh runtime/python/tree_digest.py runtime/python/image_check.py /opt/airlock/
# Pristine baseline tree of the profile's baselineCommit (verified by prepare-profile.sh; verified again below).
COPY --chown=root:root profiles/${PROFILE}/base/ /opt/airlock/base/
# Profile manifest and adapter module ONLY. The acceptance contract (contract.json) is deliberately
# NOT copied: the sandbox never sees the expected values (CLAUDE.md §3.1, §3.4).
COPY --chown=root:root profiles/${PROFILE}/profile.json profiles/${PROFILE}/${ADAPTER_MODULE}.py /opt/airlock/profile/

# Self-check (fails the build on any mismatch), then lock modes: 0555 dirs/scripts, 0444 files.
# Setuid/setgid bits are stripped from the whole image as defence in depth; the supervisor also
# runs every container with cap-drop ALL and no-new-privileges.
RUN python3 /opt/airlock/image_check.py "$PROFILE" "$ADAPTER_MODULE" \
 && find /opt/airlock -type d -exec chmod 0555 {} + \
 && find /opt/airlock -type f -exec chmod 0444 {} + \
 && chmod 0555 /opt/airlock/adapter.py /opt/airlock/materialize.py /opt/airlock/collector.py \
               /opt/airlock/probe.sh /opt/airlock/tree_digest.py /opt/airlock/image_check.py \
 && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} + \
 && rm -rf /root/.cache /tmp/* /var/tmp/*

USER 1000:1000
WORKDIR /workspace
# Author sandbox process: an idle sleep that the supervisor execs into (like OpenMuse computers).
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
