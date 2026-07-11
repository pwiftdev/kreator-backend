import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

const SESSION_TTL_SECONDS = 8 * 60 * 60;

function encode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function adminAuthConfigured() {
  const sessionSecret = process.env.ADMIN_SESSION_SECRET ?? "";
  return Boolean(
    process.env.ADMIN_DASHBOARD_EMAIL &&
      process.env.ADMIN_DASHBOARD_PASSWORD &&
      sessionSecret.length >= 32,
  );
}

export function verifyAdminCredentials(email: string, password: string) {
  const configuredEmail = process.env.ADMIN_DASHBOARD_EMAIL ?? "";
  const configuredPassword = process.env.ADMIN_DASHBOARD_PASSWORD ?? "";
  const emailMatches = safeEqual(email, configuredEmail);
  const passwordMatches = safeEqual(password, configuredPassword);
  return emailMatches && passwordMatches;
}

export function createAdminToken(email: string) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("Admin session secret is not configured");
  const payload = encode(
    JSON.stringify({
      email,
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyAdminRequest(req: Request) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!secret || !token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret)))
    return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      email?: string;
      expiresAt?: number;
    };
    return (
      parsed.email === process.env.ADMIN_DASHBOARD_EMAIL &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}
