// Thin client for Google Routes API computeRoutes.
import { decodePolyline, metersToMiles, parseDurationSeconds, summarizeTraffic } from "./format.js";

const DEFAULT_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

const FIELD_MASK = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters",
  "routes.description",
  "routes.routeLabels",
  "routes.warnings",
  "routes.polyline.encodedPolyline",
  "routes.travelAdvisory.speedReadingIntervals",
].join(",");

export class MapsError extends Error {}

const LAT_LNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

// Accepts a street address, a place name, or "lat,lng" (for example from the phone's location).
export function toWaypoint(text, { via = false } = {}) {
  const match = LAT_LNG.exec(String(text));
  const waypoint = match
    ? { location: { latLng: { latitude: Number(match[1]), longitude: Number(match[2]) } } }
    : { address: String(text).trim() };
  if (via) waypoint.via = true;
  return waypoint;
}

export function departureTimeOrNow(departureTime, now = Date.now()) {
  if (!departureTime) return undefined;
  const t = Date.parse(departureTime);
  if (Number.isNaN(t)) throw new MapsError("I couldn't read that departure time. Use a full date and time with a time zone.");
  // Google rejects past times; anything within the next two minutes is treated as "now".
  if (t < now + 2 * 60 * 1000) return undefined;
  return new Date(t).toISOString();
}

export async function computeRoutes({
  apiKey,
  origin,
  destination,
  via = [],
  departureTime,
  avoid = [],
  alternatives = false,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw new MapsError("The Google Maps key isn't set up on the navigator yet, so I can't check traffic.");
  }
  const body = {
    origin: toWaypoint(origin),
    destination: toWaypoint(destination),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    extraComputations: ["TRAFFIC_ON_POLYLINE"],
    languageCode: "en-US",
    units: "IMPERIAL",
  };
  if (via.length > 0) body.intermediates = via.map((v) => toWaypoint(v, { via: true }));
  // Google does not return alternates when intermediates are present.
  if (alternatives && via.length === 0) body.computeAlternativeRoutes = true;
  const leaveAt = departureTimeOrNow(departureTime);
  if (leaveAt) body.departureTime = leaveAt;
  if (avoid.length > 0) {
    body.routeModifiers = {
      avoidTolls: avoid.includes("tolls"),
      avoidHighways: avoid.includes("highways"),
      avoidFerries: avoid.includes("ferries"),
    };
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new MapsError("I couldn't reach Google Maps just now. Try again in a minute.");
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 400 || status === 404) {
      throw new MapsError("Google couldn't route that. One of the places may be too vague; try a full address with city and state.");
    }
    if (status === 401 || status === 403) {
      throw new MapsError("Google rejected the navigator's key. The Routes API may not be enabled, or the key is restricted to the wrong API.");
    }
    if (status === 429) {
      throw new MapsError("Google Maps is busy or the navigator hit its daily limit. Try again shortly.");
    }
    throw new MapsError("Google Maps had a problem with that request. Try again in a minute.");
  }

  const data = await response.json();
  const routes = Array.isArray(data.routes) ? data.routes : [];
  if (routes.length === 0) {
    throw new MapsError("Google didn't find a driving route between those places.");
  }
  return routes.map((r) => {
    const points = decodePolyline(r.polyline?.encodedPolyline);
    return {
      durationSec: parseDurationSeconds(r.duration),
      staticSec: parseDurationSeconds(r.staticDuration),
      miles: metersToMiles(r.distanceMeters),
      description: r.description || "",
      labels: r.routeLabels || [],
      warnings: r.warnings || [],
      predicted: Boolean(leaveAt),
      departAt: leaveAt ?? null,
      traffic: summarizeTraffic(points, r.travelAdvisory?.speedReadingIntervals),
    };
  });
}
