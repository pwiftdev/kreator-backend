/**
 * Video generation via LaoZhang Veo 3.1 Async API
 * @see https://docs.laozhang.ai/en/api-capabilities/veo/veo-31-async-api
 */

import type { Request, Response } from 'express';

const LAOZHANG_API_KEY = process.env.LAOZHANG_API_KEY;
const LAOZHANG_API_URL = process.env.LAOZHANG_API_URL || 'https://api.laozhang.ai';

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 600_000; // 10 min

const VIDEO_MODELS = [
  'veo-3.1',
  'veo-3.1-fl',
  'veo-3.1-fast',
  'veo-3.1-fast-fl',
  'veo-3.1-landscape',
  'veo-3.1-landscape-fl',
  'veo-3.1-landscape-fast',
  'veo-3.1-landscape-fast-fl',
] as const;

type VideoModelId = (typeof VIDEO_MODELS)[number];

function isVideoModel(m: string): m is VideoModelId {
  return VIDEO_MODELS.includes(m as VideoModelId);
}

/** Fetch image from URL and return buffer */
async function fetchImageBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Kreator-Backend/1.0', Accept: 'image/*' },
  });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return { buffer: buf, contentType };
}

/** Create video task (text-to-video or image-to-video) */
export async function createVideoHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === 'sk-YOUR_API_KEY_HERE') {
    res.status(500).json({ error: 'LAOZHANG_API_KEY not set' });
    return;
  }

  try {
    const body = req.body as {
      prompt?: string;
      model?: string;
      referenceImageUrl?: string;
    };
    const prompt = body?.prompt?.trim();
    const modelParam = body?.model?.trim() || 'veo-3.1';
    const model = isVideoModel(modelParam) ? modelParam : 'veo-3.1';
    const referenceImageUrl = body?.referenceImageUrl && body.referenceImageUrl.startsWith('http') ? body.referenceImageUrl : undefined;

    if (!prompt) {
      res.status(400).json({ error: 'Missing or invalid prompt' });
      return;
    }

    const url = `${LAOZHANG_API_URL}/v1/videos`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${LAOZHANG_API_KEY}`,
    };

    let apiRes: globalThis.Response;
    if (referenceImageUrl && (model.includes('-fl'))) {
      const { buffer, contentType } = await fetchImageBuffer(referenceImageUrl);
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      form.append('input_reference', new Blob([new Uint8Array(buffer)], { type: contentType }), `ref.${ext}`);
      apiRes = await fetch(url, {
        method: 'POST',
        headers,
        body: form,
      });
    } else {
      headers['Content-Type'] = 'application/json';
      apiRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, prompt }),
      });
    }

    const data = (await apiRes.json()) as { id?: string; object?: string; status?: string; error?: { message?: string } };
    if (!apiRes.ok) {
      const msg = data?.error?.message || `LaoZhang API error: ${apiRes.status}`;
      console.error('[video] Create failed:', apiRes.status, msg);
      res.status(apiRes.status >= 500 ? 502 : apiRes.status).json({ error: msg });
      return;
    }
    const videoId = data.id;
    if (!videoId) {
      res.status(502).json({ error: 'No video id in response' });
      return;
    }
    console.log(`[video] Created task ${videoId} model=${model}`);
    res.status(200).json({ videoId, status: data.status || 'queued', model });
  } catch (err) {
    console.error('[video] Create error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Video create failed' });
  }
}

/** Get video task status */
export async function videoStatusHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const videoId = req.params.videoId;
  if (!videoId) {
    res.status(400).json({ error: 'Missing videoId' });
    return;
  }
  if (!LAOZHANG_API_KEY) {
    res.status(500).json({ error: 'LAOZHANG_API_KEY not set' });
    return;
  }

  try {
    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos/${videoId}`, {
      headers: { Authorization: `Bearer ${LAOZHANG_API_KEY}` },
    });
    const data = (await response.json()) as { id?: string; status?: string; prompt?: string; error?: { message?: string } };
    if (!response.ok) {
      const msg = data?.error?.message || `LaoZhang API error: ${response.status}`;
      res.status(response.status >= 500 ? 502 : response.status).json({ error: msg });
      return;
    }
    res.status(200).json({ videoId: data.id, status: data.status || 'unknown', prompt: data.prompt });
  } catch (err) {
    console.error('[video] Status error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Status check failed' });
  }
}

/** Get video content (URL) after completion */
export async function videoContentHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const videoId = req.params.videoId;
  if (!videoId) {
    res.status(400).json({ error: 'Missing videoId' });
    return;
  }
  if (!LAOZHANG_API_KEY) {
    res.status(500).json({ error: 'LAOZHANG_API_KEY not set' });
    return;
  }

  try {
    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos/${videoId}/content`, {
      headers: {
        Authorization: `Bearer ${LAOZHANG_API_KEY}`,
        Accept: 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';
    let data: {
      id?: string;
      status?: string;
      url?: string;
      duration?: number;
      resolution?: string;
      prompt?: string;
      model?: string;
      error?: { message?: string };
    };

    if (contentType.includes('application/json')) {
      data = (await response.json()) as typeof data;
    } else {
      const text = await response.text();
      if (text.startsWith('{')) {
        try {
          data = JSON.parse(text) as typeof data;
        } catch {
          console.error('[video] Content: response is not JSON and not binary video', contentType?.slice(0, 50));
          res.status(502).json({ error: 'API returned unexpected format' });
          return;
        }
      } else {
        // API returned the video file directly (common). Return our proxy URL so frontend can play it.
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const proxyUrl = `${baseUrl}/api/videos/${videoId}/file`;
        res.status(200).json({
          videoId,
          url: proxyUrl,
          duration: undefined,
          resolution: undefined,
          prompt: undefined,
          model: undefined,
        });
        return;
      }
    }

    if (!response.ok) {
      const msg = data?.error?.message || `LaoZhang API error: ${response.status}`;
      res.status(response.status >= 500 ? 502 : response.status).json({ error: msg });
      return;
    }
    if (data.status !== 'completed' || !data.url) {
      res.status(400).json({ error: 'Video not ready or missing URL', status: data.status });
      return;
    }
    res.status(200).json({
      videoId: data.id,
      url: data.url,
      duration: data.duration,
      resolution: data.resolution,
      prompt: data.prompt,
      model: data.model,
    });
  } catch (err) {
    console.error('[video] Content error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Get content failed' });
  }
}

/** Stream video file when LaoZhang returns binary from /content */
export async function videoFileHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const videoId = req.params.videoId;
  if (!videoId) {
    res.status(400).json({ error: 'Missing videoId' });
    return;
  }
  if (!LAOZHANG_API_KEY) {
    res.status(500).json({ error: 'LAOZHANG_API_KEY not set' });
    return;
  }

  try {
    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos/${videoId}/content`, {
      headers: { Authorization: `Bearer ${LAOZHANG_API_KEY}` },
    });

    if (!response.ok) {
      const text = await response.text();
      let msg = `LaoZhang API error: ${response.status}`;
      try {
        const err = JSON.parse(text);
        if (err?.error?.message) msg = err.error.message;
      } catch {
        if (text) msg = text.slice(0, 200);
      }
      res.status(response.status >= 500 ? 502 : response.status).json({ error: msg });
      return;
    }

    const contentType = response.headers.get('content-type') || 'video/mp4';
    res.setHeader('Content-Type', contentType);
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[video] File stream error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Video stream failed' });
  }
}
