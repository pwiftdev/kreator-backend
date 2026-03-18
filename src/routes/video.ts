import type { Request, Response } from 'express';
import FormData from 'form-data';

const LAOZHANG_API_KEY = process.env.LAOZHANG_API_KEY;
const LAOZHANG_API_URL = process.env.LAOZHANG_API_URL || 'https://api.laozhang.ai';

/** Allowed Veo 3.1 image-to-video models (all have -fl suffix). */
const ALLOWED_MODELS = new Set([
  'veo-3.1-fl',
  'veo-3.1-fast-fl',
  'veo-3.1-landscape-fl',
  'veo-3.1-landscape-fast-fl',
]);

/** Resolve image URL or data URL to a Buffer + mime type. */
async function getImageBuffer(imageUrl: string): Promise<{ buffer: Buffer; mime: string }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    return { buffer: Buffer.from(match[2], 'base64'), mime: match[1].trim() };
  }
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': 'Kreator-Backend/1.0', Accept: 'image/*' },
  });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'image/png';
  return { buffer: buf, mime: ct.split(';')[0].trim() };
}

/**
 * POST /api/video/generate
 * Create Veo 3.1 async video task (returns immediately).
 * Body: { prompt, imageUrl, model? }
 */
export async function videoGenerateHandler(req: Request, res: Response): Promise<void> {
  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === 'sk-YOUR_API_KEY_HERE') {
    res.status(500).json({ error: 'Server configuration error: LAOZHANG_API_KEY not set.' });
    return;
  }

  const body = req.body as { prompt?: string; imageUrl?: string; model?: string };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  const model = typeof body.model === 'string' && ALLOWED_MODELS.has(body.model)
    ? body.model
    : 'veo-3.1-fl';

  if (!prompt) {
    res.status(400).json({ error: 'Missing or invalid prompt' });
    return;
  }

  if (!imageUrl || (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:'))) {
    res.status(400).json({ error: 'Missing or invalid imageUrl (must be https or data: URL)' });
    return;
  }

  try {
    const { buffer, mime } = await getImageBuffer(imageUrl);
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';

    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('input_reference', buffer, { filename: `image.${ext}`, contentType: mime });

    console.log('[video] Creating Veo task, model=%s, imageSize=%d bytes', model, buffer.length);

    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LAOZHANG_API_KEY}`,
        ...form.getHeaders(),
      },
      body: new Uint8Array(form.getBuffer()),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[video] LaoZhang create error:', response.status, errText);
      res.status(response.status).json({ error: errText || `Upstream error: ${response.status}` });
      return;
    }

    const data = (await response.json()) as { id?: string; status?: string };
    console.log('[video] Task created:', JSON.stringify(data));

    const taskId = data?.id;
    if (!taskId) {
      res.status(500).json({ error: 'No task ID in response' });
      return;
    }

    res.status(200).json({ taskId, status: data.status ?? 'queued' });
  } catch (err) {
    console.error('[video] Create error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Video task creation failed' });
    }
  }
}

/**
 * GET /api/video/status/:taskId
 * Proxy task status from LaoZhang.
 */
export async function videoStatusHandler(req: Request, res: Response): Promise<void> {
  const taskId = req.params.taskId;
  if (!taskId) { res.status(400).json({ error: 'Missing taskId' }); return; }
  if (!LAOZHANG_API_KEY) { res.status(500).json({ error: 'API key not configured' }); return; }

  try {
    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos/${taskId}`, {
      headers: { Authorization: `Bearer ${LAOZHANG_API_KEY}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: errText || `Upstream error: ${response.status}` });
      return;
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    console.error('[video] Status error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Status check failed' });
    }
  }
}

/**
 * GET /api/video/result/:taskId
 * Fetch /content from LaoZhang. The endpoint may return JSON (with a `url` field)
 * or raw MP4 binary — we handle both.
 */
export async function videoResultHandler(req: Request, res: Response): Promise<void> {
  const taskId = req.params.taskId;
  if (!taskId) { res.status(400).json({ error: 'Missing taskId' }); return; }
  if (!LAOZHANG_API_KEY) { res.status(500).json({ error: 'API key not configured' }); return; }

  try {
    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos/${taskId}/content`, {
      headers: { Authorization: `Bearer ${LAOZHANG_API_KEY}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: errText || `Upstream error: ${response.status}` });
      return;
    }

    const ct = (response.headers.get('content-type') || '').toLowerCase();

    if (ct.includes('application/json')) {
      const data = (await response.json()) as { url?: string; duration?: number; resolution?: string };
      res.status(200).json(data);
      return;
    }

    // Raw binary (MP4) — stream it through to client
    res.setHeader('Content-Type', ct || 'video/mp4');
    const cl = response.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    res.setHeader('Content-Disposition', 'inline; filename="kreator-video.mp4"');

    const reader = response.body?.getReader();
    if (!reader) { res.status(500).json({ error: 'No response body' }); return; }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[video] Result error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Video content failed' });
    }
  }
}
