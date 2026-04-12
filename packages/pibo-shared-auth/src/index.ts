export {
  DEFAULT_JWT_SECRET,
  DEFAULT_PASSWORD,
  DEFAULT_PRODUCTION_SESSION_COOKIE_DOMAIN,
  DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_USERNAME,
} from "./constants.js";
export { resolveAuthConfig } from "./config.js";
export { isValidCredentialLogin } from "./credentials.js";
export {
  base64UrlEncode,
  base64UrlDecode,
  signJwt,
  verifyJwt,
  createSessionToken,
  isValidCredential,
} from "./jwt.js";
export { createSessionTokenForConfig, verifySessionToken } from "./session.js";

export type { SessionPayload, AuthConfig, SharedAuthEnv } from "./types.js";
export { DEFAULT_SESSION_DURATION } from "./types.js";
