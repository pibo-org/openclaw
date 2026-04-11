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
};

export const DEFAULT_SESSION_DURATION = 60 * 60 * 24 * 30; // 30 days
