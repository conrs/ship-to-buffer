// Thin client for Buffer's GraphQL API (https://developers.buffer.com).

export class BufferAuthError extends Error {}

export type Channel = {
  id: string;
  name: string;
  displayName: string | null;
  service: string;
  avatar: string;
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
  timezone: string;
};

export type Organization = { id: string; name: string; channels: Channel[] };

type GqlResult<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };

export async function gql<T>(apiUrl: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) throw new BufferAuthError("Buffer rejected the token");
  if (res.status === 429) {
    const wait = res.headers.get("retry-after");
    throw new Error(`Buffer rate limit reached${wait ? `, try again in ${wait}s` : ""}`);
  }
  let body: GqlResult<T>;
  try {
    body = (await res.json()) as GqlResult<T>;
  } catch {
    throw new Error(`Buffer API returned ${res.status}`);
  }
  if (body.errors?.length) {
    const e = body.errors[0];
    if (e.extensions?.code === "UNAUTHENTICATED" || e.extensions?.code === "UNAUTHORIZED") throw new BufferAuthError(e.message);
    throw new Error(e.message);
  }
  if (!body.data) throw new Error(`Buffer API returned ${res.status} with no data`);
  return body.data;
}

const ME = `query Me { account { id name organizations { id name } } }`;

const CHANNELS = `query Channels($input: ChannelsInput!) {
  channels(input: $input) {
    id name displayName service avatar isDisconnected isLocked isQueuePaused timezone
  }
}`;

export async function loadAccount(apiUrl: string, token: string) {
  const me = await gql<{ account: { id: string; name: string | null; organizations: { id: string; name: string }[] } }>(apiUrl, token, ME);
  const organizations: Organization[] = [];
  for (const org of me.account.organizations) {
    const ch = await gql<{ channels: Channel[] }>(apiUrl, token, CHANNELS, { input: { organizationId: org.id } });
    organizations.push({ id: org.id, name: org.name, channels: ch.channels });
  }
  return { name: me.account.name, organizations };
}

const CREATE_POST = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id dueAt status } }
    ... on MutationError { message }
  }
}`;

export type ShipMode = "queue" | "next" | "now" | "schedule" | "draft";
export type Media = "image" | "link" | "none";

export type ShipInput = {
  channelId: string;
  service: string;
  text: string;
  mode: ShipMode;
  dueAt?: string;
  media: Media;
  game: { url: string; title: string; description: string; image: string | null };
};

const LINK_CARD_SERVICES = new Set(["bluesky", "facebook", "linkedin", "threads"]);

export function buildPostInput(s: ShipInput): Record<string, unknown> {
  const input: Record<string, unknown> = {
    channelId: s.channelId,
    text: s.text,
    schedulingType: "automatic",
    mode:
      s.mode === "now" ? "shareNow" : s.mode === "next" ? "shareNext" : s.mode === "schedule" ? "customScheduled" : "addToQueue",
    source: "ship-to-buffer",
  };
  if (s.mode === "schedule") input.dueAt = new Date(s.dueAt!).toISOString();
  if (s.mode === "draft") input.saveToDraft = true;

  const metadata: Record<string, Record<string, unknown>> = {};
  if (s.service === "facebook") metadata.facebook = { type: "post" };
  if (s.service === "instagram") metadata.instagram = { type: "post", shouldShareToFeed: true };

  // linkAttachment and assets are mutually exclusive in Buffer's API.
  if (s.media === "link" && LINK_CARD_SERVICES.has(s.service)) {
    const card: Record<string, unknown> = { url: s.game.url, title: s.game.title, description: s.game.description };
    if (s.game.image) card.thumbnail = { url: s.game.image };
    metadata[s.service] = { ...(metadata[s.service] || {}), linkAttachment: card };
  } else if (s.media !== "none" && s.game.image) {
    input.assets = [{ image: { url: s.game.image } }];
  }
  if (Object.keys(metadata).length) input.metadata = metadata;
  return input;
}

export async function createPost(apiUrl: string, token: string, s: ShipInput) {
  const data = await gql<{ createPost: { __typename: string; post?: { id: string; dueAt: string | null; status: string }; message?: string } }>(
    apiUrl,
    token,
    CREATE_POST,
    { input: buildPostInput(s) },
  );
  const r = data.createPost;
  if (r.post) return { ok: true as const, post: r.post };
  return { ok: false as const, error: r.message || r.__typename };
}
