// Download accounting for the browser runner (C16). Pure (no Playwright, no fs), so the limits are
// unit-testable without Chromium; runner.mjs feeds it events and sizes and acts on its decisions.
//
// Limits (per browser attempt = per container):
//   - count:    at most maxCount downloads are ever ADMITTED (in progress or completed); later ones are
//               cancelled at once and recorded as `count_limit`;
//   - per file: an in-progress download whose partial file grows past maxFileBytes is cancelled
//               (`size_limit`), and a completed file is checked again;
//   - total:    completed bytes + in-progress bytes may not exceed maxTotalBytes (`total_limit`).
// Records are bounded too (maxRecords): the oldest cancelled/failed record is dropped first.

import { MAX_DOWNLOADS, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_TOTAL_BYTES } from "./protocol.mjs";

export class DownloadLedger {
  #next = 1;

  constructor({ maxFileBytes = MAX_DOWNLOAD_BYTES, maxCount = MAX_DOWNLOADS, maxTotalBytes = MAX_DOWNLOAD_TOTAL_BYTES, maxRecords = 50 } = {}) {
    this.limits = { maxFileBytes, maxCount, maxTotalBytes };
    this.maxRecords = maxRecords;
    this.records = new Map(); // downloadId -> record
  }

  get admitted() {
    return [...this.records.values()].filter((r) => r.state === "in_progress" || r.state === "completed").length;
  }

  get completedBytes() {
    return [...this.records.values()].filter((r) => r.state === "completed").reduce((n, r) => n + r.bytes, 0);
  }

  inProgress() {
    return [...this.records.values()].filter((r) => r.state === "in_progress");
  }

  #insert(record) {
    while (this.records.size >= this.maxRecords) {
      const victim = [...this.records.values()].find((r) => r.state === "cancelled" || r.state === "failed");
      if (!victim) break;
      this.records.delete(victim.downloadId);
    }
    this.records.set(record.downloadId, record);
  }

  /** A download started. Returns the record; `record.state` is `cancelled` when it was not admitted. */
  begin({ suggestedFilename, url, tabId }) {
    const record = {
      downloadId: `dl-${this.#next++}`,
      suggestedFilename,
      url,
      tabId,
      state: "in_progress",
      startedAt: new Date().toISOString(),
    };
    if (this.admitted >= this.limits.maxCount) {
      record.state = "cancelled";
      record.reason = "count_limit";
    }
    this.#insert(record);
    return record;
  }

  /**
   * Sizes of the partial files currently in the raw download directory. Returns the reason every
   * in-progress download must be cancelled now, or null.
   */
  progress(partialSizes) {
    if (partialSizes.some((size) => size > this.limits.maxFileBytes)) return "size_limit";
    const inFlight = partialSizes.reduce((n, size) => n + size, 0);
    if (this.completedBytes + inFlight > this.limits.maxTotalBytes) return "total_limit";
    return null;
  }

  cancel(downloadId, reason) {
    const record = this.records.get(downloadId);
    if (!record || record.state !== "in_progress") return false;
    record.state = "cancelled";
    record.reason = reason;
    record.finishedAt = new Date().toISOString();
    return true;
  }

  fail(downloadId, reason) {
    const record = this.records.get(downloadId);
    if (!record || record.state !== "in_progress") return false;
    record.state = "failed";
    record.reason = String(reason).slice(0, 200);
    record.finishedAt = new Date().toISOString();
    return true;
  }

  /** The browser finished writing. Re-checks the final size and the total; returns null or the refusal reason. */
  complete(downloadId, { bytes, sha256, mediaType }) {
    const record = this.records.get(downloadId);
    if (!record || record.state !== "in_progress") return "not_in_progress";
    let refusal = null;
    if (bytes > this.limits.maxFileBytes) refusal = "size_limit";
    else if (this.completedBytes + bytes > this.limits.maxTotalBytes) refusal = "total_limit";
    if (refusal) {
      this.cancel(downloadId, refusal);
      return refusal;
    }
    Object.assign(record, { state: "completed", bytes, sha256, mediaType, finishedAt: new Date().toISOString() });
    return null;
  }

  get(downloadId) {
    return this.records.get(downloadId) ?? null;
  }

  /** The public view (no internal handles). */
  list() {
    return {
      downloads: [...this.records.values()].map(({ done, ...r }) => r),
      admitted: this.admitted,
      completedBytes: this.completedBytes,
      limits: { ...this.limits },
    };
  }
}
