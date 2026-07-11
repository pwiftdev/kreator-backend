import { createClient, type User } from "@supabase/supabase-js";
import type { Request } from "express";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAdmin =
  url && serviceRoleKey
    ? createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

export async function getAuthenticatedUser(req: Request): Promise<User | null> {
  if (!supabaseAdmin) return null;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(header.slice(7));
  return error ? null : data.user;
}
