# OpenClaw Custom Web UI

Standalone React-based operator UI for OpenClaw.

## What It Uses

- Same Gateway browser contract as the built-in Control UI
- `GatewayBrowserClient` from the existing Control UI code
- AI Elements components for conversation, prompt input, reasoning, model picker, and message rendering
- Static build output under `dist/custom-web-ui`

## MVP Features

- Connects as a `webchat` browser operator client
- Loads bootstrap config from `__openclaw/control-ui-config.json`
- Lists and switches sessions
- Loads chat history
- Sends chat messages with image attachments
- Streams assistant deltas
- Handles abort
- Shows transcript reasoning blocks
- Shows tool cards
- Supports per-session model switching via `sessions.patch`

## Local Commands

```bash
pnpm ui:custom:dev
pnpm ui:custom:build
```

## Dev Origin Requirement

When running the app on the Vite dev server, the Gateway must explicitly allow the UI origin.
At minimum, add your dev origins to `gateway.controlUi.allowedOrigins`, for example:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": [
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "http://5174.192.168.0.204.sslip.io"
      ]
    }
  }
}
```

Without that allowlist entry, the browser can load the page but the WebSocket session will be rejected by the Gateway.

## Mount Through The Gateway

Build the app first:

```bash
pnpm ui:custom:build
```

Then point OpenClaw to the generated static directory:

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true,
      "root": "/home/pibo/code/openclaw/dist/custom-web-ui"
    }
  }
}
```

Restart the gateway after changing the config.

## Current Limits

- Internal MVP only; no browser-to-Telegram outbound
- Prompt attachments are image-focused
- Bundle is still heavy because AI Elements pulls in `streamdown` and code/highlight dependencies
