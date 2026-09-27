import { describe, expect, test } from "bun:test";
import type { ActionProposal } from "@airlock/contracts";
import { STORE_KIND_PROPOSALS, settleOpenProposals } from "../src/proposals.ts";
import { createStore } from "../src/store/index.ts";

const OWNER = "judge-race";
const at = new Date().toISOString();
const proposal = (status: ActionProposal["status"]): ActionProposal => ({
  schemaVersion: 1,
  id: "prop-race",
  owner: OWNER,
  taskId: "task-race",
  attemptId: "att-race",
  browserGeneration: 3,
  destination: "https://forms.example.org",
  adapter: "airlock-forms-v1",
  formId: "contact-request",
  fields: { name: "a", email: "b", message: "c" },
  payloadDigest: "a".repeat(64),
  summary: "s",
  createdAt: at,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  status,
});

describe("settleOpenProposals races", () => {
  test("a decide that wins the swap after settle read `pending` is still settled (approved → expired), never left approved", async () => {
    const store = await createStore();
    try {
      await store.put(OWNER, STORE_KIND_PROPOSALS, proposal("pending"));
      // Interleave: the first compare-and-swap the settle pass attempts finds the row already
      // moved to `approved` by a concurrent decision.
      const original = store.compareAndSwap.bind(store);
      let raced = false;
      store.compareAndSwap = (async (...args: Parameters<typeof store.compareAndSwap>) => {
        if (!raced) {
          raced = true;
          await store.put(OWNER, STORE_KIND_PROPOSALS, proposal("approved"));
        }
        return original(...args);
      }) as typeof store.compareAndSwap;
      const emitted: string[] = [];
      const out = await settleOpenProposals(store, { owner: OWNER, taskId: "task-race", why: "run cancelled", forms: null, emit: async (_k, title) => void emitted.push(title) });
      expect(out[0]?.status).toBe("expired");
      expect((await store.get<ActionProposal>(OWNER, STORE_KIND_PROPOSALS, "prop-race"))?.status).toBe("expired");
      expect(emitted).toContain("Proposal expired");
    } finally {
      await store.close();
    }
  });
});
