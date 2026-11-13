// Drafting and length rules. Plain JS so the page and the tests share one copy.
// Limits and counting rules follow https://developers.buffer.com/guides/character-limits.md

export const SERVICES = {
  twitter: { label: "X", limit: 280, url: 23, count: "weighted" },
  bluesky: { label: "Bluesky", limit: 300, count: "graphemes" },
  threads: { label: "Threads", limit: 500, count: "utf16" },
  linkedin: { label: "LinkedIn", limit: 3000, url: 24, count: "utf16" },
  mastodon: { label: "Mastodon", limit: 500, url: 23, count: "utf16" },
  facebook: { label: "Facebook", limit: 5000, count: "utf16" },
  instagram: { label: "Instagram", limit: 2196, count: "instagram", needsImage: true },
  googlebusiness: { label: "Google Business", limit: 4000, count: "utf16" },
};

// Services that need a video, a board or a title we don't have, so they're shown but not offered.
export const UNSUPPORTED = {
  youtube: "needs a video",
  tiktok: "needs a video",
  pinterest: "needs a board",
  substack: "not a launch-post network",
  startPage: "not a social network",
  whatsapp: "not supported by the API for posts",
};

export const LINK_CARD = new Set(["bluesky", "facebook", "linkedin", "threads"]);

const URL_RE = /https?:\/\/[^\s]+/g;

function graphemes(s) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    let n = 0;
    for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}

// X weights most non-Latin characters and emoji as 2; this approximation errs on the long side.
function weighted(s) {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    n += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return n;
}

export function countFor(service, text) {
  const spec = SERVICES[service] || { limit: 500, count: "utf16" };
  let rest = text;
  let urlCost = 0;
  if (spec.url || spec.count === "graphemes") {
    rest = text.replace(URL_RE, (u) => {
      if (spec.url) urlCost += spec.url;
      else {
        // Bluesky shows a URL as its host plus up to 16 more characters.
        try {
          const p = new URL(u);
          const tail = (p.pathname + p.search + p.hash).replace(/^\/$/, "");
          urlCost += graphemes(p.host) + Math.min(16, graphemes(tail));
        } catch {
          urlCost += graphemes(u);
        }
      }
      return "";
    });
  }
  let n;
  if (spec.count === "graphemes") n = graphemes(rest);
  else if (spec.count === "weighted") n = weighted(rest);
  else if (spec.count === "instagram") n = rest.length + (rest.match(/\n/g) || []).length;
  else n = rest.length;
  return { used: n + urlCost, limit: spec.limit };
}

export function fits(service, text) {
  const { used, limit } = countFor(service, text);
  return used <= limit;
}

// Shortens `long` at a word boundary until build(long) fits the service's limit.
function fitWith(service, build, long) {
  if (fits(service, build(long))) return build(long);
  const words = long.split(/\s+/);
  for (let n = words.length - 1; n > 0; n--) {
    const cut = words.slice(0, n).join(" ").replace(/[\s,;:.!?-]+$/, "") + "…";
    if (fits(service, build(cut))) return build(cut);
  }
  return build("");
}

function firstSentence(s) {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : s;
}

// Small seeded PRNG so a reroll is repeatable in tests.
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return (a >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

const join = (...parts) => parts.filter(Boolean).join("\n\n");

export function draftPlain(service, game) {
  const { title, description: d, url } = game;
  const short = firstSentence(d);
  switch (service) {
    case "twitter":
      return fitWith(service, (x) => join(`${title}${x ? ": " + x : ""}`, `Play it free in your browser: ${url}`), short);
    case "bluesky":
      return fitWith(service, (x) => join(`New on Betacade: ${title}`, x, `Play free, no install: ${url}`), short);
    case "threads":
    case "mastodon":
      return fitWith(
        service,
        (x) => join(`${title} is up for playtesting.`, x, `Play it free in your browser: ${url}`, "#gamedev #indiegames"),
        d,
      );
    case "linkedin":
      return fitWith(
        service,
        (x) =>
          join(
            `We just shipped a new build of ${title}, and it's open for playtesting.`,
            x,
            "It runs in the browser, no install or account needed. If you play, I'd love to hear what worked and what didn't.",
            `Play: ${url}`,
            "#gamedev #indiedev #playtesting",
          ),
        d,
      );
    case "instagram":
      return fitWith(service, (x) => join(`${title} is live for playtesting.`, x, "Play it free in your browser, link in bio.", "#gamedev #indiegames #playtest"), d);
    default:
      return fitWith(service, (x) => join(`${title} is up for playtesting.`, x, `Play it free in your browser: ${url}`), d);
  }
}

// Product Theater: the launch post, as announced by a product manager with too much power.
const OPENERS = [
  (t) => `📣 Big news. Today we're thrilled, humbled and slightly over-caffeinated to announce ${t}.`,
  (t) => `Introducing ${t}: a game. We A/B tested the word "game" and it won.`,
  (t) => `After zero customer interviews and one very long offsite, ${t} is live.`,
  (t) => `${t} is here. It has been on the roadmap since before we had a roadmap.`,
  (t) => `Some launches change everything. ${t} changes several things, ranked by impact.`,
];

const MIDDLES = [
  "Playing is now included at no extra cost (for now).",
  "Buttons are now pressable on every day of the week.",
  "Fun has been promoted to a first-class feature. It reports directly to me.",
  "We added a beginning, a middle and an end. The middle is new.",
  "Every pixel was hand-placed by our pixel team, who are also me.",
  "Our north star metric is \"you, playing it\". Please move the metric.",
];

const CLOSERS = [
  "Early access is open to everyone, which makes it exclusive in a very inclusive way.",
  "Tap the link before we add a waitlist.",
  "Feedback welcome. It will be read by our feedback team, which is also me.",
  "Free to play. A Pro tier is coming in Q3. It does nothing, but it's Pro.",
  "No install. No account. No synergy, yet.",
];

const LINKEDIN_TAGS = "#Leadership #Gaming #Synergy #Disruption #Agree?";

export function draftTheater(service, game, seed = 1) {
  // Each network gets its own pitch from the same seed.
  let salt = 0;
  for (const ch of service) salt = (salt * 31 + ch.charCodeAt(0)) >>> 0;
  const r = rng(seed * 2654435761 + salt);
  const { title, description: d, url } = game;
  const open = pick(r, OPENERS)(title);
  const mid = pick(r, MIDDLES);
  const close = pick(r, CLOSERS);
  const pitch = firstSentence(d);
  switch (service) {
    case "twitter":
    case "bluesky":
      return fitWith(service, (x) => join(open, x, `▶ ${url}`), mid);
    case "linkedin":
      return fitWith(
        service,
        (x) =>
          join(
            "I'm humbled to announce something I've been heads-down on for what feels like several quarters.",
            open,
            x,
            mid,
            close,
            `Play: ${url}`,
            "Agree?",
            LINKEDIN_TAGS,
          ),
        pitch,
      );
    case "instagram":
      return fitWith(service, (x) => join(open, x, mid, close, "Link in bio. The bio is also new."), pitch);
    default:
      return fitWith(service, (x) => join(open, x, mid, close, url), pitch);
  }
}

export function draft(service, game, { theater = false, seed = 1 } = {}) {
  return theater ? draftTheater(service, game, seed) : draftPlain(service, game);
}
