-- RAVENX Store / SmokePay
-- Orders are written by a trusted checkout/order-creation backend only.
-- Do not grant anon/authenticated direct INSERT/UPDATE access to these tables.

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  checkout_token_hash text not null,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'paid', 'expired', 'cancelled')),
  smokepay_external_id text unique,
  smokepay_transaction_id text,
  pix_copy_paste text,
  pix_qr_code_base64 text,
  pix_expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.smokepay_webhook_events (
  event_key text primary key,
  event_name text not null,
  external_id text,
  transaction_id text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

alter table public.store_orders enable row level security;
alter table public.smokepay_webhook_events enable row level security;

-- This RPC makes event deduplication and order payment update atomic.
create or replace function public.process_smokepay_payment_event(
  p_event_key text,
  p_event_name text,
  p_external_id text,
  p_transaction_id text,
  p_amount_cents bigint,
  p_paid_at timestamptz,
  p_payload jsonb
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.store_orders%rowtype;
begin
  insert into public.smokepay_webhook_events
    (event_key, event_name, external_id, transaction_id, payload)
  values
    (p_event_key, p_event_name, p_external_id, p_transaction_id, p_payload)
  on conflict (event_key) do nothing;

  if not found then
    return 'duplicate';
  end if;

  if p_event_name <> 'payment.confirmed' then
    return 'ignored';
  end if;

  select * into v_order
  from public.store_orders
  where smokepay_external_id = p_external_id
  for update;

  if not found then
    raise exception 'Order not found for external_id';
  end if;

  if v_order.amount_cents <> p_amount_cents then
    raise exception 'Payment amount mismatch';
  end if;

  if v_order.status = 'paid' then
    return 'already_paid';
  end if;

  update public.store_orders
  set status = 'paid',
      smokepay_transaction_id = p_transaction_id,
      paid_at = coalesce(p_paid_at, now()),
      updated_at = now()
  where id = v_order.id;

  return 'paid';
end;
$$;

revoke all on function public.process_smokepay_payment_event(text,text,text,text,bigint,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.process_smokepay_payment_event(text,text,text,text,bigint,timestamptz,jsonb) to service_role;
