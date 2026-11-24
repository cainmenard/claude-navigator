// Hand-off links that open Google Maps or Waze on the phone for turn-by-turn navigation.
// No API calls and no Google Maps Platform billing: these are plain public URLs.
//
// Google Maps URLs: https://developers.google.com/maps/documentation/urls/get-started
//   - origin left out so the app starts from the phone's location
//   - dir_action=navigate starts turn-by-turn when the origin is the current location
//   - waypoints: up to 3 on mobile, pipe-separated
// Waze deep links: https://developers.google.com/waze/deeplinks
//   - no waypoint support, so a via route is handed off as "drive to the via point first"

const MAX_MOBILE_WAYPOINTS = 3;
const LAT_LNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function googleMapsLink(destination, via = []) {
  const params = new URLSearchParams({ api: "1", destination: String(destination).trim(), travelmode: "driving" });
  const stops = via.slice(0, MAX_MOBILE_WAYPOINTS).map((v) => String(v).trim());
  if (stops.length > 0) params.set("waypoints", stops.join("|"));
  params.set("dir_action", "navigate");
  // URLSearchParams encodes spaces as "+", commas as %2C and pipes as %7C, which Google accepts.
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function wazeLink(target) {
  const match = LAT_LNG.exec(String(target));
  const params = match
    ? new URLSearchParams({ ll: `${Number(match[1])},${Number(match[2])}`, navigate: "yes" })
    : new URLSearchParams({ q: String(target).trim(), navigate: "yes" });
  params.set("utm_source", "claude-navigator");
  return `https://waze.com/ul?${params.toString()}`;
}

function placeName(text) {
  return LAT_LNG.test(String(text)) ? "that spot" : String(text).trim();
}

// Markdown lines Claude can pass straight through as tappable links.
export function handoffLines({ label, destination, via = [] }) {
  const name = label || placeName(destination);
  const lines = [`[${name} in Google Maps](${googleMapsLink(destination, via)})`];
  if (via.length === 0) {
    lines.push(`[${name} in Waze](${wazeLink(destination)})`);
  } else {
    // Waze can't take via points; send it to the first one so it commits to that road.
    lines.push(`[${name} in Waze, to ${placeName(via[0])} first](${wazeLink(via[0])})`);
  }
  return lines;
}

export function handoffBlock(entries) {
  const lines = entries.flatMap((e) => handoffLines(e));
  const notes = [];
  if (entries.some((e) => e.via?.length)) {
    notes.push("Google Maps treats a via town as a stop; keep driving when it says you've arrived.");
  }
  if (entries.some((e) => (e.via?.length ?? 0) > MAX_MOBILE_WAYPOINTS)) {
    notes.push(`Phones take only ${MAX_MOBILE_WAYPOINTS} via points, so extra ones were dropped from the link.`);
  }
  return ["Hand-off links (start from your current location):", ...lines.map((l) => `- ${l}`), ...notes].join("\n");
}
