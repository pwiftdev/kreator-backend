import type { Request, Response } from "express";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import {
  createJob,
  getJob,
  setJobError,
  setJobResult,
  setJobRunning,
} from "../jobs.js";
import { sanitizeError } from "../utils/sanitize-error.js";
import { getAuthenticatedUser } from "../utils/supabase-admin.js";
import { fetchRemoteImage } from "../utils/remote-image.js";

const LAOZHANG_API_KEY = process.env.LAOZHANG_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const BUCKET_NAME = "generated-images";
const THUMB_WIDTH = 400;
const THUMB_JPEG_QUALITY = 65;
const LAOZHANG_PRIMARY_API_URL =
  process.env.LAOZHANG_API_URL || "https://api-vip.laozhang.ai";
const LAOZHANG_FALLBACK_API_URL =
  process.env.LAOZHANG_FALLBACK_API_URL || "https://api.laozhang.ai";
const LAOZHANG_API_URLS = [LAOZHANG_PRIMARY_API_URL, LAOZHANG_FALLBACK_API_URL];

const LAOZHANG_FETCH_TIMEOUT_MS = 60_000;
const LAOZHANG_MAX_RETRIES = 2;
const LAOZHANG_RETRY_DELAY_MS = 5000;
const REF_IMAGE_MAX_DIM = 768;
const REF_IMAGE_JPEG_QUALITY = 75;

/** Create a thumbnail buffer from full-size image buffer (for grid cards). */
async function createThumbnail(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize(THUMB_WIDTH, THUMB_WIDTH, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_JPEG_QUALITY })
    .toBuffer();
}

/** Compress reference image for LaoZhang API to reduce payload size and avoid connection drops */
async function compressRefImage(base64: string, mime: string): Promise<string> {
  const buf = Buffer.from(base64, "base64");
  const out = await sharp(buf)
    .resize(REF_IMAGE_MAX_DIM, REF_IMAGE_MAX_DIM, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: REF_IMAGE_JPEG_QUALITY })
    .toBuffer();
  return out.toString("base64");
}

/** Upload base64 reference image to Supabase and return public URL */
async function uploadRefToSupabase(
  base64Data: string,
  userId: string,
): Promise<string | null> {
  if (!supabase) return null;
  const base64Clean = base64Data.includes("base64,")
    ? base64Data.split("base64,")[1]
    : base64Data;
  if (!base64Clean) return null;
  try {
    const buf = Buffer.from(base64Clean, "base64");
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
    const storagePath = `${userId}/refs/${fileName}`;
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, buf, {
        contentType: "image/jpeg",
        upsert: false,
        cacheControl: "31536000",
      });
    if (error) {
      console.warn("[generate] Failed to upload main ref:", error.message);
      return null;
    }
    const { data } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(storagePath);
    return data.publicUrl;
  } catch (err) {
    console.warn("[generate] Upload ref error:", err);
    return null;
  }
}

/** Fetch image from URL and return base64 (no data URL prefix) */
async function fetchImageAsBase64(url: string): Promise<string> {
  const { buffer } = await fetchRemoteImage(url);
  return buffer.toString("base64");
}

/** Resolve reference images from base64 array or URL array */
async function resolveReferenceImages(
  referenceImages?: string[],
  referenceImageUrls?: string[],
): Promise<Array<{ mime_type: string; data: string }>> {
  const parts: Array<{ mime_type: string; data: string }> = [];

  // Base64 refs (legacy / inline)
  if (
    referenceImages &&
    Array.isArray(referenceImages) &&
    referenceImages.length > 0
  ) {
    console.log(
      `[generate] Resolving ${referenceImages.length} reference image(s) from base64`,
    );
    for (const imageData of referenceImages) {
      const base64Data = imageData.includes("base64,")
        ? imageData.split("base64,")[1]
        : imageData;
      if (base64Data) {
        parts.push({ mime_type: "image/jpeg", data: base64Data });
      }
    }
  }

  // URL refs - backend fetches, avoids payload limits entirely
  if (
    referenceImageUrls &&
    Array.isArray(referenceImageUrls) &&
    referenceImageUrls.length > 0
  ) {
    console.log(
      `[generate] Fetching ${referenceImageUrls.length} reference image(s) from URLs`,
    );
    for (const url of referenceImageUrls) {
      if (typeof url !== "string" || !url.startsWith("http")) continue;
      try {
        const base64 = await fetchImageAsBase64(url);
        parts.push({ mime_type: "image/jpeg", data: base64 });
        console.log(
          `[generate] Fetched ref from URL (${(base64.length / 1024).toFixed(1)}KB base64)`,
        );
      } catch (err) {
        console.warn("[generate] Failed to fetch reference image:", url, err);
        // Skip this ref rather than failing the whole request
      }
    }
  }

  return parts;
}

