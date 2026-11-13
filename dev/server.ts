// Local runner without wrangler: serves public/ and hands everything else to the Worker.
// With no BUFFER_CLIENT_ID set it starts the mock Buffer and points the Worker at it.
//   npm run dev            -> http://localhost:8787 against the mock
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import worker, { type Env } from "../src/worker.ts";
import { CLIENT_ID, CLIENT_SECRET, startMock } from "./mock-buffer.ts";

const PORT = Number(process.env.PORT || 8787);
const PUBLIC = new URL("../public/", import.meta.url).pathname;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

const env: Env = {
  BUFFER_CLIENT_ID: process.env.BUFFER_CLIENT_ID || "",
  BUFFER_CLIENT_SECRET: process.env.BUFFER_CLIENT_SECRET,
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-only-session-secret-change-me-0123456789",
  BETACADE_ORIGIN: process.env.BETACADE_ORIGIN,
};

if (!env.BUFFER_CLIENT_ID) {
  const mock = await startMock(0, { expiresIn: Number(process.env.MOCK_EXPIRES_IN || 3600) });
  env.BUFFER_CLIENT_ID = CLIENT_ID;
  env.BUFFER_CLIENT_SECRET = CLIENT_SECRET;
  env.BUFFER_AUTH_BASE = mock.url;
  env.BUFFER_API_URL = mock.url + "/";
  console.log(`mock Buffer at ${mock.url} (no BUFFER_CLIENT_ID set)`);
}

env.ASSETS = {
  async fetch(req: Request) {
    let path = new URL(req.url).pathname;
    if (path === "/") path = "/index.html";
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC)) return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

createServer(async (req, res) => {
  const url = `http://${req.headers.host || "localhost:" + PORT}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error node needs duplex for streamed bodies
    duplex: "half",
  });
  try {
    const out = await worker.fetch(request, env);
    const h: Record<string, string | string[]> = {};
    out.headers.forEach((v, k) => {
      if (k !== "set-cookie") h[k] = v;
    });
    const cookies = out.headers.getSetCookie();
    if (cookies.length) h["set-cookie"] = cookies;
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end("error");
  }
}).listen(PORT, () => console.log(`Ship to Buffer on http://localhost:${PORT}`));
