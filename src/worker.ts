import { authorizeUrl, challengeFor, exchangeCode, randomToken, refresh, type Tokens } from "./oauth.ts";
import { cookie, readCookie, seal, unseal } from "./session.ts";
import { BufferAuthError, createPost, loadAccount, type Media, type ShipMode } from "./buffer.ts";
import { fetchGame, slugFrom } from "./game.ts";

export interface Env {
  BUFFER_CLIENT_ID: string;
  BUFFER_CLIENT_SECRET?: string;
  SESSION_SECRET: string;
  BUFFER_AUTH_BASE?: string;
  BUFFER_API_URL?: string;
  BETACADE_ORIGIN?: string;
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

const SESSION = "stb_session";
const OAUTH = "stb_oauth";
const SESSION_AGE = 60 * 60 * 24 * 30;

const authBase = (env: Env) => env.BUFFER_AUTH_BASE || "https://auth.buffer.com";
const apiUrl = (env: Env) => env.BUFFER_API_URL || "https://api.buffer.com";
const betacade = (env: Env) => env.BETACADE_ORIGIN || "https://play.betacade.com";
const redirectUri = (req: Request) => new URL("/auth/callback", req.url).toString();

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  for (const [k, v] of new Headers(extra)) h.append(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}

function redirect(to: string, cookies: string[] = []): Response {
  const h = new Headers({ location: to, ...SECURITY_HEADERS });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

// The session cookie is SameSite=Lax; on top of that, writes must come from our own page.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !!origin && origin === new URL(req.url).origin;
}

type Session = { tokens: Tokens; set?: string };

// Returns a usable access token, refreshing it when it is about to expire.
async function session(req: Request, env: Env): Promise<Session | null> {
  const tokens = await unseal<Tokens>(env.SESSION_SECRET, SESSION, readCookie(req, SESSION));
  if (!tokens) return null;
  if (tokens.exp > Date.now()) return { tokens };
  if (!tokens.rt) return null;
  try {
    const next = await refresh(authBase(env), {
      clientId: env.BUFFER_CLIENT_ID,
      clientSecret: env.BUFFER_CLIENT_SECRET,
      refreshToken: tokens.rt,
    });
    // Refresh tokens rotate: keep the old one only if Buffer didn't send a new one.
    if (!next.rt) next.rt = tokens.rt;
    return { tokens: next, set: cookie(SESSION, await seal(env.SESSION_SECRET, SESSION, next), SESSION_AGE) };
  } catch {
    return null;
  }
}

const signedOut = () => json({ connected: false }, 200, { "set-cookie": cookie(SESSION, "", 0) });

async function login(req: Request, env: Env): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken(48);
  const sealed = await seal(env.SESSION_SECRET, OAUTH, { state, verifier });
  const to = authorizeUrl(authBase(env), {
    clientId: env.BUFFER_CLIENT_ID,
    redirectUri: redirectUri(req),
    state,
    challenge: await challengeFor(verifier),
  });
  return redirect(to, [cookie(OAUTH, sealed, 600, "/auth")]);
}

async function callback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const clearOauth = cookie(OAUTH, "", 0, "/auth");
  const pending = await unseal<{ state: string; verifier: string }>(env.SESSION_SECRET, OAUTH, readCookie(req, OAUTH));
  const state = url.searchParams.get("state");
  if (!pending || !state || state !== pending.state) return redirect("/?error=state", [clearOauth]);
  const err = url.searchParams.get("error");
  if (err) return redirect(`/?error=${encodeURIComponent(err)}`, [clearOauth]);
  const code = url.searchParams.get("code");
  if (!code) return redirect("/?error=code", [clearOauth]);
  try {
    const tokens = await exchangeCode(authBase(env), {
      clientId: env.BUFFER_CLIENT_ID,
      clientSecret: env.BUFFER_CLIENT_SECRET,
      code,
      redirectUri: redirectUri(req),
      verifier: pending.verifier,
    });
    const sealed = await seal(env.SESSION_SECRET, SESSION, tokens);
    return redirect("/?connected=1", [clearOauth, cookie(SESSION, sealed, SESSION_AGE)]);
  } catch {
    return redirect("/?error=token", [clearOauth]);
  }
}

