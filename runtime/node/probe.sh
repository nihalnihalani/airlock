#!/bin/bash
# Airlock isolation probe shim for the Node runtime image (no Python in this image).
#
# The supervisor invokes every runtime's probe the same way:
#   /bin/bash --noprofile --norc /opt/airlock/probe.sh --workspace-bytes N
# Here that execs the Node port, /opt/airlock/probe.mjs, which prints the identical JSON document
# as runtime/python/probe.sh. The environment is cleared first so NODE_OPTIONS / NODE_PATH or any
# other variable cannot inject code or flags into the probe.
set -u
NODE_BIN=/usr/local/bin/node
if [[ ! -x "$NODE_BIN" ]]; then
  echo '{"metadataEndpoint":"UNKNOWN","dns":"UNKNOWN","outboundTcp":"UNKNOWN","dockerSocket":"UNKNOWN","hostMounts":"UNKNOWN","allBlocked":false,"details":{"error":"node not found"}}'
  exit 3
fi
exec /usr/bin/env -i PATH=/usr/bin:/bin "$NODE_BIN" --no-warnings /opt/airlock/probe.mjs "$@"
