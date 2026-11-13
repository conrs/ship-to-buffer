// Sealed cookies: AES-GCM with a key derived from SESSION_SECRET, so tokens never reach page JS.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { b64url, unb64url };

async function keyFor(secret: string, purpose: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(purpose + ":" + secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// purpose doubles as additional data, so a state cookie can't be replayed as a session cookie.
export async function seal(secret: string, purpose: string, value: unknown): Promise<string> {
  const key = await keyFor(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(purpose) },
      key,
      enc.encode(JSON.stringify(value)),
    ),
  );
  return b64url(iv) + "." + b64url(ct);
}

export async function unseal<T>(secret: string, purpose: string, sealed: string | undefined): Promise<T | null> {
  if (!sealed) return null;
  const [ivPart, ctPart] = sealed.split(".");
  if (!ivPart || !ctPart) return null;
  try {
    const key = await keyFor(secret, purpose);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64url(ivPart), additionalData: enc.encode(purpose) },
      key,
      unb64url(ctPart),
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function cookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