const DEFAULT_MODEL = "gemini-3-pro-image-preview";
const ALLOWED_MODELS = [
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
] as const;

type GenerateBody = {
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  model?: string;
  referenceImages?: string[];
  referenceImageUrls?: string[];
  userId?: string;
};

type GenerateResult = {
  url?: string;
  storagePath?: string;
  thumbUrl?: string;
  thumbStoragePath?: string;
  base64Data?: string;
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  referenceImageUrls?: string[];
};

async function doGenerate(body: GenerateBody): Promise<GenerateResult> {
  const {
    prompt,
    aspectRatio,
    imageSize,
    model: modelParam,
    referenceImages,
    referenceImageUrls,
    userId,
  } = body;
  const model = ALLOWED_MODELS.includes(
    modelParam as (typeof ALLOWED_MODELS)[number],
  )
    ? modelParam
    : DEFAULT_MODEL;
  const startTime = Date.now();

  const refCount =
    (referenceImages?.length ?? 0) + (referenceImageUrls?.length ?? 0);
  console.log(
    `[generate] Starting request aspect=${aspectRatio || "3:2"} size=${imageSize || "1K"} refs=${refCount}`,
  );

  const parts: Array<{
    text?: string;
    inline_data?: { mime_type: string; data: string };
  }> = [{ text: prompt }];

  // When referenceImages present (moodboard flow with main ref), use only base64 to avoid duplicates
  let imageParts = referenceImages?.length
    ? await resolveReferenceImages(referenceImages, [])
    : await resolveReferenceImages([], referenceImageUrls);
  if (imageParts.length > 0) {
    console.log(
      `[generate] Resolved ${imageParts.length} reference image(s), compressing...`,
    );
    const compressed: Array<{ mime_type: string; data: string }> = [];
    for (let i = 0; i < imageParts.length; i++) {
      const img = imageParts[i];
      try {
        const data = await compressRefImage(img.data, img.mime_type);
        compressed.push({ mime_type: "image/jpeg", data });
        console.log(
          `[generate] Ref ${i + 1}: ${(img.data.length / 1024).toFixed(0)}KB → ${(data.length / 1024).toFixed(0)}KB`,
        );
      } catch (err) {
        console.warn(
          `[generate] Could not compress ref ${i + 1}, using original:`,
          err,
        );
        compressed.push(img);
      }
    }
    imageParts = compressed;
  }
  for (const img of imageParts) {
    parts.push({ inline_data: img });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: aspectRatio || "3:2",
        imageSize: imageSize || "1K",
      },
    },
  };

  const payloadStr = JSON.stringify(payload);
  const payloadSizeKB = (Buffer.byteLength(payloadStr) / 1024).toFixed(1);
  console.log(
    `[generate] Calling LaoZhang API (payload ${payloadSizeKB}KB, ${imageParts.length} refs)...`,
  );

  let lastError: unknown = null;
  let laoRes: Awaited<ReturnType<typeof fetch>> | null = null;

  for (let attempt = 1; attempt <= LAOZHANG_MAX_RETRIES; attempt++) {
    for (const baseUrl of LAOZHANG_API_URLS) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        LAOZHANG_FETCH_TIMEOUT_MS,
      );

      try {
        laoRes = await fetch(
          `${baseUrl}/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LAOZHANG_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: payloadStr,
            signal: controller.signal,
          },
        );
        clearTimeout(timeout);
        if (laoRes.ok || laoRes.status < 500) {
          break;
        }
        lastError = new Error(`HTTP ${laoRes.status} from ${baseUrl}`);
        console.warn(
          `[generate] LaoZhang ${baseUrl} returned ${laoRes.status} (attempt ${attempt}/${LAOZHANG_MAX_RETRIES})`,
        );
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        const isRetryable =
          err instanceof Error &&
          (err.name === "AbortError" ||
            err.message?.includes("fetch failed") ||
            (err.cause as Error)?.message?.includes("closed"));
        if (!isRetryable) {
          throw err;
        }
        console.warn(
          `[generate] LaoZhang request failed via ${baseUrl} (attempt ${attempt}/${LAOZHANG_MAX_RETRIES})`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (laoRes && (laoRes.ok || laoRes.status < 500)) {
      break;
    }
    if (attempt < LAOZHANG_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, LAOZHANG_RETRY_DELAY_MS));
    }
  }

  if (!laoRes) {
    throw (
      lastError ??
      new Error(
        "Our AI provider is temporarily unavailable. Please try again in a few minutes.",
      )
    );
  }

  if (!laoRes.ok) {
    const errorData = (await laoRes.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const rawMsg =
      errorData.error?.message || `${laoRes.status} ${laoRes.statusText}`;
    throw new Error(sanitizeError(rawMsg, laoRes.status, "generate"));
  }

  const result = (await laoRes.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string } }> };
    }>;
  };
  const base64Data =
    result.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!base64Data) {
    console.error("[generate] No image data in upstream response");
    throw new Error(
      "Image generation failed — no image was returned. Please try again.",
    );
  }

  const elapsed = Date.now() - startTime;
  const sizeKB = (base64Data.length / 1024).toFixed(1);
  console.log(`[generate] LaoZhang returned ${sizeKB}KB image, ${elapsed}ms`);

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`;
  const storagePath = userId ? `${userId}/generated/${fileName}` : fileName;

  if (supabase) {
    try {
      const buf = Buffer.from(base64Data, "base64");
      const { error: uploadError } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, buf, {
          contentType: "image/png",
          upsert: false,
          cacheControl: "31536000", // 1 year - reduce repeated downloads from CDN
        });

      if (uploadError) {
        throw new Error(
          `Generated image storage failed: ${uploadError.message}`,
        );
      }

      const { data: urlData } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(storagePath);
      const publicUrl = urlData.publicUrl;

      let thumbUrl: string | undefined;
      let thumbStoragePath: string | undefined;
      try {
        const thumbBuf = await createThumbnail(buf);
        const baseName = fileName.replace(/\.\w+$/, "");
        const thumbPath = userId
          ? `${userId}/thumbs/${baseName}-thumb.jpg`
          : `thumbs/${baseName}-thumb.jpg`;
        const { error: thumbUploadError } = await supabase.storage
          .from(BUCKET_NAME)
          .upload(thumbPath, thumbBuf, {
            contentType: "image/jpeg",
            upsert: false,
            cacheControl: "31536000",
          });
        if (!thumbUploadError) {
          thumbStoragePath = thumbPath;
          const { data: thumbUrlData } = supabase.storage
            .from(BUCKET_NAME)
            .getPublicUrl(thumbPath);
          thumbUrl = thumbUrlData.publicUrl;
          console.log(`[generate] Thumbnail uploaded: ${thumbPath}`);
        }
      } catch (thumbErr) {
        console.warn(
          "[generate] Thumbnail creation failed, using full URL for grid:",
          thumbErr,
        );
      }

      console.log(
        `[generate] Uploaded to Supabase, returning URL (${Date.now() - startTime}ms total)`,
      );
      return {
        url: publicUrl,
        storagePath,
        thumbUrl: thumbUrl ?? publicUrl,
        thumbStoragePath,
        prompt,
        aspectRatio: aspectRatio || "3:2",
        imageSize: imageSize || "1K",
      };
    } catch (uploadErr) {
      console.error("[generate] Supabase upload error:", uploadErr);
      throw uploadErr;
    }
  }

  throw new Error("Generated image storage is not configured");
}

