import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICES, countFor, draft, fits } from "../public/draft.js";

const game = {
  title: "Product Theater",
  url: "https://play.betacade.com/g/product-theater",
  description:
    "One bookmarklet turns every website into a product run by a desperate PM: what's-new tours, Sudoku gates, paywalls, a chatbot that upsells, and API keys earned by quick-time event. Try it free, no install. Esc twice to escape.",
};

const long = { ...game, description: "Words go here and keep going. ".repeat(400) };

test("every draft fits its network, plain and theater, short and very long", () => {
  for (const service of Object.keys(SERVICES)) {
    for (const g of [game, long]) {
      for (const theater of [false, true]) {
        for (const seed of [1, 2, 3, 99, 12345]) {
          const text = draft(service, g, { theater, seed });
          assert.ok(fits(service, text), `${service} theater=${theater} seed=${seed}: ${countFor(service, text).used}`);
          assert.ok(text.trim().length > 0);
          if (service !== "instagram") assert.ok(text.includes(g.url), `${service} has the play link`);
        }
      }
    }
  }
});

test("no em dashes in any generated copy", () => {
  for (const service of Object.keys(SERVICES))
    for (const theater of [false, true])
      for (let seed = 1; seed < 40; seed++) assert.ok(!draft(service, game, { theater, seed }).includes("—"));
});

test("counting follows Buffer's rules", () => {
  // X: a URL costs 23 whatever its length; emoji cost 2
  assert.equal(countFor("twitter", "hi https://play.betacade.com/g/a-very-long-slug-name").used, 3 + 23);
  assert.equal(countFor("twitter", "🚀").used, 2);
  // Bluesky counts graphemes: a family emoji is 1
  assert.equal(countFor("bluesky", "👨‍👩‍👧").used, 1);
  // LinkedIn URLs are 24
  assert.equal(countFor("linkedin", "https://example.com/x").used, 24);
  // Instagram line breaks count 2
  assert.equal(countFor("instagram", "a\nb").used, 4);
});

test("theater reroll changes the copy and is repeatable", () => {
  const a = draft("linkedin", game, { theater: true, seed: 1 });
  assert.equal(a, draft("linkedin", game, { theater: true, seed: 1 }));
  const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => draft("linkedin", game, { theater: true, seed })));
  assert.ok(seen.size > 2);
  assert.match(a, /Agree\?/);
});
