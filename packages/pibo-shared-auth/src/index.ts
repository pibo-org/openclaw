export {
  base64UrlEncode,
  base64UrlDecode,
  signJwt,
  verifyJwt,
  createSessionToken,
  isValidCredential,
} from "./jwt.js";

export type { SessionPayload, AuthConfig } from "./types.js";
export { DEFAULT_SESSION_DURATION } from "./types.js";
