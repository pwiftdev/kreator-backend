import type { Request, Response } from "express";
import FormData from "form-data";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "../utils/sanitize-error.js";
import { getAuthenticatedUser } from "../utils/supabase-admin.js";
import { fetchRemoteImage } from "../utils/remote-image.js";
import { recordApiUsage } from "../utils/api-usage.js";

const LAOZHANG_API_KEY = process.env.LAOZHANG_API_KEY;
const LAOZHANG_PRIMARY_API_URL =
  process.env.LAOZHANG_API_URL || "https://api-vip.laozhang.ai";
const LAOZHANG_FALLBACK_API_URL =
  process.env.LAOZHANG_FALLBACK_API_URL || "https://api.laozhang.ai";
const LAOZHANG_API_URLS = [LAOZHANG_PRIMARY_API_URL, LAOZHANG_FALLBACK_API_URL];
const LAOZHANG_MAX_RETRIES = 3;
const LAOZHANG_RETRY_DELAY_MS = 1500;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const VIDEO_CREDIT_COST: Record<string, number> = {
  "veo-3.1-fl": 25,
  "veo-3.1-fast-fl": 20,
  "veo-3.1-landscape-fl": 25,
  "veo-3.1-landscape-fast-fl": 20,
};

/** Allowed Veo 3.1 image-to-video models (all have -fl suffix). */
const ALLOWED_MODELS = new Set([
  "veo-3.1-fl",
  "veo-3.1-fast-fl",
  "veo-3.1-landscape-fl",
  "veo-3.1-landscape-fast-fl",
]);

async function ownsVideoTask(taskId: string, userId: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("video_generation_tasks")
    .select("task_id")
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  return !error && Boolean(data);
}

async function refundVideoCredits(
  userId: string,
  amount: number,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc("add_credits", {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error) console.error("[video] Failed to refund credits:", error.message);
}

/** Resolve image URL or data URL to a Buffer + mime type. */
async function getImageBuffer(
  imageUrl: string,
): Promise<{ buffer: Buffer; mime: string }> {
  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid data URL");
    const mime = match[1].trim();
    if (!mime.startsWith("image/"))
      throw new Error("Data URL must contain an image");
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 20 * 1024 * 1024)
      throw new Error("Input image is too large");
    return { buffer, mime };
  }
  return fetchRemoteImage(imageUrl);
}

/** Call LaoZhang with primary + fallback domain and retries for transient failures. */
async function fetchLaozhang(
  path: string,
  init: RequestInit,
): Promise<globalThis.Response> {
  let lastRes: globalThis.Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= LAOZHANG_MAX_RETRIES; attempt++) {
    for (const baseUrl of LAOZHANG_API_URLS) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(120_000),
        });
        lastRes = res;
        if (res.ok || res.status < 500) {
          return res;
        }
        console.warn(
          `[video] LaoZhang ${baseUrl} returned ${res.status} (attempt ${attempt}/${LAOZHANG_MAX_RETRIES})`,
        );
      } catch (err) {
        lastErr = err;
        console.warn(
          `[video] LaoZhang request failed via ${baseUrl} (attempt ${attempt}/${LAOZHANG_MAX_RETRIES})`,
        );
      }
    }
    if (attempt < LAOZHANG_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, LAOZHANG_RETRY_DELAY_MS));
    }
  }
  if (lastRes) return lastRes;
  throw lastErr instanceof Error
    ? lastErr
    : new Error("LaoZhang request failed");
}

/**
 * POST /api/video/generate
 * Create Veo 3.1 async video task (returns immediately).
 * Body: { prompt, imageUrl, model? }
 */
