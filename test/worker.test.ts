import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../src/worker.ts";
import { CLIENT_ID, CLIENT_SECRET, startMock } from "../dev/mock-buffer.ts";
import { buildPostInput } from "../src/buffer.ts";
import { slugFrom, parseGamePage } from "../src/game.ts";

const APP = "https://ship.example";
let mock: Awaited<ReturnType<typeof startMock>>;
let env: Env;

before(async () => {
  mock = await startMock(0);
  env = {
    BUFFER_CLIENT_ID: CLIENT_ID,
    BUFFER_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET: "test-session-secret-0123456789abcdef0123",
    BUFFER_AUTH_BASE: mock.url,
    BUFFER_API_URL: mock.url + "/",
    BETACADE_ORIGIN: mock.url,
  };
});
after(() => mock.close());

// Minimal browser: a cookie jar plus manual redirects.
class Browser {
  jar = new Map<string, string>();
  async get(path: string, init: RequestInit = {}) {
    return this.send(new Request(path.startsWith("http") ? path : APP + path, init));
  }
  async post(path: string, body: unknown, origin: string | null = APP) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    return this.send(new Request(APP + path, { method: "POST", headers, body: JSON.stringify(body) }));
  }
  async send(req: Request) {
    const cookies = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookies) req.headers.set("cookie", cookies);
    const res = await worker.fetch(req, env);
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split("; ");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (attrs.includes("Max-Age=0") || !value) this.jar.delete(name);
      else this.jar.set(name, value);
      assert.ok(attrs.includes("HttpOnly") && attrs.includes("Secure") && attrs.includes("SameSite=Lax"), "cookie flags");
    }
    return res;
  }
  // /auth/login -> mock Buffer -> /auth/callback
  async connect(extra = "") {
    const start = await this.get("/auth/login");
    assert.equal(start.status, 302);
    const authorize = start.headers.get("location")! + extra;
    const fromBuffer = await fetch(authorize, { redirect: "manual" });
    assert.equal(fromBuffer.status, 302);
    return this.get(fromBuffer.headers.get("location")!);
  }
}

test("signed out: /api/me says not connected", async () => {
  const b = new Browser();
  const r = await b.get("/api/me");
  assert.deepEqual(await r.json(), { connected: false });
});

test("login sends PKCE S256, state and the narrow scopes", async () => {
  const b = new Browser();
  const r = await b.get("/auth/login");
  const u = new URL(r.headers.get("location")!);
  assert.equal(u.pathname, "/auth");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), APP + "/auth/callback");
  assert.equal(u.searchParams.get("scope"), "account:read posts:read posts:write offline_access");
  assert.ok((u.searchParams.get("state") || "").length >= 32);
  // the verifier lives only in the sealed cookie, never in the URL
  assert.ok(!r.headers.get("location")!.includes("code_verifier"));
});

test("full OAuth round trip, then channels load", async () => {
  const b = new Browser();
  const cb = await b.connect();
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/?connected=1");
  assert.ok(b.jar.has("stb_session"));
  assert.ok(!b.jar.has("stb_oauth"), "state cookie cleared");
  // the cookie is sealed: no token text in it
  for (const t of mock.state.access) assert.ok(!b.jar.get("stb_session")!.includes(t));
  const me = await (await b.get("/api/me")).json();
  assert.equal(me.connected, true);
  assert.equal(me.organizations[0].channels.length, 5);
  assert.equal(me.organizations[0].channels[0].service, "twitter");
});

test("callback with a forged state is refused and no tokens are fetched", async () => {
  const b = new Browser();
  await b.get("/auth/login");
  const before = mock.state.calls.filter((c) => c === "POST /token").length;
  const r = await b.get("/auth/callback?code=stolen&state=forged");
  assert.equal(r.headers.get("location"), "/?error=state");
  assert.equal(mock.state.calls.filter((c) => c === "POST /token").length, before);
  assert.ok(!b.jar.has("stb_session"));
  // control: a fresh browser with no state cookie is refused too
  const c = new Browser();
  const r2 = await c.get("/auth/callback?code=x&state=y");
  assert.equal(r2.headers.get("location"), "/?error=state");
});

