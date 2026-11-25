// Arrival-clock answers ("arrive about 4:40 PM Central").
// Time zone comes from the state in the destination text. No extra API calls.

const CENTRAL = ["LA", "MS", "AL", "TX", "AR", "OK", "TN", "MO", "IL", "WI", "MN", "IA", "KS", "NE"];
const EASTERN = ["GA", "FL", "SC", "NC", "VA", "OH", "MI", "PA", "NY", "NJ", "MD", "DC", "DE", "CT", "RI", "MA", "VT", "NH", "ME", "WV", "KY", "IN"];
const NAMES = {
  louisiana: "LA", mississippi: "MS", alabama: "AL", texas: "TX", arkansas: "AR", tennessee: "TN",
  georgia: "GA", florida: "FL", "south carolina": "SC", "north carolina": "NC", virginia: "VA",
};
const ZONES = { "America/Chicago": "Central", "America/New_York": "Eastern" };

export function timeZoneFor(destination) {
  const text = String(destination);
  let state = null;
  const abbr = /,\s*([A-Z]{2})\b(?:\s+\d{5})?\s*$/.exec(text) || /\b([A-Z]{2})\s+\d{5}\b/.exec(text);
  if (abbr) state = abbr[1];
  if (!state) {
    const lower = text.toLowerCase();
    for (const [name, code] of Object.entries(NAMES)) if (lower.includes(name)) state = code;
  }
  // Florida west of the Apalachicola River is Central; Pensacola is the common case on I-10.
  if (state === "FL" && /pensacola|navarre|destin|fort walton|crestview|panama city/i.test(text)) return "America/Chicago";
  if (CENTRAL.includes(state)) return "America/Chicago";
  if (EASTERN.includes(state)) return "America/New_York";
  return null;
}

export function arrivalSentence(durationSec, destination, departIso, now = Date.now()) {
  const zone = timeZoneFor(destination);
  if (!zone) return "";
  const start = departIso ? Date.parse(departIso) : now;
  const arrive = new Date(start + durationSec * 1000);
  const clock = arrive.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  const sameDay =
    new Date(start).toLocaleDateString("en-US", { timeZone: zone }) === arrive.toLocaleDateString("en-US", { timeZone: zone });
  const day = sameDay ? "" : ` on ${arrive.toLocaleDateString("en-US", { timeZone: zone, weekday: "long" })}`;
  return `You'd arrive about ${clock} ${ZONES[zone]}${day}.`;
}
