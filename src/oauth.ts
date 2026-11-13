import { b64url } from "./session.ts";

// Buffer requires PKCE for every client, confidential ones included.
export const SCOPES = "account:read posts:read posts:write offline_access";

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export function authorizeUrl(
  authBase: string,
  p: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const u = new URL(authBase.replace(/\/$/, "") + "/auth");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

export type Tokens = { at: string; rt?: string; exp: number };

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function tokenRequest(authBase: string, body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(authBase.replace(/\/$/, "") + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
  });
  let json: TokenResponse = {};
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    // fall through to the error below
  }
  if (!res.ok || !json.access_token) {
    throw new Error(`token endpoint: ${json.error || res.status} ${json.error_description || ""}`.trim());
  }
  return {
    at: json.access_token,
    rt: json.refresh_token,
    // a minute of margin so a token doesn't expire mid-request
    exp: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  };
}

export function exchangeCode(
  authBase: string,
  p: { clientId: string; clientSecret?: string; code: string; redirectUri: string; verifier: string },
): Promise<Tokens> {
  const body: Record<string, string> = {
    client_id: p.clientId,
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  };
  if (p.clientSecret) body.client_secret = p.clientSecret;
  return tokenRequest(authBase, body);
}

export function refresh(
  authBase: string,
  p: { clientId: string; clientSecret?: string; refreshToken: string },
): Promise<Tokens> {
  const body: Record<string, string> = {
    client_id: p.clientId,
    grant_type: "refresh_token",
    refresh_token: p.refreshToken,
  };
  if (p.clientSecret) body.client_secret = p.clientSecret;
  return tokenRequest(authBase, body);
}
