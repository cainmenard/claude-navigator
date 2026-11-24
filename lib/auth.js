import { timingSafeEqual } from "node:crypto";

export function secretFromRequest(req) {
  const fromQuery = req.query?.s;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("s");
    if (q) return q;
    const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

export function secretMatches(provided, expected) {
  if (!expected || expected.length < 24 || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
