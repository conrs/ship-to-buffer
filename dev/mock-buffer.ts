// A stand-in for auth.buffer.com, api.buffer.com and play.betacade.com, used by the tests and by
// `npm run dev` when no Buffer client is configured. It enforces the parts of the real flow that
// matter here: PKCE, state round trip, client secret, single-use rotating refresh tokens, bearer auth,
// and createPost's typed errors.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export const CLIENT_ID = "mock-client-id";
export const CLIENT_SECRET = "mock-client-secret";

const b64url = (b: Buffer) => b.toString("base64url");
const token = () => b64url(randomBytes(18));

type Code = { clientId: string; redirectUri: string; challenge: string };

export type MockState = {
  codes: Map<string, Code>;
  access: Set<string>;
  refresh: Set<string>;
  usedRefresh: Set<string>;
  posts: { input: Record<string, any>; id: string }[];
  calls: string[];
  expiresIn: number;
};

const ORG = { id: "org_1", name: "Matt's Studio" };
const CHANNELS = [
  { id: "ch_x", name: "betacade", displayName: "Betacade", service: "twitter" },
  { id: "ch_bsky", name: "betacade.com", displayName: "Betacade", service: "bluesky" },
  { id: "ch_li", name: "matt", displayName: "Matt", service: "linkedin" },
  { id: "ch_threads", name: "betacade", displayName: "Betacade", service: "threads" },
  { id: "ch_yt", name: "betacade", displayName: "Betacade", service: "youtube" },
].map((c) => ({ ...c, avatar: "", isDisconnected: false, isLocked: false, isQueuePaused: false, timezone: "America/Los_Angeles" }));

const LIMITS: Record<string, number> = { twitter: 280, bluesky: 300, threads: 500, linkedin: 3000 };

export const GAME_HTML = (slug: string, base: string) => `<!doctype html><html><head>
<title>Product Theater · Betacade</title>
<meta property="og:title" content="Product Theater" />
<meta property="og:description" content="One bookmarklet turns every website into a product run by a desperate PM: what&#39;s-new tours, Sudoku gates, paywalls. Try it free, no install." />
<meta property="og:image" content="${base}/g/${slug}/cover.jpg" />
<meta name="theme-color" content="#e3262f" />
</head><body></body></html>`;

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(data));
}

function issue(s: MockState) {
  const at = token();
  const rt = token();
  s.access.add(at);
  s.refresh.add(rt);
  return { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: s.expiresIn, scope: "account:read posts:read posts:write offline_access" };
}

function graphql(s: MockState, query: string, variables: Record<string, any>) {
  if (/query Me\b/.test(query)) return { data: { account: { id: "acct_1", name: "Matt", organizations: [ORG] } } };
  if (/query Channels\b/.test(query)) {
    if (variables.input?.organizationId !== ORG.id) return { errors: [{ message: "Organization not found", extensions: { code: "NOT_FOUND" } }] };
    return { data: { channels: CHANNELS } };
  }
  if (/mutation CreatePost\b/.test(query)) {
    const input = variables.input || {};
    const ch = CHANNELS.find((c) => c.id === input.channelId);
    const err = (message: string) => ({ data: { createPost: { __typename: "InvalidInputError", message } } });
    if (!ch) return err("Channel not found");
    if (input.schedulingType !== "automatic") return err("schedulingType is required");
    if (!["addToQueue", "shareNext", "shareNow", "customScheduled"].includes(input.mode)) return err("Invalid mode");
    if (input.mode === "customScheduled" && !input.dueAt) return err("dueAt is required for customScheduled");
    const meta = input.metadata?.[ch.service];
    if (meta?.linkAttachment && input.assets?.length) return err("linkAttachment and assets are mutually exclusive");
    const limit = LIMITS[ch.service];
    if (limit && String(input.text || "").length > limit) return err(`${ch.service} posts cannot exceed ${limit} characters.`);
    const id = "post_" + (s.posts.length + 1);
    s.posts.push({ input, id });
    const dueAt = input.mode === "customScheduled" ? input.dueAt : new Date(Date.now() + 3600_000).toISOString();
    return { data: { createPost: { __typename: "PostActionSuccess", post: { id, dueAt, status: input.saveToDraft ? "draft" : "scheduled" } } } };
  }
  return { errors: [{ message: "Unknown operation" }] };
}

export function startMock(port = 0, opts: { expiresIn?: number } = {}) {
  const s: MockState = {
    codes: new Map(),
    access: new Set(),
    refresh: new Set(),
    usedRefresh: new Set(),
    posts: [],
    calls: [],
    expiresIn: opts.expiresIn ?? 3600,
  };
  let base = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", base);
    s.calls.push(`${req.method} ${url.pathname}`);

    // auth.buffer.com/auth: auto-approve, like a user clicking Connect.
    if (req.method === "GET" && url.pathname === "/auth") {
      const p = url.searchParams;
      const redirect = p.get("redirect_uri") || "";
      if (p.get("client_id") !== CLIENT_ID) return send(res, 400, { error: "invalid_client" });
      if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge"))
        return send(res, 400, { error: "invalid_request" });
      const to = new URL(redirect);
      to.searchParams.set("state", p.get("state") || "");
      if (p.get("deny")) to.searchParams.set("error", "access_denied");
      else {
        const code = token();
        s.codes.set(code, { clientId: CLIENT_ID, redirectUri: redirect, challenge: p.get("code_challenge")! });
        to.searchParams.set("code", code);
      }
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const f = new URLSearchParams(await body(req));
      if (f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        const code = s.codes.get(f.get("code") || "");
        s.codes.delete(f.get("code") || "");
        if (!code || code.redirectUri !== f.get("redirect_uri")) return send(res, 400, { error: "invalid_grant" });
        const hash = b64url(createHash("sha256").update(f.get("code_verifier") || "").digest());
        if (hash !== code.challenge) return send(res, 400, { error: "invalid_grant", error_description: "PKCE verifier mismatch" });
        return send(res, 200, issue(s));
      }
      if (f.get("grant_type") === "refresh_token") {
        const rt = f.get("refresh_token") || "";
        if (s.usedRefresh.has(rt)) {
          // Reuse revokes the grant, as Buffer does.
          s.access.clear();
          s.refresh.clear();
          return send(res, 400, { error: "invalid_grant", error_description: "refresh token reused" });
        }
        if (!s.refresh.has(rt)) return send(res, 400, { error: "invalid_grant" });
        s.refresh.delete(rt);
        s.usedRefresh.add(rt);
        return send(res, 200, issue(s));
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }

    if (req.method === "POST" && url.pathname === "/") {
      const auth = req.headers.authorization || "";
      const at = auth.replace(/^Bearer /, "");
      if (!s.access.has(at)) return send(res, 401, { errors: [{ message: "Unauthorized" }] });
      const { query, variables } = JSON.parse(await body(req));
      return send(res, 200, graphql(s, query, variables || {}), { RateLimit: "r=99, t=900" });
    }

    // play.betacade.com stand-in
    if (req.method === "GET" && url.pathname === "/g/old-name") {
      res.writeHead(301, { location: "/g/product-theater" });
      return res.end();
    }
    const g = url.pathname.match(/^\/g\/([a-z0-9-]+)$/);
    if (req.method === "GET" && g && g[1] !== "missing") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(GAME_HTML(g[1], base));
    }
    send(res, 404, { error: "not found" });
  });
  return new Promise<{ url: string; state: MockState; close: () => Promise<void> }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
      resolve({ url: base, state: s, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
