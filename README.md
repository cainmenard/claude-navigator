# claude-navigator

A remote MCP connector that gives Claude live-traffic drive times and side-by-side route comparisons from the Google Routes API. Add it to claude.ai as a custom connector and it shows up in the mobile app and CarPlay voice mode.

It does not navigate. Keep Google Maps or Waze running for turn-by-turn; ask Claude when you want a second opinion or a route comparison.

## Tools

| Tool | What it answers |
| --- | --- |
| `get_drive_time(origin, destination, departure_time?, avoid?)` | Live drive time, main road, minutes traffic is adding, miles of stopped or slow traffic and how far ahead, up to two alternates. |
| `compare_routes(origin, destination, options[], departure_time?)` | Ranks 2 to 4 named routes, each forced through its own pass-through points (for example I-12 via Henderson, LA vs US-90 via Morgan City, LA). |
| `open_in_maps(destination, via?, label?)` | Links that start turn-by-turn in Google Maps or Waze from the phone's current location. No Google API call, no cost. |
| `ping` | Confirms the connector is reachable and the Google key is set. |

`get_drive_time` and `compare_routes` also return hand-off links, fastest route first. Google Maps links carry up to 3 via points (phone limit) and treat them as stops. Waze links can't carry via points, so a forced route sends Waze to the first via point.

Locations can be full addresses, place names, or `lat,lng` coordinates.

## Setup

1. **Google Cloud:** create a project with billing, enable **Routes API** only, create an API key restricted to Routes API, and set a daily quota (for example 300 requests/day) plus a budget alert.
2. **Vercel env vars** (sensitive, production): `MCP_PATH_SECRET` (`openssl rand -hex 24`) and `GOOGLE_MAPS_API_KEY`. Redeploy after changing either.
3. **Claude:** claude.ai > Settings > Connectors > Add custom connector. URL: `https://<project>.vercel.app/mcp/<MCP_PATH_SECRET>`, **No sign-in**. If it later shows "needs reconnect", remove it and re-add with No sign-in; Reconnect starts a sign-in flow that goes nowhere.

## Security and cost

- The secret in the URL is the only lock. Anyone with the URL can spend your Google quota. If it leaks, change `MCP_PATH_SECRET`, redeploy, and re-add the connector.
- Wrong secret returns 404; anything but POST returns 405.
- Traffic-on-polyline (the "stopped traffic ahead" detail) triggers Google's Compute Routes Enterprise SKU: 1,000 free calls a month, then $15 per 1,000 (https://developers.google.com/maps/billing-and-pricing/sku-details/routes). Keep the daily quota low (about 30) and a budget alert set.
- Hand-off links are plain public URLs with no API calls or billing.
- Each request logs one diagnostic line to Vercel (HTTP method, whether the secret matched, MCP method name, client headers). It never logs the secret, addresses, or tool arguments.

## Develop

```sh
npm install
npm test   # Google is mocked; no key needed
```

## Ideas for later

- Pull 511LA / FL511 incident feeds and add "any closures on my route?"
- A preset for the Slidell decision so one spoken phrase runs the comparison.
