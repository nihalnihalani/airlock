/**
 * Minimal hash router. Routes are data; unknown or malformed hashes become `notfound` instead of
 * being interpolated anywhere. Task ids must be plain identifiers (contracts `plainId`).
 */
import { plainId } from "@airlock/contracts";
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "login" }
  | { name: "new" }
  | { name: "tasks" }
  | { name: "task"; id: string }
  | { name: "hostile" }
  | { name: "notfound"; path: string };

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = raw.length > 0 ? raw : "/";
  const segments = path.split("?")[0]?.split("/").filter((s) => s.length > 0) ?? [];
  if (segments.length === 0) return { name: "home" };
  const [head, second, ...rest] = segments;
  if (rest.length > 0) return { name: "notfound", path: path.slice(0, 200) };
  switch (head) {
    case "login":
      return second === undefined ? { name: "login" } : { name: "notfound", path: path.slice(0, 200) };
    case "new":
      return second === undefined ? { name: "new" } : { name: "notfound", path: path.slice(0, 200) };
    case "hostile":
      return second === undefined ? { name: "hostile" } : { name: "notfound", path: path.slice(0, 200) };
    case "tasks": {
      if (second === undefined) return { name: "tasks" };
      let decoded = second;
      try {
        decoded = decodeURIComponent(second);
      } catch {
        return { name: "notfound", path: path.slice(0, 200) };
      }
      return plainId.safeParse(decoded).success
        ? { name: "task", id: decoded }
        : { name: "notfound", path: path.slice(0, 200) };
    }
    default:
      return { name: "notfound", path: path.slice(0, 200) };
  }
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "login":
      return "#/login";
    case "new":
      return "#/new";
    case "tasks":
      return "#/tasks";
    case "task":
      return `#/tasks/${encodeURIComponent(route.id)}`;
    case "hostile":
      return "#/hostile";
    case "notfound":
      return "#/";
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getSnapshot(): string {
  return window.location.hash;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getSnapshot, () => "#/");
  return parseHash(hash);
}
