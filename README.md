# PlusOne

**Live-stream selling where buyers talk like people, and every order still comes out right and paid with PayPal.**

Small sellers sell clothes, snacks and handmade things on live video. Their buyers don't type order forms. They type "+1", "the blue one from before, M", "change that to L, don't add another", "if no M forget it", in English, Malay, Chinese or Thai, all at once. Today the seller scrolls back through the chat after the live and rebuilds the orders by hand, and the buyers who said +1 and never paid keep items off sale.

PlusOne sits in the seller's own live page. It follows what is on screen and what each buyer said before, keeps one correct order per buyer, asks only when it really can't tell, and collects with PayPal. The host just sells.

![The buyer's live room: chat over the video, the price on a shelf label, and the buyer's parcel for the night with one item paid, one held, and one button to pay](docs/images/buyer-live.jpg)

## How it's different

Comment-selling tools are common: CommentSold and SoldLive in the US, SHOPLINE in Hong Kong and Taiwan, EasyStore and BigSeller in Southeast Asia. They turn comments into orders, hold carts, run waitlists and send invoices, and they work from a fixed format: a code such as `A1+1`, `CF A01` or `sold 12`, or at the simplest a bare "+1" for the one item in a flash sale (EasyStore). CommentSold can even buy a waitlisted item automatically once the buyer has pre-authorised it. The nearest anyone comes to reading free text is SHOPLINE labelling comments as purchase, question, positive or negative (it doesn't create orders) and SoldLive confirming the variant by text message after the comment.

**Others need buyers to follow a format. PlusOne follows the conversation the way a person does, while the live is happening:**

- "the blue one from before, M" is matched to the product the host showed earlier;
- "change to L, don't add another" edits the order in place;
- "if no M forget it" becomes a conditional order that never takes a different colour;
- "still got pink S?" gets an answer without taking stock;
- English, Malay, Chinese, Thai and Indonesian, mixed in one sentence, answered in the buyer's own language;
- and it asks one short question only when it really can't tell.

Holds, waitlists, per-person limits, reminders and invoices work the way sellers already expect from comment-selling tools; PlusOne runs them through PayPal.

## A messy chat, end to end

[`scripts/messy-chat.json`](scripts/messy-chat.json) is a made-up live sale, written the way buyers type: ten buyers, 22 messages in English, Malay, Chinese and Thai, over four products. Buyers point back ("the dress just now, sage S"), change their minds ("actually change my dress to L, don't add another"), cancel, set a condition ("blue M, if no M forget it"), split one order over two messages ("+1", then "white L"), ask questions and chat. Next to it is what a careful seller would write down for each buyer. [`scripts/messy-chat.mjs`](scripts/messy-chat.mjs) plays it through the real chat pipeline on a fresh demo shop and compares each buyer's parcel at the end.

| In the test chat | Result |
| --- | --- |
| Messages that place, change or cancel an order | 16 of 22 |
| ...written as a product code with a quantity (`A1+1`), or a bare "+1" for a one-option item | 1 |
| Parcels right at the end, three runs in a row | 10 of 10 each time |
| Questions PlusOne asked | 1 ("+1" with the blouse on screen and no colour or size yet) |
| Passed to the seller | 1 ("is the dress see-through?", which the shop's policies don't cover) |
| Average time to PlusOne's reply | about 3 seconds |

This is our own test chat, not data from real sellers. It shows the kind of chat PlusOne is built for; it doesn't measure how often real buyers write this way. Run it with `node --env-file=.env scripts/messy-chat.mjs` against a running API (it resets the demo shop and makes about 25 Claude calls).

## What you see

**Buyers** (`/live/lumicloset`)

- The live video with the chat over it and the price on a shelf label. The chat box suggests a line to try for what's on screen.
- A name is all it takes to join; PayPal brings the email and address at checkout.
- One parcel for the whole live, drawn as the shipping label it will become: everything they've said +1 to, with a colour swatch per item. Paid items are marked PAID; what's still held adds up at the bottom with the time left and one button to pay. Once everything is paid the label gets its barcode; once it's shipped, the carrier and tracking number.
- Private replies from PlusOne in their own language: "Blue M is yours, held for 15 min", "sold out, you're next in line", "freed up, it's yours now".
- **Saved PayPal and auto-pay.** At the first checkout the buyer can save their PayPal with the shop (PayPal asks them to agree). After that, the next order is one tap with no PayPal window. Or they turn on auto-pay for this live, up to $50, $100 or $200: then "+1 the rattan bag" is paid within that limit. The parcel counts down 15 seconds after the order last changed, so "and the scarf too" joins the same payment; while PlusOne is asking them something, auto-pay waits for the answer. Items handed over from the waitlist are never paid automatically.

**The seller** (`/seller`)

- Tonight's orders as three manifests on the packing table, one line per order: waiting to pay (time left, Remind), paid and ready to pack (Ship), sent (tracking number). People waiting in line sit under the first. The chat opens beside them only when the seller wants to read it.
- The few things only the seller can decide, on red packing tape across the top, such as a refund request with a one-tap refund through PayPal.
- Cards from what the host says ("dress and blouse together, five dollars off"); one tap applies them, and buyers holding the dress are offered the blouse.
- **Let PlusOne watch**: with the camera on, the host holds a product up and it goes on screen for buyers, so their "+1" means what they can see. No tapping mid-sale.
- Ship with a tracking number; End live sends the PayPal invoices and writes the night's recap.
- **Ask PlusOne**, a bar at the bottom of the table: type or say "Hey PlusOne, who still owes?" and it looks through tonight's orders and the shop's PayPal account (PayPal Agent Toolkit). Anything that moves money or messages buyers comes back as a card to approve: remind them in chat, send PayPal invoice reminders, refund a line, ship with a tracking number. It can also put a product on screen or make a pay QR code for an invoice.
- A report (AG Studio) with an AI assistant that answers "why is blue M sold out?" and can remind everyone who still owes.

![The seller's packing table: a question only the seller can answer, tonight's orders as three manifests, and Ask PlusOne lining up chat reminders for approval](docs/images/seller-book.jpg)

## PayPal

| What happens | PayPal API |
| --- | --- |
| Buyer pays from their parcel | Orders v2 (`intent=CAPTURE`) through the JS SDK v6 button; server creates and captures with the [PayPal Server SDK](https://github.com/paypal/PayPal-TypeScript-Server-SDK) |
| Stock is only locked when the money is in | Webhooks (`PAYMENT.CAPTURE.COMPLETED` and related events), signature-verified; the webhook is created and kept pointed at the server automatically |
| Buyer cancels a paid item | Refunds (partial, one line of a combined order) |
| Seller ships | Shipment Tracking on the capture, buyer notified by PayPal |
| Live ends with unpaid holds | Invoicing v2: an invoice per buyer, items held until it's due, cancelled if it runs out |
| Bundle deals, combined postage | Discount and shipping in the order breakdown |
| Buyer saves PayPal at checkout | Orders v2 with `payment_source.paypal.attributes.vault` (`store_in_vault: ON_SUCCESS`, merchant usage); the vault id and customer id come back on capture |
| One-tap pay, auto-pay | Orders v2 with `payment_source.paypal.vault_id`, completed in one call, shipped to the address from the saving checkout |
| Buyer forgets their saved PayPal | Payment Method Tokens `DELETE /v3/vault/payment-tokens/{id}` |
| Ask PlusOne | [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit): orders, invoices (list, search, get, QR code, send reminder, cancel), refunds, shipment tracking, disputes |

Every call that moves money carries a `PayPal-Request-Id`, and a saved-PayPal charge is written down before it is sent, so a retry doesn't charge twice. A PayPal window opened before the buyer changed their order doesn't capture; refunds give back each item's share of what was paid, never more than the payment.

## Agents that spend, with limits

Two agents in PlusOne move money, and each one has a limit someone chose.

- **The buyer's**: auto-pay. The buyer saves their PayPal, picks a limit for one live, and from then on what they order in chat is paid within that limit. Every change restarts a short countdown on their parcel; an open question from PlusOne, or a message still being read, holds it; the limit is checked again at the moment of payment; a declined payment turns auto-pay off instead of retrying. Nothing from the waitlist and no "if no M, forget it" is ever bought on their behalf. Changed their mind? They say so in chat and the seller refunds that item through PayPal, its share of what was paid.
- **The seller's**: Ask PlusOne. It reads freely: tonight's orders, stock, waitlists, and the shop's PayPal invoices, refunds, tracking and disputes through PayPal's Agent Toolkit. It doesn't send anything by itself. Reminders, invoice reminders, cancellations, refunds and shipping come back as cards the seller approves, one by one or all at once.

![Auto-pay counting down on the buyer's parcel: the held bag pays itself with the saved PayPal](docs/images/autopay.jpg)

![Ask PlusOne: PayPal invoice reminders queued as cards and sent through PayPal's Agent Toolkit after the seller approved them](docs/images/ask-plusone.jpg)

## AI

Claude (Opus 5.5) does the understanding; code does the money.

- **Chat**: each buyer message is read with what's on screen, what was shown before, the buyer's open order, waitlists, deals, the shop's policies and what the host said in the last minute. The result is a structured action (buy, change, cancel, question, waitlist...) that the server applies in the order messages arrived. Prices, stock and holds are never decided by the model.
- **Host speech**: the host's voice (Deepgram, streamed through the server) becomes cards for new products, prices, bundles and limits. Nothing changes until the host taps Apply.
- **Host camera**: every two seconds or so the console sends a small frame from the host's camera; Claude names the catalog product being shown, or none. The product goes on screen only when two frames in a row agree. Frames aren't stored.
- **After the live**: Claude reads the night's orders, stock and chat and leaves the seller a short to-do list.
- **Ask PlusOne**: Claude with tool use over tonight's orders and the PayPal Agent Toolkit's tools; the host can also ask it out loud ("Hey PlusOne, ...") while selling.
- **Report assistant**: AG Studio's agents run on Claude through the server, with one extra tool that sends payment reminders.
- Evals in `apps/api/src/ai/*.eval.ts` (25 chat cases, 8 host-speech cases) cover what the demo and judges will try, including Malay, Chinese, Thai, Indonesian and Singlish.

![After the live: the recap at the top of the seller's table, and every unpaid order invoiced through PayPal](docs/images/after-live.jpg)

## Render Workflows

Work that happens around a live, not in the middle of it, runs as Render Workflows tasks (`apps/api/src/jobs/tasks.ts`):

- `closeOutLive`: when the host ends the live, one `invoiceBuyer` run per buyer who still owes, in parallel, each retrying on its own; then `writeRecap`.
- `remindToPay`: a few minutes before a hold runs out, nudges the buyer in their language, unless they paid or the hold changed.

Tasks only touch Postgres and PayPal; their live updates reach browsers through a Postgres `NOTIFY` channel the web server listens on. Without `RENDER_API_KEY` (local dev) the same functions run inside the API process.

## AG Studio

The Report tab is an AG Studio 3 page on the same kraft table: takings, money still held, units by product, stock with held and waiting counts, and every order line with custom cells (held in yellow, PAID in black, struck-through cancellations, clickable PayPal capture ids). It updates live. Its AI assistant runs AG Studio's built-in agents on Claude plus a `send_payment_reminder` tool.

![The report with its AI assistant sending reminders](docs/images/report-ai.jpg)

## APIMatic

The PayPal code was written with the APIMatic Context Plugin for Claude Code (PayPal Server SDK skills). Where it changed the code:

- `apps/api/src/paypal/client.ts`: the SDK has no timeout and no retries by default; the client sets both, and POSTs retry only when they carry a request id.
- `describePayPalError` in the same file: reads the typed `result` versus the raw `body` the way the SDK reports them, keeping PayPal's own field names (`debug_id`).
- `apps/api/src/paypal/payments.ts`: create, capture, get and refund follow the SDK's calling conventions (one named-parameter object, SDK enums), each with a request id.
- Saving PayPal (`payments.ts`): reading the SDK's vault model showed `permitMultiplePaymentTokens`, meant for customers who don't log in to the merchant. PlusOne's buyers never do, and on the demo every judge uses the same sandbox PayPal account, so without it they all shared one token and one buyer's "Forget it" broke everyone else's one-tap. Each buyer now gets their own token, and the vault `description` tells the buyer on PayPal's page which shop they're saving for.
- Errors (`client.ts`): the error-handling guidance showed that the payload can arrive only as the raw `body`; it is parsed now, and a saved PayPal that PayPal no longer accepts is dropped with a plain message instead of PayPal's JSON reaching the buyer.

## Architecture

![PlusOne architecture: buyer and seller browsers, the web service, Postgres and Render Workflows on Render, and PayPal, Claude, LiveKit and Deepgram](docs/images/architecture.png)

Source: [`docs/architecture.drawio`](docs/architecture.drawio) (draw.io).

```text
apps/api        Fastify + Socket.IO server: chat understanding, orders and stock, PayPal, background tasks
apps/web        React live page for buyers (/live/:handle) and the seller console (/seller)
packages/shared Types shared by both
scripts         Dev tunnel, end-to-end PayPal run, a crowd of demo buyers
```

## Try it

**Live demo: <https://plusone-sjgp.onrender.com>** (buyers at `/live/lumicloset`, the seller console at `/seller`).

The demo seller is Lumi Closet, selling a linen and batik drop. On the hosted demo the seller login shows its password and each buyer's parcel shows a PayPal sandbox buyer to log in with. No real money moves. Pay once with "Save my PayPal" ticked and the next order is one tap; turn on auto-pay on your parcel and just say "+1". With nobody hosting, a recorded host plays: she shows the linen wrap dress, then the rattan bag, and the price label follows what she holds up, so you can say "+1" for the bag and then "the dress just now, blue S". The chat box always suggests a line for what's on screen. Alone in the shop? In the seller console's Demo menu, **Play a busy minute** sends ten buyers through the same chat pipeline real buyers use: mixed languages, a change of size, a cancellation, a question only the seller can answer, a race for the last one. The shop resets itself after half an hour of quiet.

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

PayPal only delivers webhooks over public HTTPS. With [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed, `pnpm dev:public` runs the API behind a quick tunnel and points the PayPal webhook at it; run `pnpm dev:web` alongside.

With the live page and the console open, `node --env-file=.env scripts/demo-crowd.mjs <scene>` plays a few buyers chatting the way they do in a real live: `switch`, `last-one`, `deal`, `languages`, `close-out` (add `--reset` for a fresh shop). `pnpm e2e:pay` clicks through a real sandbox payment and refund.

Tests: `pnpm test` (needs a `plusone_test` database: `docker exec plusone-db psql -U plusone -c "CREATE DATABASE plusone_test"`). AI evals: `pnpm --filter @plusone/api eval`.

## Deploy

`render.yaml` is a Render Blueprint: the web service (API, Socket.IO and the built web app), the workflow service and Postgres, all in Singapore. Secrets are entered in the Render dashboard when the Blueprint is created.

## Limits

- One demo seller and one live at a time; the live page is the seller's own, not TikTok or Facebook.
- PayPal sandbox only, in USD.
- The host in the hosted demo's replay is AI-generated video (made with Seedance 2.5), and the buyers in "Play a busy minute" are simulated. Every order, payment, refund and invoice is a real PayPal Sandbox call.
- The AI asks when it can't tell, but it can still misread; every change it makes shows up on the seller's labels and the buyer's own label, and buyers can correct it in chat.

## License

MIT. Third-party components keep their own licenses.
