import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decodePolyline, formatDuration, summarizeTraffic } from "../lib/format.js";
import { departureTimeOrNow, toWaypoint } from "../lib/google.js";
import { secretMatches } from "../lib/auth.js";
import { googleMapsLink, handoffBlock, wazeLink } from "../lib/links.js";
import { arrivalSentence, timeZoneFor } from "../lib/arrival.js";

const SECRET = "a".repeat(48);
const MILE_LAT = 1 / 69.05; // degrees of latitude per mile

function encodePolyline(points) {
  let out = "";
  let prevLat = 0;
  let prevLng = 0;
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e5);
    const ln = Math.round(lng * 1e5);
    out += enc(la - prevLat) + enc(ln - prevLng);
    prevLat = la;
    prevLng = ln;
  }
  return out;
}

// 100-mile straight route, one point per mile.
const POINTS = Array.from({ length: 101 }, (_, i) => [30 + i * MILE_LAT, -91]);
const POLYLINE = encodePolyline(POINTS);

function fakeRoute({ duration, staticDuration, description, jam }) {
  const intervals = jam
    ? [
        { endPolylinePointIndex: jam[0], speed: "NORMAL" },
        { startPolylinePointIndex: jam[0], endPolylinePointIndex: jam[1], speed: "TRAFFIC_JAM" },
        { startPolylinePointIndex: jam[1], endPolylinePointIndex: 100, speed: "NORMAL" },
      ]
    : [{ endPolylinePointIndex: 100, speed: "NORMAL" }];
  return {
    duration: `${duration}s`,
    staticDuration: `${staticDuration}s`,
    distanceMeters: 160934,
    description,
    polyline: { encodedPolyline: POLYLINE },
    travelAdvisory: { speedReadingIntervals: intervals },
  };
}

let google;
let app;
let lastGoogleBodies = [];
let baseUrl;

beforeAll(async () => {
  google = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      lastGoogleBodies.push({ body, headers: req.headers });
      res.setHeader("Content-Type", "application/json");
      if (body.destination.address === "Nowhere") {
        res.statusCode = 400;
        res.end("{}");
        return;
      }
      const via = body.intermediates?.[0]?.address;
      let routes;
      if (via === "Henderson, LA") {
        routes = [fakeRoute({ duration: 3 * 3600 + 30 * 60, staticDuration: 2 * 3600 + 30 * 60, description: "I-12 W and I-10 W", jam: [50, 56] })];
      } else if (via === "Morgan City, LA") {
        routes = [fakeRoute({ duration: 2 * 3600 + 50 * 60, staticDuration: 2 * 3600 + 40 * 60, description: "US-90 W" })];
      } else {
        routes = [
          fakeRoute({ duration: 9000, staticDuration: 8000, description: "I-10 W", jam: [10, 12] }),
          fakeRoute({ duration: 9900, staticDuration: 9600, description: "US-90 W" }),
        ];
      }
      res.end(JSON.stringify({ routes }));
    });
  });
  await new Promise((r) => google.listen(0, r));
  process.env.ROUTES_ENDPOINT = `http://127.0.0.1:${google.address().port}/routes`;
  process.env.MCP_PATH_SECRET = SECRET;
  process.env.GOOGLE_MAPS_API_KEY = "test-key";

  const { default: handler } = await import("../api/mcp.js");
  // Mimics Vercel: applies the vercel.json rewrite and pre-parses JSON bodies.
  app = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const m = /^\/mcp\/([^/?]+)/.exec(req.url);
      req.query = m ? { s: m[1] } : {};
      req.body = raw ? JSON.parse(raw) : undefined;
      await handler(req, res);
    });
  });
  await new Promise((r) => app.listen(0, r));
  baseUrl = `http://127.0.0.1:${app.address().port}`;
});

afterAll(() => {
  google?.close();
  app?.close();
});

