# PlusOne

AI sales assistant for live-stream sellers. Buyers talk the way people actually talk in a live chat ("+1", "the blue one from before, size M", "change that to L, don't add another"); PlusOne keeps every order right, asks only when it has to, and collects with PayPal.

Work in progress. Built for the PayPal AI Hackathon.

## Layout

```text
apps/api        Fastify + Socket.IO server: chat understanding (Claude), orders and stock (Postgres), PayPal
apps/web        React live page for buyers (/live/:handle) and the seller console (/seller)
packages/shared Types shared by both
```

## Run locally

Needs Node 22+, pnpm 9, Docker.

```bash
pnpm install
cp .env.example .env     # fill in keys
pnpm db:up               # Postgres in Docker
pnpm --filter @plusone/api db:seed   # demo seller, 8 products, one live session
pnpm dev                 # api on :3000, web on :5174
```

Open <http://localhost:5174> for the live page and <http://localhost:5174/seller> for the console (password is `SELLER_PASSWORD`).

### PayPal webhooks in development

PayPal only delivers webhooks over public HTTPS. With [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed, run the API through a quick tunnel instead of `pnpm dev:api`:

```bash
pnpm dev:public          # tunnel + API; the API points the PayPal webhook at the tunnel on boot
pnpm dev:web
```

There is no webhook to create by hand: on boot the API finds or creates this app's webhook and updates its URL.

### A crowd to sell to

With the live page and the seller console open, `node --env-file=.env scripts/demo-crowd.mjs <scene>` plays a few buyers chatting the way they do in a real live: `switch`, `last-one`, `deal`, `languages`, `close-out` (add `--reset` for a fresh shop).

### Background tasks

Work that happens around a live rather than in the middle of it runs as [Render Workflows](https://render.com/docs/workflows) tasks (`apps/api/src/jobs/tasks.ts`):

- `closeOutLive`: when the host ends the live, one `invoiceBuyer` run per buyer who still owes (a PayPal invoice by email; each retries on its own), then `writeRecap`, where Claude reads the night's orders, stock and chat and leaves the seller a short note in their order book.
- `remindToPay`: a few minutes before a hold runs out, nudges the buyer in their own language, unless they paid or the hold changed.

Tasks only touch Postgres and PayPal. Their live updates reach browsers through a Postgres `NOTIFY` channel the web server listens on. Without `RENDER_API_KEY` (local dev) the same functions run inside the API process.

### Tests

```bash
docker exec plusone-db psql -U plusone -c "CREATE DATABASE plusone_test"   # once
pnpm test
```

## Deploy

`render.yaml` is a Render Blueprint: the web service (API, Socket.IO and the built web app), the workflow service and Postgres, all in Singapore. Secrets are entered in the Render dashboard when the Blueprint is created.

## License

MIT. Third-party components keep their own licenses.
