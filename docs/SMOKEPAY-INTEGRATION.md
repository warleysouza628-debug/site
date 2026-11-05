# SmokePay integration — RAVENX Store

This branch contains the backend foundation only. It does **not** change the live GitHub Pages storefront and does **not** make the store ready to accept real payments yet.

## What is included

- Supabase Edge Function `create-pix`: creates a PIX charge using a server-side SmokePay key and a fixed order amount stored in the database.
- Supabase Edge Function `smokepay-webhook`: validates the provider's HMAC-SHA256 signature over the exact raw request body, enforces a 5-minute timestamp tolerance, and processes payment events idempotently.
- Database migration for orders and webhook event deduplication.
- No SmokePay key or webhook secret is committed to Git.

## Required secrets

Set these in Supabase Edge Function secrets, never in GitHub Pages or browser JavaScript:

- `SMOKEPAY_API_KEY`
- `SMOKEPAY_WEBHOOK_SECRET`
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (normally injected by Supabase)

Optional:
- `STORE_ORIGIN` — exact storefront origin for CORS. Default allows the GitHub Pages origin.

The previously pasted API key must be revoked and replaced because it was exposed in chat. Do not paste the replacement into source code or chat.

## Important checkout contract

The current storefront is a static GitHub Pages site. Its cart and product prices live in the browser. A browser must never be allowed to choose the amount charged.

Before enabling this endpoint, a trusted order-creation flow must:
1. Read product prices from a trusted server-side catalog/database (not from browser-supplied prices).
2. Calculate the total in integer cents.
3. Generate a cryptographically random checkout token (at least 24 characters), store only its SHA-256 hash in `store_orders.checkout_token_hash`, and return the token to the buyer once.
4. Insert the order with `status = 'pending_payment'` and the trusted `amount_cents`.
5. The browser calls `create-pix` with `order_id` and `checkout_token`.

The current static product catalog has not yet been migrated into a trusted database catalog. Therefore this branch deliberately does not expose an insecure endpoint that accepts an amount from the browser.

## Deploy sequence (not yet performed)

1. Link the correct Supabase project.
2. Review and apply `supabase/migrations/20261105210000_smokepay_orders.sql`.
3. Set secrets listed above.
4. Deploy `create-pix` and `smokepay-webhook`.
5. Configure the SmokePay webhook URL as `https://<project-ref>.supabase.co/functions/v1/smokepay-webhook`.
6. Implement the trusted order-creation flow and connect the storefront UI to it.
7. Test pending, paid, expired, duplicate webhook, bad signature, amount mismatch, API timeout, and provider 429/5xx cases using SmokePay sandbox/test mode if available.

## Current limitations

- The GitHub Pages UI has not been changed.
- No Supabase project has been linked or deployed from this repository.
- No real charge has been created or verified.
- Do not advertise PIX checkout as operational until the end-to-end tests pass.
- The implementation assumes SmokePay's documented signature format `t=<unix>,v1=<hex>` and payload fields `external_id`, `transaction_id`, `amount`, `status`, and `paid_at`. Confirm the exact live webhook payload with a test event before production.
