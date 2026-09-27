// Supervisor-placed upload resolution (shared by the runner's upload op and the in-image harness).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UploadRefused, placedUpload } from "../src/uploads.mjs";

test("only a regular, unlinked file whose sha256 matches is handed out", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "airlock-up-")));
  const bytes = Buffer.from("airlock synthetic upload\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(path.join(root, "up-0000000000000001"));
  fs.writeFileSync(path.join(root, "up-0000000000000001", "a.txt"), bytes);
  assert.deepEqual(placedUpload("up-0000000000000001", "a.txt", sha, root), { file: path.join(root, "up-0000000000000001", "a.txt"), size: bytes.length });
  assert.throws(() => placedUpload("up-0000000000000001", "a.txt", "0".repeat(64), root), UploadRefused);
  assert.throws(() => placedUpload("up-0000000000000002", "a.txt", sha, root), /has not been placed/);
  fs.mkdirSync(path.join(root, "up-0000000000000003"));
  fs.symlinkSync(path.join(root, "up-0000000000000001", "a.txt"), path.join(root, "up-0000000000000003", "a.txt"));
  assert.throws(() => placedUpload("up-0000000000000003", "a.txt", sha, root), /not a regular file/);
  fs.symlinkSync(path.join(root, "up-0000000000000001"), path.join(root, "up-0000000000000004"));
  assert.throws(() => placedUpload("up-0000000000000004", "a.txt", sha, root), /not a regular file/);
  fs.rmSync(root, { recursive: true, force: true });
});
