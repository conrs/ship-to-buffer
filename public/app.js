import { SERVICES, UNSUPPORTED, LINK_CARD, countFor, draft } from "./draft.js";

const $ = (id) => document.getElementById(id);

// Shown before Buffer is connected, so the drafts can be tried first.
const PREVIEW_CHANNELS = ["twitter", "bluesky", "threads", "linkedin"].map((service) => ({
  id: "preview-" + service,
  name: SERVICES[service].label,
  displayName: null,
  service,
  avatar: "",
  preview: true,
}));

const state = {
  account: null,
  game: null,
  theater: false,
  seed: 1,
  posts: {}, // channelId -> { on, text, media, edited }
};

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
}

function flash(msg, kind = "info") {
  const f = $("flash");
  f.textContent = msg;
  f.className = "flash " + kind;
  f.hidden = !msg;
}

function channels() {
  if (!state.account) return PREVIEW_CHANNELS;
  return state.account.organizations.flatMap((o) =>
    o.channels.map((c) => ({ ...c, org: state.account.organizations.length > 1 ? o.name : "" })),
  );
}

function usable(c) {
  if (c.preview) return true;
  return SERVICES[c.service] && !UNSUPPORTED[c.service] && !c.isDisconnected && !c.isLocked;
}

function whyNot(c) {
  if (c.isDisconnected) return "disconnected in Buffer";
  if (c.isLocked) return "locked on your plan";
  return UNSUPPORTED[c.service] || "not supported yet";
}

// ---------- account ----------

function renderAccount() {
  const box = $("account");
  box.replaceChildren();
  if (state.account) {
    box.append(
      el("span", { class: "muted small", text: "Buffer: " }),
      el("strong", { text: state.account.name || "connected" }),
      el("button", { class: "btn ghost small", type: "button", onclick: signOut, text: "Sign out" }),
    );
  } else {
    box.append(el("a", { class: "btn buffer", href: "/auth/login", text: "Connect Buffer", onclick: keep }));
  }
}

async function loadAccount() {
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    const j = await r.json();
    state.account = j.connected ? j : null;
    if (!r.ok && j.error) flash("Buffer: " + j.error, "error");
  } catch {
    state.account = null;
  }
  renderAccount();
  renderDrafts();
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  state.account = null;
  state.posts = {};
  renderAccount();
  renderDrafts();
}

// ---------- game ----------

async function loadGame(input) {
  flash("");
  const r = await fetch("/api/game?url=" + encodeURIComponent(input));
  const j = await r.json().catch(() => ({ error: "Couldn't read that game." }));
  if (!r.ok) {
    flash(j.error, "error");
    return;
  }
  state.game = j;
  state.posts = {};
  try {
    localStorage.setItem("stb:game", j.slug);
  } catch {}
  history.replaceState(null, "", "?game=" + encodeURIComponent(j.slug));
  $("gameUrl").value = j.url;
  renderGame();
  renderDrafts();
}

