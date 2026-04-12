import { createSessionToken, verifyJwt } from "./jwt.js";
import type { AuthConfig, SessionPayload } from "./types.js";

export function createSessionTokenForConfig(username: string, config: AuthConfig): string {
  return createSessionToken(username, config.jwtSecret, config.sessionDurationSeconds);
}

export function verifySessionToken(
  token: string,
  config: Pick<AuthConfig, "jwtSecret">,
): SessionPayload | null {
  return verifyJwt(token, config.jwtSecret);
}
