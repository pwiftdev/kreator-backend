import type { Request, Response } from "express";
import Stripe from "stripe";
import {
  getAuthenticatedUser,
  supabaseAdmin,
} from "../utils/supabase-admin.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORTAL_RETURN_URL =
  process.env.PORTAL_RETURN_URL || "https://www.kreator.vision/app";

/**
 * POST /api/stripe/portal
 * Creates a Stripe Customer Portal session so the user can manage
 * their subscription (cancel, update payment method, etc.).
 * Body: { userId: string }
 */
export async function stripePortalHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!STRIPE_SECRET_KEY) {
    res.status(500).json({ error: "Stripe not configured" });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Supabase not configured" });
    return;
  }

  const authenticatedUser = await getAuthenticatedUser(req);
  if (!authenticatedUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!supabaseAdmin) {
    res.status(500).json({ error: "Supabase not configured" });
    return;
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", authenticatedUser.id)
    .maybeSingle();

  if (profileErr || !profile?.stripe_customer_id) {
    res.status(404).json({ error: "No active subscription found" });
    return;
  }

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: PORTAL_RETURN_URL,
    });

    res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error("[stripe-portal] Error creating portal session:", err);
    res.status(500).json({ error: "Failed to create portal session" });
  }
}
