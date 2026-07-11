import type { Request, Response } from "express";
import { supabaseAdmin } from "../utils/supabase-admin.js";
import {
  adminAuthConfigured,
  createAdminToken,
  verifyAdminCredentials,
  verifyAdminRequest,
} from "../utils/admin-auth.js";

const PAGE_SIZE = 25;
const ALLOWED_ROLES = new Set(["user", "admin"]);
const ALLOWED_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "canceled",
  "none",
]);

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  if (!supabaseAdmin) {
    res.status(500).json({ error: "Supabase not configured" });
    return false;
  }
  if (!verifyAdminRequest(req)) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const loginCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(key);
  }
}, 15 * 60_000);
loginCleanupTimer.unref();

export async function adminLoginHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!adminAuthConfigured()) {
    res.status(500).json({ error: "Admin login is not configured" });
    return;
  }
  const key = req.ip || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.resetAt > now && attempt.count >= 5) {
    res
      .status(429)
      .json({ error: "Too many attempts. Try again in 15 minutes." });
    return;
  }
  const { email, password } = req.body as {
    email?: unknown;
    password?: unknown;
  };
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !verifyAdminCredentials(email, password)
  ) {
    loginAttempts.set(key, {
      count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1,
      resetAt:
        attempt && attempt.resetAt > now
          ? attempt.resetAt
          : now + 15 * 60 * 1000,
    });
    res.status(401).json({ error: "Invalid admin credentials" });
    return;
  }
  loginAttempts.delete(key);
  res.json({ token: createAdminToken(email), email, expiresIn: 8 * 60 * 60 });
}

export async function adminSessionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!verifyAdminRequest(req)) {
    res.status(401).json({ error: "Admin session expired" });
    return;
  }
  res.json({ valid: true, email: process.env.ADMIN_DASHBOARD_EMAIL });
}

export async function adminMetricsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await requireAdmin(req, res)) || !supabaseAdmin) return;
  const granularity = ["day", "week", "month"].includes(
    String(req.query.granularity),
  )
    ? String(req.query.granularity)
    : "day";
  const periods = granularity === "day" ? 30 : granularity === "week" ? 16 : 12;
  const { data, error } = await supabaseAdmin.rpc("get_admin_metrics", {
    p_granularity: granularity,
    p_periods: periods,
  });
  if (error) {
    console.error("[admin] metrics failed:", error);
    res.status(500).json({
      error: "Failed to load metrics. Run the latest admin migration.",
    });
    return;
  }
  res.json(data);
}

export async function adminUsersHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await requireAdmin(req, res)) || !supabaseAdmin) return;
  const page = Math.max(1, Number(req.query.page) || 1);
  const search =
    typeof req.query.search === "string"
      ? req.query.search.trim().toLowerCase()
      : "";
  try {
    const { data, error } = await supabaseAdmin.rpc("get_admin_users", {
      p_search: search,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    });
    if (error) throw error;
    const result = data as {
      total: number;
      users: Array<{
        id: string;
        email: string;
        createdAt: string;
        lastSignInAt: string | null;
        emailConfirmedAt: string | null;
        bannedUntil: string | null;
        username: string | null;
        credits: number;
        role: string;
        subscriptionPlan: string | null;
        subscriptionStatus: string | null;
        imageCount: number;
        lastGenerationAt: string | null;
      }>;
    };
    res.json({
      users: result.users.map((user) => ({
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        lastSignInAt: user.lastSignInAt,
        emailConfirmedAt: user.emailConfirmedAt,
        bannedUntil: user.bannedUntil,
        profile: {
          username: user.username,
          credits: user.credits,
          role: user.role,
          subscription_plan: user.subscriptionPlan,
          subscription_status: user.subscriptionStatus,
        },
        imageCount: Number(user.imageCount),
        lastGenerationAt: user.lastGenerationAt,
      })),
      page,
      pageSize: PAGE_SIZE,
      total: Number(result.total),
    });
  } catch (error) {
    console.error("[admin] users failed:", error);
    res.status(500).json({ error: "Failed to load users" });
  }
}

export async function adminUpdateUserHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await requireAdmin(req, res)) || !supabaseAdmin) return;
  const id = req.params.id;
  const {
    email,
    username,
    credits,
    role,
    subscriptionPlan,
    subscriptionStatus,
    suspended,
  } = req.body as Record<string, unknown>;
  if (
    email !== undefined &&
    (typeof email !== "string" || !email.includes("@"))
  ) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  if (
    credits !== undefined &&
    (!Number.isInteger(credits) || Number(credits) < 0)
  ) {
    res.status(400).json({ error: "Credits must be a non-negative integer" });
    return;
  }
  if (role !== undefined && !ALLOWED_ROLES.has(String(role))) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }
  if (
    subscriptionStatus !== undefined &&
    !ALLOWED_STATUSES.has(String(subscriptionStatus))
  ) {
    res.status(400).json({ error: "Invalid subscription status" });
    return;
  }
  try {
    const authUpdates: { email?: string; ban_duration?: string } = {};
    if (typeof email === "string") authUpdates.email = email.trim();
    if (typeof suspended === "boolean")
      authUpdates.ban_duration = suspended ? "876000h" : "none";
    if (Object.keys(authUpdates).length) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(
        id,
        authUpdates,
      );
      if (error) throw error;
    }
    const profileUpdates: Record<string, unknown> = {
      id,
      updated_at: new Date().toISOString(),
    };
    if (typeof username === "string")
      profileUpdates.username = username.trim() || null;
    if (credits !== undefined) profileUpdates.credits = credits;
    if (role !== undefined) profileUpdates.role = role;
    if (subscriptionPlan !== undefined)
      profileUpdates.subscription_plan = subscriptionPlan || null;
    if (subscriptionStatus !== undefined)
      profileUpdates.subscription_status =
        subscriptionStatus === "none" ? null : subscriptionStatus;
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .upsert(profileUpdates);
    if (profileError) throw profileError;
    res.json({ success: true });
  } catch (error) {
    console.error("[admin] update failed:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
}
