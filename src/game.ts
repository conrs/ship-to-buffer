// Reads a Betacade game's public play page. Only play.betacade.com/g/<slug> is accepted, and the
// fetch target is rebuilt from the slug, so a pasted URL can't point the Worker anywhere else.

export type Game = {
  slug: string;
  url: string;
  title: string;
  description: string;
  image: string | null;
  color: string | null;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugFrom(input: string): string | null {
  const s = input.trim();
  if (SLUG.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
  } catch {
    return null;
  }
  if (u.hostname === "play.betacade.com") {
    const m = u.pathname.match(/^\/g\/([^/]+)/);
    return m && SLUG.test(m[1]) ? m[1] : null;
  }
  // <slug>.games.betacade.com is a game's own origin; its play page has the same slug.
  const own = u.hostname.match(/^([a-z0-9-]+)\.games\.betacade\.com$/);
  return own && SLUG.test(own[1]) ? own[1] : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function meta(html: string, attr: "property" | "name", key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const k = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
    if (!k || k[1].toLowerCase() !== key) continue;
    const c = tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i);
    if (c) return decodeEntities(c[1]).trim();
  }
  return null;
}

export function parseGamePage(html: string, slug: string, origin: string): Game | null {
  const title = meta(html, "property", "og:title");
  if (!title) return null;
  const description = meta(html, "property", "og:description") || meta(html, "name", "description") || "";
  let image = meta(html, "property", "og:image");
  if (image) {
    try {
      const u = new URL(image, origin);
      image = u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1" ? u.toString() : null;
    } catch {
      image = null;
    }
  }
  const color = meta(html, "name", "theme-color");
  return {
    slug,
    url: `https://play.betacade.com/g/${slug}`,
    title,
    description,
    image,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
  };
}

export async function fetchGame(origin: string, slug: string): Promise<Game | null> {
  let target = `${origin.replace(/\/$/, "")}/g/${slug}`;
  // A renamed game answers with a redirect to its new slug; follow up to three, same host only.
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(target, { redirect: "manual", headers: { accept: "text/html", "user-agent": "ship-to-buffer/1.0" } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      const next = new URL(loc, target);
      const m = next.pathname.match(/^\/g\/([a-z0-9-]+)\/?$/);
      if (next.origin !== new URL(origin).origin || !m) return null;
      slug = m[1];
      target = next.toString();
      continue;
    }
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    return parseGamePage(html, slug, origin);
  }
  return null;
}