function renderGame() {
  const g = state.game;
  const card = $("gameCard");
  card.hidden = !g;
  if (!g) return;
  card.style.setProperty("--accent", g.color || "var(--brand)");
  document.documentElement.style.setProperty("--accent", g.color || "var(--brand)");
  $("gameCover").src = g.image || "";
  $("gameCover").hidden = !g.image;
  $("gameTitle").textContent = g.title;
  $("gameDesc").textContent = g.description;
  $("gameLink").href = g.url;
  $("gameLink").textContent = g.url.replace(/^https:\/\//, "");
}

// ---------- connecting keeps your work ----------

// Buffer's sign-in leaves the page, so what was set up (Theater, the reroll, edited drafts, how to ship) rides along in
// sessionStorage and comes back with it. Edits are kept by network, since preview channels become real ones.
const KEEP = "stb:pending";
function keep() {
  try {
    const edits = {};
    for (const c of channels()) {
      const p = state.posts[c.id];
      if (p?.edited) edits[c.service] = p.text;
    }
    sessionStorage.setItem(KEEP, JSON.stringify({ game: state.game?.slug, theater: state.theater, seed: state.seed, mode: mode(), dueAt: $("dueAt").value, edits }));
  } catch {}
}
function connect() {
  keep();
  location.href = "/auth/login";
}
let kept = null;
try {
  kept = JSON.parse(sessionStorage.getItem(KEEP) || "null");
  sessionStorage.removeItem(KEEP);
} catch {}

// ---------- drafts ----------

function postFor(c) {
  if (!state.posts[c.id]) {
    const mine = kept?.edits?.[c.service];
    state.posts[c.id] = {
      on: usable(c),
      text: mine ?? draft(c.service, state.game, { theater: state.theater, seed: state.seed }),
      media: "image",
      edited: mine != null,
    };
  }
  return state.posts[c.id];
}

function redraft() {
  for (const c of channels()) {
    const p = state.posts[c.id];
    if (p && !p.edited) p.text = draft(c.service, state.game, { theater: state.theater, seed: state.seed });
  }
  renderDrafts();
}

function counter(c, text) {
  const { used, limit } = countFor(c.service, text);
  return { label: `${used} / ${limit}`, over: used > limit };
}

function renderDrafts() {
  const box = $("drafts");
  box.replaceChildren();
  const list = channels();
  $("channelNote").textContent = state.account
    ? `${list.filter(usable).length} channel(s) from your Buffer`
    : "Previewing. Connect Buffer to post to your own channels.";
  // Connected, but nothing to post to: say so plainly and send them to set one up, before anything else.
  if (state.account && !list.some(usable)) {
    box.append(
      el("div", { class: "empty-channels" },
        el("strong", { text: list.length ? "None of your Buffer channels can post right now." : "Your Buffer has no channels yet." }),
        el("p", { text: "Connect X, Bluesky, LinkedIn or Threads in Buffer, then come back and check again. Your game and drafts stay here." }),
        el("div", { class: "row" },
          el("a", { class: "btn buffer", href: "https://publish.buffer.com/channels/connect", target: "_blank", rel: "noopener", text: "Set up channels in Buffer" }),
          el("button", { type: "button", class: "btn ghost", text: "Check again", onclick: async () => { await loadAccount(); renderDrafts(); } }),
        ),
      ),
    );
  }
  if (!state.game) {
    box.append(el("p", { class: "muted", text: "Pick a game to draft its posts." }));
    updateShip();
    return;
  }
  for (const c of list) {
    if (!usable(c)) {
      box.append(
        el("div", { class: "draft off" },
          el("div", { class: "draft-head" },
            avatar(c),
            el("span", { class: "who", text: c.displayName || c.name }),
            el("span", { class: "svc", text: c.service }),
            el("span", { class: "muted small", text: whyNot(c) }),
          ),
        ),
      );
      continue;
    }
    const p = postFor(c);
    const count = counter(c, p.text);
    const countEl = el("span", { class: "count" + (count.over ? " over" : ""), text: count.label });
    const ta = el("textarea", { rows: c.service === "linkedin" ? 9 : 5, "aria-label": `Post for ${c.displayName || c.name}` });
    ta.value = p.text;
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + 2 + "px";
    };
    requestAnimationFrame(grow);
    ta.addEventListener("input", () => {
      grow();
      p.text = ta.value;
      p.edited = true;
      const k = counter(c, p.text);
      countEl.textContent = k.label;
      countEl.className = "count" + (k.over ? " over" : "");
      updateShip();
    });
    const toggle = el("input", { type: "checkbox", "aria-label": "Include this channel" });
    toggle.checked = p.on;
    toggle.addEventListener("change", () => {
      p.on = toggle.checked;
      card.classList.toggle("skipped", !p.on);
      updateShip();
    });
    const mediaOpts = [["image", "Cover image"], ...(LINK_CARD.has(c.service) ? [["link", "Link card"]] : []), ["none", "Text only"]];
    if (SERVICES[c.service]?.needsImage) mediaOpts.splice(1);
    const media = el("select", { "aria-label": "Attachment", class: "small" });
    for (const [v, label] of mediaOpts) media.append(el("option", { value: v, text: label }));
    media.value = p.media;
    media.addEventListener("change", () => (p.media = media.value));
    const reset = el("button", {
      type: "button",
      class: "btn ghost small",
      text: "Reset",
      onclick: () => {
        p.text = draft(c.service, state.game, { theater: state.theater, seed: state.seed });
        p.edited = false;
        renderDrafts();
      },
    });
    const card = el("div", { class: "draft" + (p.on ? "" : " skipped") },
      el("div", { class: "draft-head" },
        el("label", { class: "pick" }, toggle, avatar(c), el("span", { class: "who", text: c.displayName || c.name })),
        el("span", { class: "svc", text: SERVICES[c.service]?.label || c.service }),
        c.org ? el("span", { class: "muted small", text: c.org }) : null,
        c.isQueuePaused ? el("span", { class: "warn small", text: "queue paused" }) : null,
      ),
      ta,
      el("div", { class: "draft-foot" }, media, reset, countEl),
    );
    box.append(card);
  }
  updateShip();
}

function avatar(c) {
  if (!c.avatar) return el("span", { class: "av blank", "aria-hidden": "true", text: (SERVICES[c.service]?.label || c.service)[0] });
  return el("img", { class: "av", src: c.avatar, alt: "", referrerpolicy: "no-referrer" });
}

// ---------- ship ----------

function selected() {
  return channels().filter((c) => usable(c) && state.posts[c.id]?.on);
}

function mode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function updateShip() {
  const btn = $("ship");
  const picks = selected();
  const over = picks.some((c) => counter(c, state.posts[c.id].text).over || !state.posts[c.id].text.trim());
  if (!state.account) {
    btn.textContent = "Connect Buffer to ship";
    btn.disabled = false;
    btn.dataset.action = "connect";
    return;
  }
  btn.dataset.action = "ship";
  if (!channels().some(usable)) {
    btn.textContent = "Set up a channel in Buffer first";
    btn.disabled = true;
    return;
  }
  const verb = { queue: "Queue", next: "Queue next", schedule: "Schedule", now: "Share now", draft: "Save drafts" }[mode()];
  btn.textContent = picks.length ? `${verb} on ${picks.length} channel${picks.length > 1 ? "s" : ""}` : "Pick a channel";
  btn.disabled = !state.game || !picks.length || over;
}

