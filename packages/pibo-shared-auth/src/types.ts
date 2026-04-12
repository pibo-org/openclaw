export type SessionPayload = {
  sub: string;
  type: "session";
  iat: number;
  exp: number;
};

export type AuthConfig = {
  username: string;
  password: string;
  jwtSecret: string;
  sessionDurationSeconds?: number;
  sessionCookieName?: string;
  sessionCookieDomain?: string;
};

export type SharedAuthEnv = {
  APP_USERNAME?: string;
  APP_PASSWORD?: string;
  APP_JWT_SECRET?: string;
  APP_SESSION_DURATION_SECONDS?: string;
  APP_SESSION_COOKIE_NAME?: string;
  APP_SESSION_COOKIE_DOMAIN?: string;
  NODE_ENV?: string;
};

export const DEFAULT_SESSION_DURATION = 60 * 60 * 24 * 30; // 30 days