async function me(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env);
  if (!s) return signedOut();
  try {
    const account = await loadAccount(apiUrl(env), s.tokens.at);
    return json({ connected: true, ...account }, 200, s.set ? { "set-cookie": s.set } : {});
  } catch (e) {
    if (e instanceof BufferAuthError) return signedOut();
    return json({ error: (e as Error).message }, 502);
  }
}

async function game(req: Request, env: Env): Promise<Response> {
  const slug = slugFrom(new URL(req.url).searchParams.get("url") || "");
  if (!slug) return json({ error: "Paste a play.betacade.com/g/<game> link." }, 400);
  const g = await fetchGame(betacade(env), slug).catch(() => null);
  if (!g) return json({ error: "Couldn't read that game. Is it public?" }, 404);
  return json(g);
}

const MODES: ShipMode[] = ["queue", "next", "now", "schedule", "draft"];
const MEDIA: Media[] = ["image", "link", "none"];

type ShipBody = {
  game?: string;
  mode?: string;
  dueAt?: string;
  posts?: { channelId?: string; service?: string; text?: string; media?: string }[];
};

async function ship(req: Request, env: Env): Promise<Response> {
  if (!sameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
  const s = await session(req, env);
  if (!s) return json({ error: "Connect Buffer first." }, 401, { "set-cookie": cookie(SESSION, "", 0) });
  let body: ShipBody;
  try {
    body = (await req.json()) as ShipBody;
  } catch {
    return json({ error: "Bad JSON." }, 400);
  }
  const mode = body.mode as ShipMode;
  if (!MODES.includes(mode)) return json({ error: "Unknown mode." }, 400);
  if (mode === "schedule") {
    const t = Date.parse(body.dueAt || "");
    if (!Number.isFinite(t) || t < Date.now() + 60_000) return json({ error: "Pick a time at least a minute from now." }, 400);
  }
  const posts = Array.isArray(body.posts) ? body.posts.slice(0, 20) : [];
  if (!posts.length) return json({ error: "Pick at least one channel." }, 400);

  // The cover and link come from Betacade again, not from the page, so a post only ever carries the real game.
  const slug = slugFrom(body.game || "");
  const g = slug ? await fetchGame(betacade(env), slug).catch(() => null) : null;
  if (!g) return json({ error: "Couldn't read that game." }, 400);

  const results = [];
  for (const p of posts) {
    const text = String(p.text || "").trim();
    if (!p.channelId || !text) {
      results.push({ channelId: p.channelId, ok: false, error: "Empty post." });
      continue;
    }
    try {
      const r = await createPost(apiUrl(env), s.tokens.at, {
        channelId: String(p.channelId),
        service: String(p.service || ""),
        text,
        mode,
        dueAt: body.dueAt,
        media: MEDIA.includes(p.media as Media) ? (p.media as Media) : "image",
        game: g,
      });
      results.push(r.ok ? { channelId: p.channelId, ok: true, post: r.post } : { channelId: p.channelId, ok: false, error: r.error });
    } catch (e) {
      if (e instanceof BufferAuthError) return json({ error: "Buffer signed you out. Connect again." }, 401, { "set-cookie": cookie(SESSION, "", 0) });
      results.push({ channelId: p.channelId, ok: false, error: (e as Error).message });
    }
  }
  return json({ results }, 200, s.set ? { "set-cookie": s.set } : {});
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    const m = req.method;
    if (pathname === "/auth/login" && m === "GET") return login(req, env);
    if (pathname === "/auth/callback" && m === "GET") return callback(req, env);
    if (pathname === "/auth/logout" && m === "POST") {
      if (!sameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
      return json({ ok: true }, 200, { "set-cookie": cookie(SESSION, "", 0) });
    }
    if (pathname === "/api/me" && m === "GET") return me(req, env);
    if (pathname === "/api/game" && m === "GET") return game(req, env);
    if (pathname === "/api/ship" && m === "POST") return ship(req, env);
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) return json({ error: "Not found." }, 404);
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Not found", { status: 404 });
  },
};
