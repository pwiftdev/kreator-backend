import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Map Stripe Payment Link amounts (in cents) to credit packages.
 * Update these if you change your Payment Link prices.
 */
const AMOUNT_TO_CREDITS: Record<number, { credits: number; plan: string }> = {
  1900: { credits: 200, plan: 'Starter' },
  3500: { credits: 400, plan: 'Kreator' },
  8500: { credits: 1000, plan: 'Agency' },
};

function getCreditsForAmount(amountCents: number): { credits: number; plan: string } | null {
  return AMOUNT_TO_CREDITS[amountCents] ?? null;
}

/**
 * POST /api/stripe/webhook
 * Stripe sends checkout.session.completed events here after Payment Link purchase.
 * We verify the signature, extract user ID from client_reference_id, and add credits.
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
    // req.body must be the raw buffer for signature verification
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] Signature verification failed:', err);
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    // Acknowledge other events without processing
    res.status(200).json({ received: true });
    return;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const userId = session.client_reference_id;
  const amountTotal = session.amount_total;
  const currency = session.currency ?? 'usd';
  const sessionId = session.id;

  if (!userId) {
    console.error('[stripe] No client_reference_id on session', sessionId);
    res.status(400).json({ error: 'No user ID in session' });
    return;
  }

  if (!amountTotal || amountTotal <= 0) {
    console.error('[stripe] Invalid amount_total', amountTotal, 'session', sessionId);
    res.status(400).json({ error: 'Invalid amount' });
    return;
  }

  const pack = getCreditsForAmount(amountTotal);
  if (!pack) {
    console.error('[stripe] Unknown amount:', amountTotal, 'cents. Session:', sessionId);
    res.status(400).json({ error: `Unknown payment amount: ${amountTotal}` });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Idempotency: check if we already processed this session
    const { data: existing } = await supabase
      .from('credit_purchases')
      .select('id')
      .eq('stripe_session_id', sessionId)
      .maybeSingle();

    if (existing) {
      console.log('[stripe] Already processed session', sessionId);
      res.status(200).json({ received: true, already_processed: true });
      return;
    }

    // Add credits
    const { data: newBalance, error: addErr } = await supabase
      .rpc('add_credits', { p_user_id: userId, p_amount: pack.credits });

    if (addErr) {
      console.error('[stripe] add_credits failed:', addErr);
      res.status(500).json({ error: 'Failed to add credits' });
      return;
    }

    // Log the purchase
    const { error: logErr } = await supabase
      .rpc('log_credit_purchase', {
        p_user_id: userId,
        p_credits: pack.credits,
        p_amount_cents: amountTotal,
        p_currency: currency,
        p_stripe_session_id: sessionId,
        p_plan_name: pack.plan,
      });

    if (logErr) {
      console.warn('[stripe] log_credit_purchase failed (credits were added):', logErr);
    }

    console.log(
      `[stripe] ✓ ${pack.plan}: +${pack.credits} credits for user ${userId} (balance: ${newBalance}). Session: ${sessionId}`
    );

    res.status(200).json({ received: true, credits_added: pack.credits });
  } catch (err) {
    console.error('[stripe] Processing error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
}
