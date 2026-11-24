// Formatting helpers. Every string these produce is meant to be read aloud.

const METERS_PER_MILE = 1609.344;

export function parseDurationSeconds(value) {
  // Routes API durations look like "9850s" or "9850.5s".
  if (typeof value !== "string") return 0;
  const n = Number.parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(n) ? n : 0;
}

export function metersToMiles(meters) {
  return (meters || 0) / METERS_PER_MILE;
}

export function formatMiles(miles) {
  if (miles < 1) return "less than a mile";
  const rounded = Math.round(miles);
  return `${rounded} ${rounded === 1 ? "mile" : "miles"}`;
}

export function formatDuration(seconds) {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const h = hours === 1 ? "1 hour" : `${hours} hours`;
  const m = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  if (hours === 0) return m;
  if (minutes === 0) return h;
  return `${h} ${m}`;
}

// Standard Google encoded polyline decoder (precision 5).
export function decodePolyline(encoded) {
  const points = [];
  if (typeof encoded !== "string" || encoded.length === 0) return points;
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function haversineMiles([lat1, lng1], [lat2, lng2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Turns speedReadingIntervals into "how much slow or stopped traffic, and how far ahead".
export function summarizeTraffic(points, intervals) {
  const empty = { jamMiles: 0, slowMiles: 0, firstJamMile: null, firstSlowMile: null, jams: [] };
  if (!Array.isArray(points) || points.length < 2 || !Array.isArray(intervals)) return empty;

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineMiles(points[i - 1], points[i]));
  }
  const at = (i) => cumulative[Math.min(Math.max(i, 0), cumulative.length - 1)];

  const out = { ...empty, jams: [] };
  let current = null; // merges back-to-back jam intervals into one stretch
  for (const interval of intervals) {
    const start = interval.startPolylinePointIndex ?? 0; // proto3 omits 0
    const end = interval.endPolylinePointIndex ?? start;
    const startMile = at(start);
    const miles = Math.max(0, at(end) - startMile);
    if (interval.speed === "TRAFFIC_JAM") {
      out.jamMiles += miles;
      if (out.firstJamMile === null) out.firstJamMile = startMile;
      if (current && Math.abs(current.endMile - startMile) < 0.5) {
        current.endMile = startMile + miles;
      } else {
        current = { startMile, endMile: startMile + miles };
        out.jams.push(current);
      }
    } else {
      current = null;
      if (interval.speed === "SLOW") {
        out.slowMiles += miles;
        if (out.firstSlowMile === null) out.firstSlowMile = startMile;
      }
    }
  }
  return out;
}

export function trafficSentence(traffic) {
  if (!traffic) return "";
  const parts = [];
  if (traffic.jamMiles >= 0.5) {
    const ahead = traffic.firstJamMile < 1 ? "starting right where you are" : `starting about ${formatMiles(traffic.firstJamMile)} ahead`;
    const stretches = traffic.jams.length > 1 ? ` in ${traffic.jams.length} stretches` : "";
    parts.push(`${formatMiles(traffic.jamMiles)} of stopped or crawling traffic${stretches}, ${ahead}`);
  }
  if (traffic.slowMiles >= 1) {
    parts.push(`${formatMiles(traffic.slowMiles)} of slow traffic`);
  }
  if (parts.length === 0) return "No major slowdowns showing.";
  return `${capitalize(parts.join(", plus "))}.`;
}

export function delaySentence(route) {
  const delay = route.durationSec - route.staticSec;
  if (!route.staticSec || delay < 120) return "Traffic is adding little or no time.";
  return `Traffic is adding about ${formatDuration(delay)}.`;
}

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
