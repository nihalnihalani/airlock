// Fixed client run by the supervisor via `docker exec -i <browser> node /opt/airlock/client.mjs`.
// Reads ONE JSON request (<= 256 KiB) from stdin, forwards it as one line over the runner's unix
// socket, writes ONE JSON response line (<= 4 MiB) to stdout.
//
// Exit codes: 0 = a well-formed runner response was written (ok true OR false);
//             2 = the client refused the input itself (error line still written);
//             3 = transport failure: runner unavailable, timeout, oversized/malformed response.

import net from "node:net";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, SCHEMA_VERSION, errorResponse } from "./protocol.mjs";

const SOCKET_PATH = process.env.AIRLOCK_RUNNER_SOCKET ?? "/run/airlock/runner.sock";
const TIMEOUT_MS = Math.min(Number(process.env.AIRLOCK_CLIENT_TIMEOUT_MS) || 90_000, 300_000);

function finish(response, code) {
  process.stdout.write(`${typeof response === "string" ? response : JSON.stringify(response)}\n`, () => process.exit(code));
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const input = await readStdin();
if (input === null) finish(errorResponse(null, null, "request_too_large", `request exceeds ${MAX_REQUEST_BYTES} bytes`), 2);
else {
  let line;
  try {
    // Re-serialized so the request is exactly one line whatever whitespace the caller used.
    line = JSON.stringify(JSON.parse(input));
  } catch {
    finish(errorResponse(null, null, "invalid_request", "stdin is not a single JSON value"), 2);
  }
  if (line !== undefined) send(line);
}

function send(line) {
  const socket = net.createConnection(SOCKET_PATH);
  let received = Buffer.alloc(0);
  let settled = false;
  const fail = (error, message) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    finish(errorResponse(null, null, error, message), 3);
  };
  const timer = setTimeout(() => fail("timeout", `no response within ${TIMEOUT_MS} ms`), TIMEOUT_MS);
  socket.on("error", (error) => fail("runner_unavailable", error.code ?? error.message));
  socket.on("connect", () => socket.write(`${line}\n`));
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (received.length > MAX_RESPONSE_BYTES) fail("response_too_large", "runner response exceeded 4 MiB");
  });
  socket.on("end", () => {
    if (settled) return;
    clearTimeout(timer);
    const text = received.toString("utf8").trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch {}
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.ok !== "boolean" || text.includes("\n")) {
      return fail("runner_unavailable", "malformed runner response");
    }
    settled = true;
    finish(text, 0);
  });
}
