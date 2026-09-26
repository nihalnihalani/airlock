import { describe, expect, test } from "bun:test";
import { attemptLabels, attemptNames, oneShotLabels, oneShotNames, ours, ownedFilter, resolveNamespace, validateId } from "../src/names";

describe("names", () => {
  test("accepts plain identifiers and derives container/volume/collector names", () => {
    const r = attemptNames("airlock", "task_1", "attempt-A", "author");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.container).toBe("airlock-author-task_1-attempt-A");
    expect(r.value.volume).toBe("airlock-ws-task_1-attempt-A");
    expect(r.value.collector).toBe("airlock-collector-task_1-attempt-A");
  });

  test.each([
    ["", "empty"],
    ["../etc", "traversal"],
    ["a/b", "slash"],
    ["a.b", "dot"],
    ["a:b", "colon"],
    ["a b", "space"],
    ["-lead", "leading hyphen"],
    ["x".repeat(65), "too long"],
    [42, "not a string"],
  ])("rejects %p (%s)", (raw) => {
    expect(validateId(raw, "id").ok).toBe(false);
    expect(attemptNames("airlock", raw, "ok", "author").ok).toBe(false);
    expect(attemptNames("airlock", "ok", raw, "author").ok).toBe(false);
    expect(oneShotNames("airlock", "ok", raw, "candidate").ok).toBe(false);
  });

  test("rejects unknown roles", () => {
    expect(attemptNames("airlock", "t", "a", "root").ok).toBe(false);
    expect(oneShotNames("airlock", "t", "op", "shell").ok).toBe(false);
  });

  test("labels carry owner, namespace, task, attempt and role", () => {
    const r = attemptNames("ns1", "t1", "a1", "author");
    if (!r.ok) throw new Error(r.reason);
    const labels = attemptLabels(r.value);
    expect(labels).toEqual({
      "airlock.supervisor": "true",
      "airlock.namespace": "ns1",
      "airlock.task": "t1",
      "airlock.attempt": "a1",
      "airlock.role": "author",
    });
    expect(attemptLabels(r.value, "collector")["airlock.role"]).toBe("collector");
    const o = oneShotNames("ns1", "t1", "op9", "candidate");
    if (!o.ok) throw new Error(o.reason);
    expect(oneShotLabels(o.value)["airlock.operation"]).toBe("op9");
    expect(oneShotLabels(o.value)["airlock.attempt"]).toBe("op-op9");
  });

  test("ownership requires the owner label and the same namespace", () => {
    expect(ours("ns1", { "airlock.supervisor": "true", "airlock.namespace": "ns1" })).toBe(true);
    expect(ours("ns1", { "airlock.supervisor": "true", "airlock.namespace": "ns2" })).toBe(false);
    expect(ours("ns1", { "airlock.supervisor": "true" })).toBe(false);
    expect(ours("ns1", { "airlock.namespace": "ns1" })).toBe(false);
    expect(ours("ns1", null)).toBe(false);
  });

  test("owned filter narrows by task and attempt", () => {
    expect(ownedFilter("ns", { taskId: "t", attemptId: "a" })).toEqual([
      "airlock.supervisor=true",
      "airlock.namespace=ns",
      "airlock.task=t",
      "airlock.attempt=a",
    ]);
  });

  test("namespace defaults and is validated", () => {
    expect(resolveNamespace(undefined)).toBe("airlock");
    expect(resolveNamespace("  ")).toBe("airlock");
    expect(resolveNamespace("prod-1")).toBe("prod-1");
    expect(() => resolveNamespace("bad/ns")).toThrow();
  });
});
