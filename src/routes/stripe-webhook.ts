import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Map Stripe amounts (in cents) to credit packages.
 * Keep in sync with the subscription prices in Stripe Dashboard.
 */
const AMOUNT_TO_CREDITS: Record<number, { credits: number; plan: string }> = {
  1100: { credits: 100, plan: 'Starter' },
  3900: { credits: 500, plan: 'Kreator' },
  9500: { credits: 1500, plan: 'Agency' },
};

function getCreditsForAmount(amountCents: number): { credits: number; plan: string } | null {
  return AMOUNT_TO_CREDITS[amountCents] ?? null;
}

/**
 * List price in cents for the first subscription item. Requires
 * `stripe.subscriptions.retrieve(..., { expand: ['items.data.price'] })` so
 * `price` is a Price object, not an id. Coupons do not change this; they only
 * change amount_total / amount_paid.
 */
function getListUnitAmountCentsFromSubscription(
  sub: Stripe.Subscription
): number | null {
  const first = sub.items.data[0];
  const p = first?.price;
  if (p == null) return null;
  if (typeof p === 'string') return null;
  if ('deleted' in p && p.deleted) return null;
  return p.unit_amount ?? null;
}

/** Resolves which subscription a renewal invoice belongs to (Stripe v21+ uses `parent`, not a top-level field). */
function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const p = invoice.parent;
  if (p?.type === 'subscription_details' && p.subscription_details) {
    const s = p.subscription_details.subscription;
    if (s) {
      return typeof s === 'string' ? s : s.id;
    }
  }
  const line0 = invoice.lines?.data[0];
  if (line0?.subscription) {
    const s = line0.subscription;
    return typeof s === 'string' ? s : s.id;
  }
  return null;
}

async function getUserByCustomerId(supabase: SupabaseClient, customerId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Handle checkout.session.completed — initial subscription purchase.
 * Uses client_reference_id to link the Stripe customer to our user.
 */
async function handleCheckoutCompleted(
  stripe: Stripe,
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session
): Promise<void> {
  const userId = session.client_reference_id;
  const sessionId = session.id;
  const amountTotal = session.amount_total;
  const currency = session.currency ?? 'usd';

  if (!userId) {
    console.error('[stripe] No client_reference_id on session', sessionId);
    return;
  }

  const customerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id;

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;

  // Save Stripe customer + subscription info on the user's profile
  const profileUpdate: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (customerId) profileUpdate.stripe_customer_id = customerId;
  if (subscriptionId) profileUpdate.stripe_subscription_id = subscriptionId;

  // Fetch subscription to get plan (from list price) and period end
  let planName: string | null = null;
  let packFromListPrice: { credits: number; plan: string } | null = null;
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      });
      profileUpdate.subscription_status = sub.status;
      const periodEnd = sub.items.data[0]?.current_period_end;
      if (periodEnd) {
        profileUpdate.subscription_current_period_end = new Date(periodEnd * 1000).toISOString();
      }

      const listCents = getListUnitAmountCentsFromSubscription(sub);
      if (listCents != null) {
        const pack = getCreditsForAmount(listCents);
        if (pack) {
          planName = pack.plan;
          profileUpdate.subscription_plan = pack.plan.toLowerCase();
          packFromListPrice = pack;
        }
      }
    } catch (err) {
      console.warn('[stripe] Failed to fetch subscription details:', err);
      profileUpdate.subscription_status = 'active';
    }
  } else {
    profileUpdate.subscription_status = 'active';
  }

  const { error: updateErr } = await supabase
    .from('profiles')
    .update(profileUpdate)
    .eq('id', userId);

  if (updateErr) {
    console.error('[stripe] Failed to update profile with subscription:', updateErr);
  }

  // Add credits: use list price from the subscription (ignores % coupons). Fallback to amount_total
  // for one-time checkouts that match a map key exactly.
  const pack = packFromListPrice
    ?? (amountTotal && amountTotal > 0 ? getCreditsForAmount(amountTotal) : null);
  if (!pack) {
    console.error(
      '[stripe] Could not map plan/credits for checkout. Session:',
      sessionId,
      'amount_total:',
      amountTotal
    );
    return;
  }

  const { data: existing } = await supabase
    .from('credit_purchases')
    .select('id')
    .eq('stripe_session_id', sessionId)
    .maybeSingle();

  if (existing) {
    console.log('[stripe] Already processed session', sessionId);
    return;
  }

  const { data: newBalance, error: addErr } = await supabase
    .rpc('add_credits', { p_user_id: userId, p_amount: pack.credits });

  if (addErr) {
    console.error('[stripe] add_credits failed:', addErr);
    return;
  }

  const { error: logErr } = await supabase
    .rpc('log_credit_purchase', {
      p_user_id: userId,
      p_credits: pack.credits,
      p_amount_cents: amountTotal ?? 0,
      p_currency: currency,
      p_stripe_session_id: sessionId,
      p_plan_name: planName ?? pack.plan,
    });

  if (logErr) {
    console.warn('[stripe] log_credit_purchase failed (credits were added):', logErr);
  }

  console.log(
    `[stripe] ✓ Checkout ${pack.plan}: +${pack.credits} credits for user ${userId} (balance: ${newBalance}). Session: ${sessionId}`
  );
}

