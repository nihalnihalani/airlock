// Turning Playwright's `ariaSnapshot({ mode: "ai" })` output into a flat, bounded control list.
//
// Adapted from OpenBot `agent-computer/src/aria-snapshot.ts`
// (https://github.com/CopilotKit/OpenBot, commit 1ac9c35b393152e8d7e76c2331b8d5b584ba0e13).
// MIT License, Copyright (c) 2026 CopilotKit. Permission is hereby granted, free of charge, to any
// person obtaining a copy of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following conditions: The above
// copyright notice and this permission notice shall be included in all copies or substantial portions
// of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Airlock changes: plain JavaScript (runs inside the image with no build step); the `yaml`
// dependency is replaced by a line scanner for the snapshot's list-of-entries shape (quoted keys and
// values handled); limit raised to 300; the file imports nothing so it is testable without a browser.

export const CONTROL_LIMIT = 300;
const FIELD_LIMIT = 200;

const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox",
]);
const CHECKABLE_ROLES = new Set(["checkbox", "menuitemcheckbox", "menuitemradio", "radio", "switch"]);

/** The first `limit` UTF-16 code units, one fewer when the cut would split a surrogate pair. */
export function cutAtCodeUnits(text, limit) {
  const sliced = text.slice(0, limit);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/** Read `textbox "Customer name:" [ref=e5] [checked]` (scanned, since parts can contain each other). */
export function parseDescriptor(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let index = 0;
  while (index < trimmed.length && trimmed[index] !== " " && trimmed[index] !== '"' && trimmed[index] !== "[") index += 1;
  const role = trimmed.slice(0, index);
  if (!role) return null;
  let name = "";
  const flags = new Map();
  while (index < trimmed.length) {
    const char = trimmed[index];
    if (char === '"') {
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== '"') {
        if (trimmed[index] === "\\" && index + 1 < trimmed.length) {
          collected += trimmed[index + 1];
          index += 2;
          continue;
        }
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      name = collected;
      continue;
    }
    if (char === "[") {
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== "]") {
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      const equals = collected.indexOf("=");
      if (equals === -1) flags.set(collected.trim(), "");
      else flags.set(collected.slice(0, equals).trim(), collected.slice(equals + 1).trim());
      continue;
    }
    index += 1;
  }
  return { role, name, flags };
}

/** Split one list item into its YAML key (unquoted) and optional scalar value. */
export function splitItem(item) {
  let key;
  let rest;
  if (item.startsWith("'")) {
    let i = 1;
    let buf = "";
    while (i < item.length) {
      if (item[i] === "'") {
        if (item[i + 1] === "'") { buf += "'"; i += 2; continue; }
        break;
      }
      buf += item[i];
      i += 1;
    }
    key = buf;
    rest = item.slice(i + 1);
  } else if (item.startsWith('"')) {
    let i = 1;
    while (i < item.length && item[i] !== '"') i += item[i] === "\\" ? 2 : 1;
    const raw = item.slice(0, i + 1);
    try { key = JSON.parse(raw); } catch { key = raw.slice(1, -1); }
    rest = item.slice(i + 1);
  } else {
    let i = 0;
    let inQuote = false;
    let inBracket = false;
    let split = -1;
    while (i < item.length) {
      const c = item[i];
      if (inQuote) {
        if (c === "\\") { i += 2; continue; }
        if (c === '"') inQuote = false;
      } else if (inBracket) {
        if (c === "]") inBracket = false;
      } else if (c === '"') inQuote = true;
      else if (c === "[") inBracket = true;
      else if (c === ":" && (i + 1 === item.length || item[i + 1] === " ")) { split = i; break; }
      i += 1;
    }
    key = split === -1 ? item : item.slice(0, split);
    rest = split === -1 ? "" : item.slice(split);
  }
  let value;
  if (rest.startsWith(":")) {
    const v = rest.slice(1).trim();
    if (v && v !== "|" && v !== ">" && v !== "|-" && v !== ">-") value = unquoteScalar(v);
  }
  return { key, value };
}

function unquoteScalar(v) {
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  return v;
}

/** Snapshot text → { controls, truncated, refs }. Never throws. */
export function parseAriaSnapshot(snapshot, limit = CONTROL_LIMIT) {
  const controls = [];
  let truncated = false;
  if (typeof snapshot !== "string") return { controls, truncated, refs: new Set() };
  for (const line of snapshot.split("\n")) {
    const match = /^\s*- (.*)$/.exec(line);
    if (!match) continue;
    const item = match[1];
    if (item.startsWith("/")) continue; // properties such as `/url:` and `/placeholder:`
    const { key, value } = splitItem(item);
    const descriptor = parseDescriptor(key);
    if (!descriptor || !INTERACTIVE_ROLES.has(descriptor.role)) continue;
    const ref = descriptor.flags.get("ref");
    if (!ref || !/^[a-z0-9]{1,16}$/i.test(ref)) continue;
    if (controls.length >= limit) { truncated = true; break; }
    const control = { ref, role: descriptor.role, name: cutAtCodeUnits(descriptor.name, FIELD_LIMIT) };
    if (typeof value === "string" && value.trim()) control.value = cutAtCodeUnits(value.trim(), FIELD_LIMIT);
    if (descriptor.flags.has("disabled")) control.disabled = true;
    if (descriptor.flags.has("checked")) {
      const state = descriptor.flags.get("checked");
      control.checked = state !== "mixed" && state !== "false";
    } else if (CHECKABLE_ROLES.has(descriptor.role)) control.checked = false;
    controls.push(control);
  }
  return { controls, truncated, refs: new Set(controls.map((c) => c.ref)) };
}
