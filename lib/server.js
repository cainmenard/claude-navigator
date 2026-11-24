// MCP server definition: tools Claude can call while you drive.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeRoutes, MapsError } from "./google.js";
import { delaySentence, formatDuration, formatMiles, trafficSentence } from "./format.js";

const LOCATION_HELP =
  "A full street address with city and state, a well-known place (\"Lafayette, LA\"), or \"lat,lng\" coordinates such as the phone's current location. Never guess an address for \"home\" or \"here\": use the device location tool if you have one, otherwise ask.";

const DEPARTURE_HELP =
  "Optional ISO 8601 time with a UTC offset, for example 2026-11-25T06:30:00-05:00. Leave it out to mean leaving now.";

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function errorText(err) {
  const message = err instanceof MapsError ? err.message : "Something went wrong on the navigator. Try again in a minute.";
  return { content: [{ type: "text", text: message }], isError: true };
}

function routeName(route) {
  return route.description ? `via ${route.description}` : "the main route";
}

export function describeDriveTime(routes) {
  const [best, ...rest] = routes;
  const timeWord = best.predicted ? "Predicted" : "Right now";
  const lines = [
    `${timeWord}: ${formatDuration(best.durationSec)} ${routeName(best)}, ${formatMiles(best.miles)}.`,
    delaySentence(best),
    trafficSentence(best.traffic),
  ];
  const warning = best.warnings.find((w) => /toll|clos|restrict/i.test(w));
  if (warning) lines.push(`Note: ${warning}`);
  for (const alt of rest.slice(0, 2)) {
    const diff = alt.durationSec - best.durationSec;
    const compare = diff < 60 ? "about the same time" : `${formatDuration(diff)} slower`;
    lines.push(`Alternate ${routeName(alt)}: ${formatDuration(alt.durationSec)}, ${compare}.`);
  }
  return lines.filter(Boolean).join(" ");
}

export function describeComparison(results) {
  const ok = results.filter((r) => r.route).sort((a, b) => a.route.durationSec - b.route.durationSec);
  const failed = results.filter((r) => !r.route);
  if (ok.length === 0) {
    return failed.map((f) => `${f.label}: ${f.error}`).join(" ");
  }
  const best = ok[0];
  const timeWord = best.route.predicted ? "predicted" : "right now";
  const lines = [
    `Fastest ${timeWord}: ${best.label}, ${formatDuration(best.route.durationSec)}, ${formatMiles(best.route.miles)}. ${delaySentence(best.route)} ${trafficSentence(best.route.traffic)}`,
  ];
  for (const other of ok.slice(1)) {
    const diff = other.route.durationSec - best.route.durationSec;
    const compare = diff < 60 ? "about the same" : `${formatDuration(diff)} slower`;
    lines.push(
      `${other.label}: ${formatDuration(other.route.durationSec)}, ${compare}. ${trafficSentence(other.route.traffic)}`,
    );
  }
  const descriptions = new Set(ok.map((r) => r.route.description).filter(Boolean));
  if (ok.length > 1 && descriptions.size === 1) {
    lines.push("Heads up: Google may be routing these the same way, so check the via points.");
  }
  for (const f of failed) lines.push(`${f.label}: ${f.error}`);
  return lines.join(" ");
}

export function buildServer({ apiKey, endpoint, fetchImpl } = {}) {
  const server = new McpServer({ name: "claude-navigator", version: "0.1.0" });
  const google = (args) => computeRoutes({ apiKey, endpoint, fetchImpl, ...args });

  server.registerTool(
    "ping",
    {
      title: "Check the navigator",
      description: "Confirms the navigator connector is reachable and whether its Google Maps key is set.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(apiKey ? "Navigator is connected and the Google Maps key is set." : "Navigator is connected, but the Google Maps key isn't set yet."),
  );

  server.registerTool(
    "get_drive_time",
    {
      title: "Drive time with live traffic",
      description:
        "Live-traffic drive time between two places, the main road taken, how much time traffic is adding, how many miles of stopped or slow traffic are on the route and how far ahead they start, plus up to two alternate routes. The reply is short and written to be read aloud while driving; read it as is.",
      inputSchema: {
        origin: z.string().min(2).describe(LOCATION_HELP),
        destination: z.string().min(2).describe(LOCATION_HELP),
        departure_time: z.string().optional().describe(DEPARTURE_HELP),
        avoid: z.array(z.enum(["tolls", "highways", "ferries"])).optional().describe("Optional things to avoid."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ origin, destination, departure_time, avoid }) => {
      try {
        const routes = await google({ origin, destination, departureTime: departure_time, avoid: avoid ?? [], alternatives: true });
        return text(describeDriveTime(routes));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "compare_routes",
    {
      title: "Compare named routes with live traffic",
      description:
        "Compares two to four named route choices between the same start and end, each forced through its own pass-through points, and ranks them by live-traffic time, with stopped-traffic miles for each. Use this when the driver is choosing between specific roads. Example for Slidell to Lafayette, LA: option \"I-12 and the Atchafalaya Basin bridge\" via [\"Henderson, LA\"] versus option \"I-10 through New Orleans and US-90\" via [\"Morgan City, LA\"]. Pick via points that sit on the road in question, away from the start and end. The reply is written to be read aloud; read it as is.",
      inputSchema: {
        origin: z.string().min(2).describe(LOCATION_HELP),
        destination: z.string().min(2).describe(LOCATION_HELP),
        options: z
          .array(
            z.object({
              label: z.string().min(1).describe("Short spoken name, for example \"US-90 through Houma\"."),
              via: z.array(z.string().min(2)).max(5).describe("Pass-through points that force this route. Empty means Google's own choice."),
            }),
          )
          .min(2)
          .max(4),
        departure_time: z.string().optional().describe(DEPARTURE_HELP),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ origin, destination, options, departure_time }) => {
      if (!apiKey) return errorText(new MapsError("The Google Maps key isn't set up on the navigator yet, so I can't check traffic."));
      const results = await Promise.all(
        options.map(async (option) => {
          try {
            const [route] = await google({ origin, destination, via: option.via, departureTime: departure_time });
            return { label: option.label, route };
          } catch (err) {
            return { label: option.label, error: err instanceof MapsError ? err.message : "That route check failed." };
          }
        }),
      );
      return text(describeComparison(results));
    },
  );

  return server;
}
