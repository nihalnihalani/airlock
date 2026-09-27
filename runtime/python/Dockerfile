# syntax=docker/dockerfile:1
# Airlock pinned Python runtime image: airlock-runtime-python:<profileId>
#
# Build from the REPOSITORY ROOT (the context must contain profiles/ and runtime/):
#   docker build -f runtime/python/Dockerfile --build-arg PROFILE=tabulate-365 \
#       --build-arg ADAPTER_MODULE=airlock_adapter_tabulate -t airlock-runtime-python:tabulate-365 .
# runtime/python/build.sh <profileId> does this after prepare-profile.sh has verified the base tree.
#
# Base image pin (D2): the multi-arch INDEX digest of python:3.12-slim, so linux/amd64 (VM B) and
# linux/arm64 (dev) both resolve to a fixed manifest. Verified 2026-09-27 against Docker Hub
# (registry-1.docker.io/v2/library/python/manifests/3.12-slim, docker-content-digest):
#   index  sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
#   amd64  sha256:44ff437bba879d4941b710a369a8f19266aea34b29002807f0c487fabc9eec9b
#   arm64  sha256:950206c37262dd86c55659797f6ee418fee30535072f65a82ed470d985f5cda5
#   (Python 3.12.14, Debian 13.7 "trixie" slim)
# To move the pin: resolve the new index digest, update this line, rebuild, and redeploy (deploy
# captures the built image ID into AIRLOCK_RUNTIME_IMAGE_ID; the supervisor enforces it on every
# inspection, so a retagged airlock-runtime-python:<id> fails closed).
FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

ARG PROFILE
ARG ADAPTER_MODULE
RUN test -n "$PROFILE" && test -n "$ADAPTER_MODULE" \
 || { echo "build-args PROFILE and ADAPTER_MODULE are required" >&2; exit 1; }

# pytest is the one addition beyond the base interpreter: the repository's own test suite is the
# model's natural advisory regression check (`python -m pytest test -q -x`) and the sandbox has no
# network to install it. Pinned, installed at BUILD time (the only step with network) and before
# PIP_NO_INDEX is set; the resolved set is recorded in /opt/airlock/pip-freeze.txt and in README.md.
ARG PYTEST_VERSION=9.1.1
RUN mkdir -p /opt/airlock \
 && pip install --no-cache-dir --disable-pip-version-check "pytest==${PYTEST_VERSION}" \
 && python3 -c "import pytest; assert pytest.__version__ == '${PYTEST_VERSION}', pytest.__version__" \
 && pip freeze --disable-pip-version-check > /opt/airlock/pip-freeze.txt \
 && rm -rf /root/.cache

# No network, no installs, no bytecode writes at runtime. PIP_NO_INDEX is belt-and-braces: the
# sandbox has no network anyway, and the profile schema declares no runtime dependencies (tabulate
# has none), so nothing else is ever installed into this image.
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