/**
 * Handle invoice.payment_succeeded — monthly renewal credit top-up.
 * Skips the first invoice (already handled by checkout).
 */
async function handleInvoiceSucceeded(
  stripe: Stripe,
  supabase: SupabaseClient,
  invoice: Stripe.Invoice
): Promise<void> {
  if (invoice.billing_reason === 'subscription_create') {
    console.log('[stripe] Skipping first invoice (handled by checkout):', invoice.id);
    return;
  }

  // Prorated invoices from plan changes are handled by subscription.updated
  if (invoice.billing_reason === 'subscription_update') {
    console.log('[stripe] Skipping prorated invoice (handled by subscription.updated):', invoice.id);
    return;
  }

  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id;

  if (!customerId) {
    console.error('[stripe] No customer on invoice', invoice.id);
    return;
  }

  const userId = await getUserByCustomerId(supabase, customerId);
  if (!userId) {
    console.error('[stripe] No user found for customer', customerId, 'invoice', invoice.id);
    return;
  }

  const amountPaid = invoice.amount_paid;
  const currency = invoice.currency ?? 'usd';

  const subscriptionId = getSubscriptionIdFromInvoice(invoice);

  let pack: { credits: number; plan: string } | null = null;
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      });
      const listCents = getListUnitAmountCentsFromSubscription(sub);
      if (listCents != null) {
        pack = getCreditsForAmount(listCents);
      }
    } catch (err) {
      console.warn('[stripe] Failed to fetch subscription for renewal credits:', err);
    }
  }
  if (!pack && amountPaid && amountPaid > 0) {
    pack = getCreditsForAmount(amountPaid);
  }
  if (!pack) {
    console.error(
      '[stripe] Could not map renewal plan/credits. Invoice:',
      invoice.id,
      'amount_paid:',
      amountPaid,
      'subscription:',
      subscriptionId
    );
    return;
  }

  if (!amountPaid || amountPaid <= 0) {
    console.warn(
      '[stripe] Zero amount_paid on invoice; granting credits from list price. Invoice:',
      invoice.id
    );
  }

  // Idempotency: use invoice ID as session ID for dedup
  const dedup = `inv_${invoice.id}`;
  const { data: existing } = await supabase
    .from('credit_purchases')
    .select('id')
    .eq('stripe_session_id', dedup)
    .maybeSingle();

  if (existing) {
    console.log('[stripe] Already processed invoice', invoice.id);
    return;
  }

  const { data: newBalance, error: addErr } = await supabase
    .rpc('add_credits', { p_user_id: userId, p_amount: pack.credits });

  if (addErr) {
    console.error('[stripe] add_credits failed for renewal:', addErr);
    return;
  }

  const { error: logErr } = await supabase
    .rpc('log_credit_purchase', {
      p_user_id: userId,
      p_credits: pack.credits,
      p_amount_cents: amountPaid ?? 0,
      p_currency: currency,
      p_stripe_session_id: dedup,
      p_plan_name: `${pack.plan} (renewal)`,
    });

  if (logErr) {
    console.warn('[stripe] log_credit_purchase failed for renewal:', logErr);
  }

  console.log(
    `[stripe] ✓ Renewal ${pack.plan}: +${pack.credits} credits for user ${userId} (balance: ${newBalance}). Invoice: ${invoice.id}`
  );
}

/**
 * Handle customer.subscription.updated — status/plan changes.
 * When the plan changes (upgrade/downgrade), grant the credit difference for upgrades.
 */
