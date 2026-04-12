import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionPayload } from "./types.js";
import { DEFAULT_SESSION_DURATION } from "./types.js";

// --- Base64URL Helpers ---

export function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function base64UrlDecode(input: string): string {
  const padded = input
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

// --- JWT Sign & Verify ---

export function signJwt(payload: SessionPayload, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest();
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

export function verifyJwt(token: string, secret: string): SessionPayload | null {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return null;
  }

  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", secret).update(unsigned).digest();
  const actualSignature = Buffer.from(
    encodedSignature
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(encodedSignature.length / 4) * 4, "="),
    "base64",
  );

  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;
    if (typeof payload.sub !== "string") {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// --- Session Token ---

export function createSessionToken(
  username: string,
  secret: string,
  durationSeconds?: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      sub: username,
      type: "session",
      iat: now,
      exp: now + (durationSeconds ?? DEFAULT_SESSION_DURATION),
    },
    secret,
  );
}

// --- Credential Check ---

export function isValidCredential(
  username: string,
  password: string,
  configUsername: string,
  configPassword: string,
): boolean {
  return username === configUsername && password === configPassword;
}
