import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = { "Content-Type": "application/json" };
const response = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response(405, { error: "Method not allowed" });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const webhookSecret = Deno.env.get("SMOKEPAY_WEBHOOK_SECRET");
    if (!supabaseUrl || !serviceRoleKey || !webhookSecret) {
      return response(500, { error: "Webhook secrets are not configured" });
    }

    // Read exact bytes once: signature is over the provider's literal raw body.
    const rawBody = await req.text();
    const signatureHeader = req.headers.get("X-Webhook-Signature") ?? "";
    const eventName = req.headers.get("X-Webhook-Event") ?? "";
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(signatureHeader);
    if (!match) return response(401, { error: "Missing or malformed signature" });

    const timestamp = Number(match[1]);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300) {
      return response(401, { error: "Webhook timestamp outside tolerance" });
    }

    const expected = await hmacHex(webhookSecret, `${match[1]}.${rawBody}`);
    if (!constantTimeEqual(expected, match[2].toLowerCase())) {
      return response(401, { error: "Invalid webhook signature" });
    }

    const payload = JSON.parse(rawBody);
    if (eventName !== "payment.confirmed" || payload?.status !== "paid") {
      // Acknowledge valid but irrelevant events without changing order state.
      return response(200, { received: true, ignored: true });
    }

    const externalId = String(payload.external_id ?? "");
    const transactionId = String(payload.transaction_id ?? "");
    const amountNumber = Number(payload.amount);
    if (!externalId || !transactionId || !Number.isFinite(amountNumber) || amountNumber <= 0) {
      return response(400, { error: "Invalid payment payload" });
    }
    const amountCents = Math.round(amountNumber * 100);
    if (Math.abs(amountNumber * 100 - amountCents) > 0.000001) {
      return response(400, { error: "Invalid payment amount precision" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const eventKey = await sha256Hex(rawBody);
    const { data, error } = await supabase.rpc("process_smokepay_payment_event", {
      p_event_key: eventKey,
      p_event_name: eventName,
      p_external_id: externalId,
      p_transaction_id: transactionId,
      p_amount_cents: amountCents,
      p_paid_at: payload.paid_at ?? null,
      p_payload: payload,
    });
    if (error) {
      console.error("webhook processing failed", error);
      return response(500, { error: "Payment event could not be processed" });
    }

    return response(200, { received: true, result: data });
  } catch (error) {
    console.error("webhook failed", error);
    return response(500, { error: "Webhook processing failed" });
  }
});
