import { isValidCredential } from "./jwt.js";
import type { AuthConfig } from "./types.js";

export function isValidCredentialLogin(
  username: string,
  password: string,
  config: Pick<AuthConfig, "username" | "password">,
): boolean {
  return isValidCredential(username, password, config.username, config.password);
}