async function connect() {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${SECRET}`)));
  return client;
}

describe("helpers", () => {
  it("formats durations for speech", () => {
    expect(formatDuration(45 * 60)).toBe("45 minutes");
    expect(formatDuration(3600)).toBe("1 hour");
    expect(formatDuration(2 * 3600 + 61 * 60)).toBe("3 hours 1 minute");
  });

  it("decodes Google's sample polyline", () => {
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it("measures jam miles and distance ahead", () => {
    const t = summarizeTraffic(POINTS, [
      { endPolylinePointIndex: 50, speed: "NORMAL" },
      { startPolylinePointIndex: 50, endPolylinePointIndex: 56, speed: "TRAFFIC_JAM" },
    ]);
    expect(t.jamMiles).toBeCloseTo(6, 0);
    expect(t.firstJamMile).toBeCloseTo(50, 0);
  });

  it("parses coordinates as lat/lng and everything else as an address", () => {
    expect(toWaypoint("30.2766, -89.7812")).toEqual({ location: { latLng: { latitude: 30.2766, longitude: -89.7812 } } });
    expect(toWaypoint("Lafayette, LA", { via: true })).toEqual({ address: "Lafayette, LA", via: true });
  });

  it("treats past departure times as now", () => {
    expect(departureTimeOrNow("2020-01-01T00:00:00Z")).toBeUndefined();
    expect(departureTimeOrNow("2999-01-01T00:00:00Z")).toBe("2999-01-01T00:00:00.000Z");
  });

  it("builds a Google Maps navigation link with via points and no origin", () => {
    const url = new URL(googleMapsLink("Lafayette, LA", ["Morgan City, LA"]));
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/dir/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("destination")).toBe("Lafayette, LA");
    expect(url.searchParams.get("waypoints")).toBe("Morgan City, LA");
    expect(url.searchParams.get("dir_action")).toBe("navigate");
    expect(url.searchParams.has("origin")).toBe(false);
    expect(url.toString()).toContain("waypoints=Morgan+City%2C+LA");
  });

  it("caps Google Maps waypoints at three for phones", () => {
    const url = new URL(googleMapsLink("Lafayette, LA", ["A", "B", "C", "D"]));
    expect(url.searchParams.get("waypoints")).toBe("A|B|C");
    expect(url.toString()).toContain("A%7CB%7CC");
  });

  it("builds Waze links for addresses and coordinates", () => {
    const a = new URL(wazeLink("Lafayette, LA"));
    expect(a.origin + a.pathname).toBe("https://waze.com/ul");
    expect(a.searchParams.get("q")).toBe("Lafayette, LA");
    expect(a.searchParams.get("navigate")).toBe("yes");
    const b = new URL(wazeLink("30.2241, -92.0198"));
    expect(b.searchParams.get("ll")).toBe("30.2241,-92.0198");
  });

  it("sends Waze to the first via point when a route is forced", () => {
    const block = handoffBlock([{ label: "US-90", destination: "Lafayette, LA", via: ["Morgan City, LA"] }]);
    expect(block).toContain("[US-90 in Google Maps](https://www.google.com/maps/dir/?");
    expect(block).toContain("[US-90 in Waze, to Morgan City, LA first](https://waze.com/ul?q=Morgan+City%2C+LA");
    expect(block).toContain("keep driving when it says you've arrived");
  });

  it("picks the destination time zone from the state", () => {
    expect(timeZoneFor("Lafayette, LA")).toBe("America/Chicago");
    expect(timeZoneFor("123 Main St, St. Augustine, FL 32084")).toBe("America/New_York");
    expect(timeZoneFor("Pensacola, FL")).toBe("America/Chicago");
    expect(timeZoneFor("Lafayette, Louisiana")).toBe("America/Chicago");
    expect(timeZoneFor("30.2,-92.0")).toBeNull();
  });

  it("gives arrival clock time in the destination zone, crossing from Eastern to Central", () => {
    const now = Date.parse("2026-11-25T11:30:00Z"); // 6:30 AM Eastern
    expect(arrivalSentence(9 * 3600 + 10 * 60, "Lafayette, LA", null, now)).toBe("You'd arrive about 2:40 PM Central.");
    expect(arrivalSentence(14 * 3600, "Lafayette, LA", null, now)).toBe("You'd arrive about 7:30 PM Central.");
    expect(arrivalSentence(20 * 3600, "Lafayette, LA", null, now)).toBe("You'd arrive about 1:30 AM Central on Thursday.");
    expect(arrivalSentence(3600, "Somewhere", null, now)).toBe("");
  });

  it("rejects wrong or short secrets", () => {
    expect(secretMatches("x", SECRET)).toBe(false);
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches("short", "short")).toBe(false);
  });
});

describe("HTTP endpoint", () => {
  it("returns 404 for a wrong secret and 405 for GET", async () => {
    const bad = await fetch(`${baseUrl}/mcp/${"b".repeat(48)}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(404);
    const get = await fetch(`${baseUrl}/mcp/${SECRET}`);
    expect(get.status).toBe(405);
  });

  it("lists the five tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_preset", "compare_routes", "get_drive_time", "open_in_maps", "ping"]);
    await client.close();
  });

  it("answers get_drive_time with traffic and an alternate", async () => {
    lastGoogleBodies = [];
    const client = await connect();
    const result = await client.callTool({ name: "get_drive_time", arguments: { origin: "30.28,-89.78", destination: "Lafayette, LA" } });
    const out = result.content[0].text;
    expect(out).toContain("Right now: 2 hours 30 minutes via I-10 W");
    expect(out).toContain("Traffic is adding about 17 minutes");
    expect(out).toContain("2 miles of stopped or crawling traffic, starting about 10 miles ahead");
    expect(out).toContain("Alternate via US-90 W: 2 hours 45 minutes, 15 minutes slower");
    const links = result.content[1].text;
    expect(links).toContain("[Lafayette, LA in Google Maps](https://www.google.com/maps/dir/?api=1&destination=Lafayette%2C+LA");
    expect(links).toContain("[Lafayette, LA in Waze](https://waze.com/ul?q=Lafayette%2C+LA&navigate=yes");
    const sent = lastGoogleBodies[0];
    expect(sent.headers["x-goog-api-key"]).toBe("test-key");
    expect(sent.headers["x-goog-fieldmask"]).toContain("speedReadingIntervals");
    expect(sent.body.computeAlternativeRoutes).toBe(true);
    expect(sent.body.routingPreference).toBe("TRAFFIC_AWARE");
    await client.close();
  });

  it("ranks the Slidell options and flags the Basin jam", async () => {
    lastGoogleBodies = [];
    const client = await connect();
    const result = await client.callTool({
      name: "compare_routes",
      arguments: {
        origin: "Slidell, LA",
        destination: "Lafayette, LA",
        options: [
          { label: "I-12 and the Basin bridge", via: ["Henderson, LA"] },
          { label: "I-10 through New Orleans and US-90", via: ["Morgan City, LA"] },
        ],
      },
    });
    const out = result.content[0].text;
    expect(out.startsWith("Fastest right now: I-10 through New Orleans and US-90, 2 hours 50 minutes")).toBe(true);
    expect(out).toContain("I-12 and the Basin bridge: 3 hours 30 minutes, 40 minutes slower");
    expect(out).toContain("6 miles of stopped or crawling traffic, starting about 50 miles ahead");
    const links = result.content[1].text.split("\n");
    expect(links[1]).toContain("[I-10 through New Orleans and US-90 in Google Maps]");
    expect(links[1]).toContain("waypoints=Morgan+City%2C+LA");
    expect(links[3]).toContain("[I-12 and the Basin bridge in Google Maps]");
    expect(links[3]).toContain("waypoints=Henderson%2C+LA");
    for (const { body } of lastGoogleBodies) {
      expect(body.intermediates[0].via).toBe(true);
      expect(body.computeAlternativeRoutes).toBeUndefined();
    }
    await client.close();
  });

  it("check_preset runs the Slidell comparison from one name", async () => {
    lastGoogleBodies = [];
    const client = await connect();
    const result = await client.callTool({ name: "check_preset", arguments: { name: "slidell", origin: "30.28,-89.78" } });
    const out = result.content[0].text;
    expect(out.startsWith("Fastest right now: I-10 through New Orleans and US-90, 2 hours 50 minutes")).toBe(true);
    expect(out).toMatch(/You'd arrive about \d{1,2}:\d{2} [AP]M Central/);
    expect(lastGoogleBodies).toHaveLength(2);
    expect(lastGoogleBodies[0].body.origin).toEqual({ location: { latLng: { latitude: 30.28, longitude: -89.78 } } });
    expect(result.content[1].text).toContain("waypoints=Morgan+City%2C+LA");
    await client.close();
  });

  it("open_in_maps returns links without calling Google", async () => {
    lastGoogleBodies = [];
    const client = await connect();
    const result = await client.callTool({
      name: "open_in_maps",
      arguments: { destination: "Lafayette, LA", via: ["Morgan City, LA"], label: "US-90 to Lafayette" },
    });
    expect(lastGoogleBodies).toHaveLength(0);
    expect(result.content[1].text).toContain("[US-90 to Lafayette in Google Maps](https://www.google.com/maps/dir/?");
    expect(result.content[1].text).toContain("[US-90 to Lafayette in Waze, to Morgan City, LA first]");
    await client.close();
  });

  it("gives a spoken error for an address Google can't route", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_drive_time", arguments: { origin: "Slidell, LA", destination: "Nowhere" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too vague");
    await client.close();
  });
});