async function handleSubscriptionUpdated(
  stripe: Stripe,
  supabase: SupabaseClient,
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;

  if (!customerId) return;

  const userId = await getUserByCustomerId(supabase, customerId);
  if (!userId) {
    console.error('[stripe] No user for customer', customerId, 'sub', subscription.id);
    return;
  }

  let newPack: { credits: number; plan: string } | null = null;
  try {
    const full = await stripe.subscriptions.retrieve(subscription.id, {
      expand: ['items.data.price'],
    });
    const listCents = getListUnitAmountCentsFromSubscription(full);
    if (listCents != null) {
      newPack = getCreditsForAmount(listCents);
    }
  } catch (err) {
    console.warn('[stripe] Could not re-fetch subscription for plan change:', err);
  }
  if (!newPack) {
    const amountCents = subscription.items.data[0]?.price
      && typeof subscription.items.data[0].price === 'object' &&
        !('deleted' in subscription.items.data[0].price)
      ? (subscription.items.data[0].price as Stripe.Price).unit_amount
      : null;
    if (amountCents != null) {
      newPack = getCreditsForAmount(amountCents);
    }
  }

  // Fetch current plan to detect changes
  const { data: currentProfile } = await supabase
    .from('profiles')
    .select('subscription_plan')
    .eq('id', userId)
    .maybeSingle();

  const oldPlanId = currentProfile?.subscription_plan;
  const newPlanId = newPack?.plan.toLowerCase() ?? null;
  const planChanged = newPlanId && oldPlanId && newPlanId !== oldPlanId;

  const periodEnd = subscription.items.data[0]?.current_period_end;
  const updatePayload: Record<string, unknown> = {
    subscription_status: subscription.status,
    stripe_subscription_id: subscription.id,
    updated_at: new Date().toISOString(),
  };
  if (periodEnd) {
    updatePayload.subscription_current_period_end = new Date(periodEnd * 1000).toISOString();
  }
  if (newPack) {
    updatePayload.subscription_plan = newPack.plan.toLowerCase();
  }

  const { error } = await supabase
    .from('profiles')
    .update(updatePayload)
    .eq('id', userId);

  if (error) {
    console.error('[stripe] Failed to update subscription status:', error);
    return;
  }

  // On upgrade, grant the difference in credits immediately
  if (planChanged && newPack) {
    const oldPack = Object.values(AMOUNT_TO_CREDITS).find(
      (p) => p.plan.toLowerCase() === oldPlanId
    );
    const oldCredits = oldPack?.credits ?? 0;
    const creditDiff = newPack.credits - oldCredits;

    if (creditDiff > 0) {
      const dedup = `plan_change_${subscription.id}_${Date.now()}`;
      const { data: newBalance, error: addErr } = await supabase
        .rpc('add_credits', { p_user_id: userId, p_amount: creditDiff });

      if (addErr) {
        console.error('[stripe] add_credits failed for plan upgrade:', addErr);
      } else {
        await supabase.rpc('log_credit_purchase', {
          p_user_id: userId,
          p_credits: creditDiff,
          p_amount_cents: 0,
          p_currency: 'usd',
          p_stripe_session_id: dedup,
          p_plan_name: `Upgrade to ${newPack.plan}`,
        });
        console.log(
          `[stripe] ✓ Plan upgrade ${oldPlanId} → ${newPlanId}: +${creditDiff} credits for user ${userId} (balance: ${newBalance})`
        );
      }
    } else {
      console.log(`[stripe] Plan downgrade ${oldPlanId} → ${newPlanId} for user ${userId}. No extra credits.`);
    }
  } else {
    console.log(`[stripe] ✓ Subscription updated for user ${userId}: status=${subscription.status}`);
  }
}

/**
 * Handle customer.subscription.deleted — cancellation.
 * Credits remain untouched; user can spend them until 0.
 */
async function handleSubscriptionDeleted(
  supabase: SupabaseClient,
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;

  if (!customerId) return;

  const userId = await getUserByCustomerId(supabase, customerId);
  if (!userId) {
    console.error('[stripe] No user for customer', customerId, 'sub', subscription.id);
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      subscription_status: 'cancelled',
      stripe_subscription_id: null,
      subscription_plan: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) {
    console.error('[stripe] Failed to mark subscription cancelled:', error);
  } else {
    console.log(`[stripe] ✓ Subscription cancelled for user ${userId}. Credits kept.`);
  }
}

/**
 * POST /api/stripe/webhook
 * Handles subscription lifecycle events from Stripe.
 */
export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe] Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    res.status(500).json({ error: 'Stripe not configured' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[stripe] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    res.status(500).json({ error: 'Supabase not configured' });
    return;
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'] as string | undefined;
  if (!sig) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] Signature verification failed:', err);
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(stripe, supabase, session);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoiceSucceeded(stripe, supabase, invoice);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(stripe, supabase, subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(supabase, subscription);
        break;
      }

      default:
        console.log('[stripe] Unhandled event type:', event.type);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe] Processing error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
}