test("user cancels on Buffer", async () => {
  const b = new Browser();
  const r = await b.connect("&deny=1");
  assert.equal(r.headers.get("location"), "/?error=access_denied");
  assert.ok(!b.jar.has("stb_session"));
});

test("a tampered session cookie reads as signed out", async () => {
  const b = new Browser();
  await b.connect();
  const v = b.jar.get("stb_session")!;
  b.jar.set("stb_session", v.slice(0, -4) + (v.endsWith("AAAA") ? "BBBB" : "AAAA"));
  assert.deepEqual(await (await b.get("/api/me")).json(), { connected: false });
});

test("game: reads title, description, cover and color; follows a rename", async () => {
  const b = new Browser();
  const g = await (await b.get("/api/game?url=" + encodeURIComponent("https://play.betacade.com/g/product-theater"))).json();
  assert.equal(g.title, "Product Theater");
  assert.equal(g.url, "https://play.betacade.com/g/product-theater");
  assert.match(g.description, /what's-new tours/);
  assert.equal(g.color, "#e3262f");
  assert.match(g.image, /cover\.jpg$/);
  const renamed = await (await b.get("/api/game?url=old-name")).json();
  assert.equal(renamed.slug, "product-theater");
  assert.equal((await b.get("/api/game?url=missing")).status, 404);
});

test("game: only Betacade links are accepted", () => {
  assert.equal(slugFrom("https://play.betacade.com/g/business"), "business");
  assert.equal(slugFrom("play.betacade.com/g/business?x=1"), "business");
  assert.equal(slugFrom("https://business.games.betacade.com/"), "business");
  assert.equal(slugFrom("business"), "business");
  assert.equal(slugFrom("https://evil.example/g/business"), null);
  assert.equal(slugFrom("https://play.betacade.com.evil.example/g/x"), null);
  assert.equal(slugFrom("http://169.254.169.254/latest"), null);
  assert.equal(slugFrom("../etc/passwd"), null);
});

test("game page parser ignores non-https covers and bad colors", () => {
  const g = parseGamePage(
    `<meta property="og:title" content="A &amp; B"><meta content="http://x/y.jpg" property="og:image"><meta name="theme-color" content="red;}">`,
    "ab",
    "https://play.betacade.com",
  )!;
  assert.equal(g.title, "A & B");
  assert.equal(g.image, null);
  assert.equal(g.color, null);
});

test("ship queues one post per channel with the cover attached", async () => {
  const b = new Browser();
  await b.connect();
  const n = mock.state.posts.length;
  const r = await b.post("/api/ship", {
    game: "product-theater",
    mode: "queue",
    posts: [
      { channelId: "ch_x", service: "twitter", text: "Play Product Theater https://play.betacade.com/g/product-theater", media: "image" },
      { channelId: "ch_li", service: "linkedin", text: "LinkedIn launch post", media: "link" },
    ],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.results.map((x: any) => x.ok), [true, true]);
  const [x, li] = mock.state.posts.slice(n);
  assert.equal(x.input.mode, "addToQueue");
  assert.equal(x.input.schedulingType, "automatic");
  assert.match(x.input.assets[0].image.url, /\/g\/product-theater\/cover\.jpg$/);
  assert.equal(li.input.assets, undefined);
  assert.equal(li.input.metadata.linkedin.linkAttachment.url, "https://play.betacade.com/g/product-theater");
});

test("ship: schedule, drafts and Buffer's typed errors come back per channel", async () => {
  const b = new Browser();
  await b.connect();
  const due = new Date(Date.now() + 86400_000).toISOString();
  const r = await (
    await b.post("/api/ship", {
      game: "product-theater",
      mode: "schedule",
      dueAt: due,
      posts: [
        { channelId: "ch_bsky", service: "bluesky", text: "hello", media: "none" },
        { channelId: "ch_x", service: "twitter", text: "x".repeat(300), media: "none" },
      ],
    })
  ).json();
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[0].post.dueAt, due);
  assert.equal(r.results[1].ok, false);
  assert.match(r.results[1].error, /cannot exceed 280/);

  const d = await (await b.post("/api/ship", { game: "product-theater", mode: "draft", posts: [{ channelId: "ch_threads", service: "threads", text: "draft" }] })).json();
  assert.equal(d.results[0].post.status, "draft");
  assert.equal(mock.state.posts.at(-1)!.input.saveToDraft, true);

  const past = await b.post("/api/ship", { game: "product-theater", mode: "schedule", dueAt: "2020-01-01T00:00:00Z", posts: [{ channelId: "ch_x", text: "a" }] });
  assert.equal(past.status, 400);
});

test("ship refuses cross-site requests and signed-out callers", async () => {
  const b = new Browser();
  await b.connect();
  const n = mock.state.posts.length;
  const payload = { game: "product-theater", mode: "now", posts: [{ channelId: "ch_x", service: "twitter", text: "pwned" }] };
  const evil = await b.post("/api/ship", payload, "https://evil.example");
  assert.equal(evil.status, 403);
  const none = await b.post("/api/ship", payload, null);
  assert.equal(none.status, 403);
  assert.equal(mock.state.posts.length, n, "nothing posted");
  // control: same request from our own origin goes through
  const ok = await b.post("/api/ship", payload);
  assert.equal(ok.status, 200);
  assert.equal(mock.state.posts.length, n + 1);
  const anon = await new Browser().post("/api/ship", payload);
  assert.equal(anon.status, 401);
});

test("ship ignores a cover URL from the page; it re-reads the game", async () => {
  const b = new Browser();
  await b.connect();
  await b.post("/api/ship", {
    game: "product-theater",
    mode: "queue",
    image: "https://evil.example/x.jpg",
    posts: [{ channelId: "ch_x", service: "twitter", text: "hi", media: "image", image: "https://evil.example/x.jpg" }],
  });
  assert.doesNotMatch(JSON.stringify(mock.state.posts.at(-1)!.input), /evil/);
});

test("expired access token is refreshed once and the rotated refresh token is kept", async () => {
  const short = await startMock(0, { expiresIn: 0 });
  const saved = env;
  env = { ...env, BUFFER_AUTH_BASE: short.url, BUFFER_API_URL: short.url + "/", BETACADE_ORIGIN: short.url };
  try {
    const b = new Browser();
    await b.connect();
    const c1 = b.jar.get("stb_session");
    // expires_in 0 is clamped to 60s, so push the clock forward
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      const me1 = await (await b.get("/api/me")).json();
      assert.equal(me1.connected, true);
      assert.notEqual(b.jar.get("stb_session"), c1, "new sealed cookie after refresh");
      Date.now = () => realNow() + 300_000;
      const me2 = await (await b.get("/api/me")).json();
      assert.equal(me2.connected, true, "second refresh uses the rotated token, not the spent one");
      assert.equal(short.state.calls.filter((c) => c === "POST /token").length, 3);
    } finally {
      Date.now = realNow;
    }
  } finally {
    env = saved;
    await short.close();
  }
});

test("logout clears the session and needs our origin", async () => {
  const b = new Browser();
  await b.connect();
  const evil = await b.send(new Request(APP + "/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } }));
  assert.equal(evil.status, 403);
  assert.ok(b.jar.has("stb_session"));
  await b.send(new Request(APP + "/auth/logout", { method: "POST", headers: { origin: APP } }));
  assert.ok(!b.jar.has("stb_session"));
});

test("post input: facebook and instagram get their required metadata", () => {
  const game = { url: "https://play.betacade.com/g/a", title: "A", description: "d", image: "https://play.betacade.com/g/a/c.jpg" };
  const fb = buildPostInput({ channelId: "c", service: "facebook", text: "t", mode: "next", media: "image", game });
  assert.deepEqual(fb.metadata, { facebook: { type: "post" } });
  assert.equal(fb.mode, "shareNext");
  const ig = buildPostInput({ channelId: "c", service: "instagram", text: "t", mode: "queue", media: "link", game });
  assert.deepEqual(ig.metadata, { instagram: { type: "post", shouldShareToFeed: true } });
  assert.ok(Array.isArray(ig.assets), "instagram falls back to the image");
});
