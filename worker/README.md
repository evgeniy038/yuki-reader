# Account-free pairing

`pair.yukireader.app` introduces two browsers over WebSocket. One SQLite-backed
Durable Object per room accepts two sides and forwards bounded opaque signaling
messages. Hibernation keeps idle sockets inexpensive. Pairing rooms expire after
five minutes; remembered connections rotate their server lifetime every day.
The service stores an expiry time, never books, metadata, pairing codes or keys.

Browsers derive separate room digests and AES-GCM signaling keys from the code.
The first device explicitly approves the second over WebRTC, then exchanges a
new random 256-bit pairing secret. Only that secret authorizes future sessions.
Books and library metadata use WebRTC directly; there is no file relay. Both
apps must be open and able to reach one another (normally on the same Wi-Fi).

The site remains Cloudflare Pages. Deploy this separate Worker with Wrangler
4.158.0 (or a reviewed compatible release), using the account pinned in the config:

```sh
pnpm dlx wrangler@4.158.0 deploy --config worker/wrangler.jsonc
```

For local development, run these in separate terminals:

```sh
pnpm dlx wrangler@4.158.0 dev --config worker/wrangler.jsonc --port 1481 --var ALLOWED_ORIGINS:http://localhost:1480
VITE_PAIRING_URL=ws://localhost:1481 pnpm dev --port 1480
YUKI_TEST_BASE=http://localhost:1480 pnpm test:sync-nearby
```

`GET /health` identifies the service. Production allows only the app origins;
connection attempts are limited per IP, and signaling size and rate are bounded
per socket. To verify against production signaling, leave `VITE_PAIRING_URL`
unset and use the production origin in a built-browser check. No cloud account
or provider OAuth client is needed for pairing.
