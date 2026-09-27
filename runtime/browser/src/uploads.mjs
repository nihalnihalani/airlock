// Resolving a supervisor-placed upload (C17). Shared by the runner's `upload` op and the in-image
// upload harness (apps/supervisor/test/browser-files-integration.test.ts), so both check the bytes
// the same way. Only a regular file at /tmp/uploads/<uploadId>/<filename> (no symlink, realpath
// unchanged, <= MAX_UPLOAD_BYTES) whose sha256 matches is ever handed to Chromium.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "./protocol.mjs";

export class UploadRefused extends Error {}

/** The placed file's path and size, or throws UploadRefused. */
export function placedUpload(uploadId, filename, sha256, root = UPLOAD_DIR) {
  const dir = path.join(root, uploadId);
  const file = path.join(dir, filename);
  let st;
  try { st = fs.lstatSync(file); } catch { throw new UploadRefused(`upload ${uploadId} has not been placed`); }
  if (!st.isFile() || fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(file) !== file) throw new UploadRefused(`upload is not a regular file under ${root}`);
  if (st.size > MAX_UPLOAD_BYTES) throw new UploadRefused(`upload is ${st.size} bytes; limit ${MAX_UPLOAD_BYTES}`);
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== sha256) throw new UploadRefused("upload bytes do not match their sha256");
  return { file, size: st.size };
}
