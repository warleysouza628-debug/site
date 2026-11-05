import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("STORE_ORIGIN") ?? "https://warleysouza628-debug.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function smokepayRequest(path: string, apiKey: string, init?: RequestInit) {
  const url = `https://smokepay.com.br${path}`;
  let lastError: unknown;

  // Retry only transient errors. Reuse the exact same external_id and payload.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });

      if (response.ok) return await response.json();

      const detail = await response.text();
      if (response.status === 409) {
        // The provider documents lookup by external_id; this safely reconciles
        // a create request whose response was lost after the provider accepted it.
        const lookup = await fetch(`${url.replace(/\/api\/pix\/create$/, "")}/api/pix/${encodeURIComponent(
          (JSON.parse(String(init?.body ?? "{}")) as { external_id?: string }).external_id ?? "",
        )}`, { headers: { "x-api-key": apiKey } });
        if (lookup.ok) return await lookup.json();
        throw new Error(`SmokePay conflict; lookup failed: ${await lookup.text()}`);
      }

      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Error(`SmokePay HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }
      lastError = new Error(`SmokePay HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }
    await sleep(Math.min(8000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250));
  }
  throw lastError instanceof Error ? lastError : new Error("SmokePay request failed");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = Deno.env.get("SMOKEPAY_API_KEY");
    if (!supabaseUrl || !serviceRoleKey || !apiKey) {
      return json(500, { error: "Backend secrets are not configured" });
    }

    const body = await req.json();
    const orderId = typeof body.order_id === "string" ? body.order_id : "";
    const checkoutToken = typeof body.checkout_token === "string" ? body.checkout_token : "";
    if (!orderId || !checkoutToken || checkoutToken.length < 24) {
      return json(400, { error: "Invalid checkout request" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: order, error: orderError } = await supabase
      .from("store_orders")
      .select("id, checkout_token_hash, amount_cents, status, smokepay_external_id, pix_copy_paste, pix_qr_code_base64, pix_expires_at")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!order) return json(404, { error: "Order not found" });
    if (await sha256Hex(checkoutToken) !== order.checkout_token_hash) {
      return json(403, { error: "Invalid checkout token" });
    }
    if (order.status === "paid") return json(409, { error: "Order already paid" });
    if (order.status !== "pending_payment") return json(409, { error: "Order is not payable" });

    const externalId = order.smokepay_external_id ?? `ravenx-${order.id}`;
    if (!order.smokepay_external_id) {
      const { error } = await supabase.from("store_orders")
        .update({ smokepay_external_id: externalId, updated_at: new Date().toISOString() })
        .eq("id", order.id)
        .is("smokepay_external_id", null);
      if (error) throw error;
    }

    const amount = Number((BigInt(order.amount_cents) / 100n).toString()) +
      Number((BigInt(order.amount_cents) % 100n).toString()) / 100;

    const payment = await smokepayRequest("/api/pix/create", apiKey, {
      method: "POST",
      body: JSON.stringify({
        amount,
        description: `Pedido RAVENX ${order.id}`,
        external_id: externalId,
        webhook_url: `${supabaseUrl}/functions/v1/smokepay-webhook`,
        expiration: 1800,
      }),
    });

    const transaction = payment?.transaction ?? payment;
    if (!transaction?.id || !transaction?.pix_copia_cola) {
      throw new Error("Unexpected SmokePay response: required PIX fields are missing");
    }

    const { error: saveError } = await supabase.from("store_orders").update({
      smokepay_transaction_id: String(transaction.id),
      pix_copy_paste: transaction.pix_copia_cola,
      pix_qr_code_base64: transaction.qr_code_base64 ?? null,
      pix_expires_at: transaction.expires_at ?? null,
      updated_at: new Date().toISOString(),
    }).eq("id", order.id);
    if (saveError) throw saveError;

    return json(200, {
      order_id: order.id,
      status: transaction.status ?? "pending",
      pix_copia_cola: transaction.pix_copia_cola,
      qr_code_base64: transaction.qr_code_base64 ?? null,
      expires_at: transaction.expires_at ?? null,
    });
  } catch (error) {
    console.error("create-pix failed", error);
    return json(502, { error: "Could not create PIX payment. Please retry the same order." });
  }
});