export async function videoGenerateHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const requestStartedAt = Date.now();
  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === "sk-YOUR_API_KEY_HERE") {
    res
      .status(500)
      .json({ error: "Server configuration error: LAOZHANG_API_KEY not set." });
    return;
  }

  const authenticatedUser = await getAuthenticatedUser(req);
  if (!authenticatedUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const body = req.body as {
    prompt?: string;
    imageUrl?: string;
    model?: string;
  };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const imageUrl =
    typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  const userId = authenticatedUser.id;
  const model =
    typeof body.model === "string" && ALLOWED_MODELS.has(body.model)
      ? body.model
      : "veo-3.1-fl";

  if (!prompt || prompt.length > 4000) {
    res.status(400).json({ error: "Missing or invalid prompt" });
    return;
  }

  if (
    !imageUrl ||
    (!imageUrl.startsWith("http") && !imageUrl.startsWith("data:"))
  ) {
    res
      .status(400)
      .json({
        error: "Missing or invalid imageUrl (must be https or data: URL)",
      });
    return;
  }

  const creditCost = VIDEO_CREDIT_COST[model] ?? 25;

  if (userId && supabase) {
    const { data: newCredits, error: deductErr } = await supabase.rpc(
      "deduct_credits",
      {
        p_user_id: userId,
        p_amount: creditCost,
      },
    );
    if (deductErr) {
      console.error("[video] deduct_credits error:", deductErr);
      res.status(500).json({ error: "Failed to check credits" });
      return;
    }
    if (newCredits == null) {
      res
        .status(402)
        .json({
          error: `Insufficient credits. This model costs ${creditCost} credits.`,
        });
      return;
    }
    console.log(
      `[video] Deducted ${creditCost} credits from user ${userId}, new balance: ${newCredits}`,
    );
  }

  try {
    const { buffer, mime } = await getImageBuffer(imageUrl);
    const ext = mime.includes("png")
      ? "png"
      : mime.includes("webp")
        ? "webp"
        : "jpg";

    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("input_reference", buffer, {
      filename: `image.${ext}`,
      contentType: mime,
    });

    console.log(
      "[video] Creating Veo task, model=%s, imageSize=%d bytes",
      model,
      buffer.length,
    );

    const response = await fetchLaozhang("/v1/videos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LAOZHANG_API_KEY}`,
        ...form.getHeaders(),
      },
      body: new Uint8Array(form.getBuffer()),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[video] Upstream create error:", response.status);
      await refundVideoCredits(userId, creditCost);
      await recordApiUsage({
        userId,
        endpoint: "video-generation",
        model,
        status: "failed",
        creditsConsumed: 0,
        durationMs: Date.now() - requestStartedAt,
      });
      res
        .status(response.status)
        .json({ error: sanitizeError(errText, response.status, "video") });
      return;
    }

    const data = (await response.json()) as { id?: string; status?: string };
    console.log("[video] Task created successfully");

    const taskId = data?.id;
    if (!taskId) {
      await refundVideoCredits(userId, creditCost);
      await recordApiUsage({
        userId,
        endpoint: "video-generation",
        model,
        status: "failed",
        creditsConsumed: 0,
        durationMs: Date.now() - requestStartedAt,
      });
      res.status(500).json({ error: "No task ID in response" });
      return;
    }

    if (!supabase) {
      await refundVideoCredits(userId, creditCost);
      await recordApiUsage({
        userId,
        endpoint: "video-generation",
        model,
        status: "failed",
        creditsConsumed: 0,
        durationMs: Date.now() - requestStartedAt,
      });
      res.status(500).json({ error: "Video task storage is not configured" });
      return;
    }
    const { error: taskError } = await supabase
      .from("video_generation_tasks")
      .insert({ task_id: taskId, user_id: userId });
    if (taskError) {
      console.error(
        "[video] Failed to persist task ownership:",
        taskError.message,
      );
      await refundVideoCredits(userId, creditCost);
      await recordApiUsage({
        userId,
        endpoint: "video-generation",
        model,
        status: "failed",
        creditsConsumed: 0,
        durationMs: Date.now() - requestStartedAt,
      });
      res.status(500).json({ error: "Failed to save video task" });
      return;
    }

    res.status(200).json({ taskId, status: data.status ?? "queued" });
    await recordApiUsage({
      userId,
      endpoint: "video-generation",
      model,
      status: "success",
      creditsConsumed: creditCost,
      durationMs: Date.now() - requestStartedAt,
    });
  } catch (err) {
    console.error("[video] Create error:", err);
    await refundVideoCredits(userId, creditCost);
    await recordApiUsage({
      userId,
      endpoint: "video-generation",
      model,
      status: "failed",
      creditsConsumed: 0,
      durationMs: Date.now() - requestStartedAt,
    });
    if (!res.headersSent) {
      res
        .status(500)
        .json({
          error: sanitizeError(
            err instanceof Error ? err.message : null,
            500,
            "video",
          ),
        });
    }
  }
}

/**
 * GET /api/video/status/:taskId
 * Proxy task status from LaoZhang.
 */
export async function videoStatusHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const taskId = req.params.taskId;
  if (!taskId) {
    res.status(400).json({ error: "Missing taskId" });
    return;
  }
  if (!LAOZHANG_API_KEY) {
    res.status(500).json({ error: "API key not configured" });
    return;
  }
  const authenticatedUser = await getAuthenticatedUser(req);
  if (
    !authenticatedUser ||
    !(await ownsVideoTask(taskId, authenticatedUser.id))
  ) {
    res.status(404).json({ error: "Video task not found" });
    return;
  }

  try {
    const response = await fetchLaozhang(`/v1/videos/${taskId}`, {
      headers: { Authorization: `Bearer ${LAOZHANG_API_KEY}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[video] Upstream status error:", response.status);
      res
        .status(response.status)
        .json({
          error: sanitizeError(errText, response.status, "video-status"),
        });
      return;
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    console.error("[video] Status error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({
          error: sanitizeError(
            err instanceof Error ? err.message : null,
            500,
            "video-status",
          ),
        });
    }
  }
}

/**
 * GET /api/video/result/:taskId
 * Fetch /content from LaoZhang. The endpoint may return JSON (with a `url` field)
 * or raw MP4 binary — we handle both.
 */
export async function videoResultHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const taskId = req.params.taskId;
  if (!taskId) {
    res.status(400).json({ error: "Missing taskId" });
    return;
  }
  if (!LAOZHANG_API_KEY) {
    res.status(500).json({ error: "API key not configured" });
    return;
  }
  const authenticatedUser = await getAuthenticatedUser(req);
  if (
    !authenticatedUser ||
    !(await ownsVideoTask(taskId, authenticatedUser.id))
  ) {
    res.status(404).json({ error: "Video task not found" });
    return;
  }

  try {
    const response = await fetchLaozhang(`/v1/videos/${taskId}/content`, {
      headers: { Authorization: `Bearer ${LAOZHANG_API_KEY}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[video] Upstream result error:", response.status);
      res
        .status(response.status)
        .json({
          error: sanitizeError(errText, response.status, "video-result"),
        });
      return;
    }

    const ct = (response.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("application/json")) {
      const data = (await response.json()) as {
        url?: string;
        duration?: number;
        resolution?: string;
      };
      res.status(200).json(data);
      return;
    }

    // Raw binary (MP4) — stream it through to client
    res.setHeader("Content-Type", ct || "video/mp4");
    const cl = response.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    res.setHeader(
      "Content-Disposition",
      'inline; filename="kreator-video.mp4"',
    );

    const reader = response.body?.getReader();
    if (!reader) {
      res.status(500).json({ error: "No response body" });
      return;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error("[video] Result error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({
          error: sanitizeError(
            err instanceof Error ? err.message : null,
            500,
            "video-result",
          ),
        });
    }
  }
}
