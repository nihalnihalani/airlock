/**
 * One-use claim + receipt storage (bun:sqlite). A row exists only for an ACCEPTED submission; the
 * PRIMARY KEY on proposal_id makes the claim atomic, so a second submission with the same proposal
 * id (any values) is a replay. Refused submissions store nothing.
 */
import { Database } from "bun:sqlite";

export type Receipt = { proposalId: string; formId: string; payloadDigest: string; receiptId: string; at: string };

export class ReceiptStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      proposal_id    TEXT PRIMARY KEY,
      form_id        TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      receipt_id     TEXT NOT NULL UNIQUE,
      at             TEXT NOT NULL
    ) STRICT;`);
  }

  /** "ok" if this call created the receipt; "replay" if the proposal id was already used. */
  claim(r: Receipt): "ok" | "replay" {
    const result = this.db
      .query("INSERT INTO receipts (proposal_id, form_id, payload_digest, receipt_id, at) VALUES ($p, $f, $d, $r, $a) ON CONFLICT(proposal_id) DO NOTHING")
      .run({ p: r.proposalId, f: r.formId, d: r.payloadDigest, r: r.receiptId, a: r.at });
    return result.changes === 1 ? "ok" : "replay";
  }

  get(proposalId: string): Receipt | undefined {
    const row = this.db
      .query<{ proposal_id: string; form_id: string; payload_digest: string; receipt_id: string; at: string }, { p: string }>(
        "SELECT proposal_id, form_id, payload_digest, receipt_id, at FROM receipts WHERE proposal_id = $p",
      )
      .get({ p: proposalId });
    return row ? { proposalId: row.proposal_id, formId: row.form_id, payloadDigest: row.payload_digest, receiptId: row.receipt_id, at: row.at } : undefined;
  }

  close(): void {
    this.db.close();
  }
}