function describe(r, m) {
  if (!r.ok) return r.error || "failed";
  if (m === "draft") return "saved as a draft in Buffer";
  if (m === "now") return "sent to Buffer to publish now";
  const when = r.post?.dueAt ? new Date(r.post.dueAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  return when ? `queued for ${when}` : "queued";
}

async function ship() {
  const btn = $("ship");
  if (btn.dataset.action === "connect") {
    connect();
    return;
  }
  const m = mode();
  let dueAt;
  if (m === "schedule") {
    const v = $("dueAt").value;
    if (!v) {
      flash("Pick a date and time to schedule.", "error");
      return;
    }
    dueAt = new Date(v).toISOString();
  }
  if (m === "now" && !confirm("Publish these posts right now?")) return;
  const picks = selected();
  btn.disabled = true;
  btn.textContent = "Shipping…";
  const out = $("results");
  out.replaceChildren();
  try {
    const r = await fetch("/api/ship", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        game: state.game.slug,
        mode: m,
        dueAt,
        posts: picks.map((c) => ({ channelId: c.id, service: c.service, text: state.posts[c.id].text, media: state.posts[c.id].media })),
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      flash(j.error || "Shipping failed.", "error");
      if (r.status === 401) await loadAccount();
      return;
    }
    const byId = Object.fromEntries(picks.map((c) => [c.id, c]));
    let good = 0;
    for (const res of j.results) {
      const c = byId[res.channelId];
      if (res.ok) good++;
      out.append(
        el("li", { class: res.ok ? "ok" : "bad" },
          el("span", { class: "mark", "aria-hidden": "true", text: res.ok ? "✓" : "✕" }),
          el("strong", { text: c ? c.displayName || c.name : res.channelId }),
          el("span", { text: " " + describe(res, m) }),
        ),
      );
    }
    if (good) {
      out.append(el("li", { class: "next" }, el("a", { href: "https://publish.buffer.com", target: "_blank", rel: "noopener", text: "Open your Buffer queue ↗" })));
      celebrate();
    }
  } catch {
    flash("Network error while shipping. Nothing was retried.", "error");
  } finally {
    updateShip();
  }
}

// A small confetti burst in the game's own color.
function celebrate() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#50e3c2";
  const rect = $("ship").getBoundingClientRect();
  for (let i = 0; i < 28; i++) {
    const bit = el("span", { class: "confetti", "aria-hidden": "true" });
    bit.style.left = rect.left + rect.width / 2 + "px";
    bit.style.top = rect.top + window.scrollY + "px";
    bit.style.background = i % 3 ? color : "var(--fg)";
    bit.style.setProperty("--dx", (Math.random() * 2 - 1) * 180 + "px");
    bit.style.setProperty("--dy", -(60 + Math.random() * 160) + "px");
    bit.style.setProperty("--r", Math.random() * 720 + "deg");
    document.body.append(bit);
    setTimeout(() => bit.remove(), 1100);
  }
}

// ---------- wiring ----------

$("gameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("gameUrl").value.trim();
  if (v) loadGame(v);
});
for (const b of document.querySelectorAll("[data-demo]")) b.addEventListener("click", () => loadGame(b.dataset.demo));
$("theater").addEventListener("change", (e) => {
  state.theater = e.target.checked;
  $("reroll").hidden = !state.theater;
  document.body.classList.toggle("theater", state.theater);
  redraft();
});
$("reroll").addEventListener("click", () => {
  state.seed = (state.seed * 7 + 13) % 100003 || 1;
  redraft();
});
for (const r of document.querySelectorAll('input[name="mode"]'))
  r.addEventListener("change", () => {
    $("dueAt").hidden = mode() !== "schedule";
    updateShip();
  });
$("ship").addEventListener("click", ship);

const params = new URLSearchParams(location.search);
const err = params.get("error");
if (err) flash(err === "access_denied" ? "You cancelled the Buffer connection." : `Couldn't connect Buffer (${err}). Try again.`, "error");
if (params.get("connected")) flash("Buffer connected.", "ok");
// default schedule: tomorrow at 10:00 local
{
  const d = new Date(Date.now() + 86400000);
  d.setHours(10, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  $("dueAt").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
if (kept) {
  state.theater = !!kept.theater;
  state.seed = kept.seed || 1;
  $("theater").checked = state.theater;
  $("reroll").hidden = !state.theater;
  document.body.classList.toggle("theater", state.theater);
  const r = document.querySelector(`input[name="mode"][value="${CSS.escape(kept.mode || "queue")}"]`);
  if (r) r.checked = true;
  $("dueAt").hidden = mode() !== "schedule";
  if (kept.dueAt) $("dueAt").value = kept.dueAt;
}
let start = params.get("game") || kept?.game;
if (!start) {
  try {
    start = localStorage.getItem("stb:game");
  } catch {}
}
renderAccount();
loadAccount();
if (start) loadGame(start);
else history.replaceState(null, "", location.pathname);
