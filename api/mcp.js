// Vercel Function entry. Reached as https://<project>.vercel.app/mcp/<MCP_PATH_SECRET>
// (vercel.json rewrites that path to /api/mcp?s=<secret>).
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/server.js";
import { secretFromRequest, secretMatches } from "../lib/auth.js";

function logRequest(req, secretOk) {
  // Diagnostics only: never log the secret, addresses, or tool arguments.
  const rpc = req.body && typeof req.body === "object" ? req.body.method : undefined;
  console.log(
    JSON.stringify({
      navigator: true,
      method: req.method,
      secretOk,
      rpc,
      accept: req.headers?.accept,
      mcpVersion: req.headers?.["mcp-protocol-version"],
      hasAuthHeader: Boolean(req.headers?.authorization),
      ua: req.headers?.["user-agent"],
    }),
  );
}

export default async function handler(req, res) {
  const expected = process.env.MCP_PATH_SECRET;
  const secretOk = secretMatches(secretFromRequest(req), expected);
  logRequest(req, secretOk);
  if (!secretOk) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method not allowed");
    return;
  }

  let body = req.body;
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString());
    } catch {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }
  }

  const server = buildServer({
    apiKey: process.env.GOOGLE_MAPS_API_KEY,
    endpoint: process.env.ROUTES_ENDPOINT || undefined, // test override only
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
