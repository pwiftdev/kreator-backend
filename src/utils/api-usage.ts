import { supabaseAdmin } from "./supabase-admin.js";

export async function recordApiUsage(event: {
  userId: string;
  endpoint: string;
  model?: string;
  status: "success" | "failed";
  creditsConsumed: number;
  durationMs: number;
}) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.from("api_usage_events").insert({
    user_id: event.userId,
    endpoint: event.endpoint,
    model: event.model ?? null,
    status: event.status,
    credits_consumed: event.creditsConsumed,
    duration_ms: event.durationMs,
  });
  if (error)
    console.error("[telemetry] Failed to record API usage:", error.message);
}