export async function generateHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const requestStartedAt = Date.now();
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === "sk-YOUR_API_KEY_HERE") {
    console.error("[generate] LAOZHANG_API_KEY not set");
    res.status(500).json({
      error:
        "Server configuration error: LAOZHANG_API_KEY not set. Add it in Heroku Config Vars.",
    });
    return;
  }

  const authenticatedUser = await getAuthenticatedUser(req);
  if (!authenticatedUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const body = req.body as {
    prompt?: string;
    aspectRatio?: string;
    imageSize?: string;
    model?: string;
    referenceImages?: string[];
    referenceImageUrls?: string[];
  };

  const { prompt } = body;
  const userId = authenticatedUser.id;
  if (!prompt || typeof prompt !== "string" || prompt.length > 4000) {
    res.status(400).json({ error: "Missing or invalid prompt" });
    return;
  }
  if (
    (body.referenceImages?.length ?? 0) > 10 ||
    (body.referenceImageUrls?.length ?? 0) > 10
  ) {
    res
      .status(400)
      .json({ error: "A maximum of 10 reference images is allowed" });
    return;
  }

  const amount = 1;
  let jobId: string;
  try {
    jobId = await createJob(userId);
  } catch (err) {
    console.error("[generate] Failed to create job:", err);
    const code = err instanceof Error ? err.message : "";
    if (code === "INSUFFICIENT_CREDITS") {
      res.status(402).json({ error: "Insufficient credits" });
    } else if (code === "CONCURRENCY_LIMIT") {
      res.status(429).json({ error: "You already have 3 active generations" });
    } else {
      res.status(500).json({ error: "Failed to create job" });
    }
    return;
  }

  void (async () => {
    let generationCompleted = false;
    try {
      await setJobRunning(jobId);
      const result = await doGenerate({ ...body, prompt, userId });
      generationCompleted = true;
      // If backend uploaded to Supabase and we have userId, save metadata here so images persist on reload
      if (
        result.url &&
        result.storagePath &&
        supabase &&
        userId &&
        typeof userId === "string"
      ) {
        try {
          const existingUrls: string[] = Array.isArray(body.referenceImageUrls)
            ? body.referenceImageUrls.filter(
                (u): u is string => typeof u === "string" && !!u,
              )
            : [];
          // Upload ALL base64 references to Supabase so they persist for modal display and re-run
          const referenceImages = Array.isArray(body.referenceImages)
            ? body.referenceImages
            : [];
          const uploadedUrls: string[] = [];
          for (const base64Ref of referenceImages) {
            if (!base64Ref) continue;
            const url = await uploadRefToSupabase(base64Ref, userId);
            if (url) uploadedUrls.push(url);
          }
          const refUrls = [...uploadedUrls, ...existingUrls];
          const insertPayload: Record<string, unknown> = {
            prompt: result.prompt,
            aspect_ratio: result.aspectRatio,
            image_size: result.imageSize,
            storage_path: result.storagePath,
            file_name: result.storagePath,
            user_id: userId,
          };
          if (result.thumbStoragePath)
            insertPayload.thumb_storage_path = result.thumbStoragePath;
          if (refUrls.length > 0) {
            insertPayload.reference_image_urls = refUrls;
            result.referenceImageUrls = refUrls;
          }
          const { data: row, error: insertErr } = await supabase
            .from("images")
            .insert(insertPayload)
            .select("id")
            .single();
          if (!insertErr && row?.id) {
            (result as Record<string, unknown>).id = row.id;
          }
        } catch (metaErr) {
          console.warn(
            "[generate] Failed to save metadata (frontend will save):",
            metaErr,
          );
        }
      }
      await setJobResult(jobId, result);
      if (supabase) {
        await supabase.from("api_usage_events").insert({
          user_id: userId || null,
          endpoint: "image-generation",
          model: body.model || DEFAULT_MODEL,
          status: "success",
          credits_consumed: amount,
          duration_ms: Date.now() - requestStartedAt,
        });
      }
    } catch (error) {
      console.error("[generate] Job failed:", error);
      // Refund the credit since generation failed
      let refunded = false;
      if (!generationCompleted && supabase) {
        try {
          const { error: refundError } = await supabase.rpc("add_credits", {
            p_user_id: userId,
            p_amount: amount,
          });
          if (refundError) throw refundError;
          refunded = true;
          console.log(
            `[generate] Refunded ${amount} credit(s) to user ${userId}`,
          );
        } catch (refundErr) {
          console.error("[generate] Failed to refund credits:", refundErr);
        }
      }
      const msg = sanitizeError(
        error instanceof Error ? error.message : null,
        500,
        "generate",
      );
      if (supabase) {
        await supabase.from("api_usage_events").insert({
          user_id: userId || null,
          endpoint: "image-generation",
          model: body.model || DEFAULT_MODEL,
          status: "failed",
          credits_consumed: refunded ? 0 : amount,
          duration_ms: Date.now() - requestStartedAt,
        });
      }
      try {
        await setJobError(jobId, refunded ? `${msg} [CREDITS_REFUNDED]` : msg);
      } catch (jobError) {
        console.error(
          "[generate] Failed to persist terminal job error:",
          jobError,
        );
      }
    }
  })();

  res.status(202).json({ jobId });
}

export async function generateStatusHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const jobId = req.params.jobId;
  if (!jobId) {
    res.status(400).json({ error: "Missing jobId" });
    return;
  }

  const authenticatedUser = await getAuthenticatedUser(req);
  if (!authenticatedUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const job = await getJob(jobId, authenticatedUser.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status === "done" && job.result) {
    res.status(200).json(job.result);
    return;
  }

  if (job.status === "error") {
    res.status(500).json({ error: job.error || "Generation failed" });
    return;
  }

  res
    .status(200)
    .json({ status: job.status === "running" ? "running" : "pending" });
}
