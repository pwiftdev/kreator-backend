import type { Request, Response } from 'express';

const LAOZHANG_API_KEY = process.env.LAOZHANG_API_KEY;
const LAOZHANG_API_URL = process.env.LAOZHANG_API_URL || 'https://api.laozhang.ai';

/** Map frontend model id to LaoZhang Async API params */
function toAsyncParams(model: string): { size: string; seconds: string } {
  switch (model) {
    case 'sora_video2-landscape':
      return { size: '1280x720', seconds: '10' };
    case 'sora_video2-15s':
      return { size: '720x1280', seconds: '15' };
    case 'sora_video2-landscape-15s':
      return { size: '1280x720', seconds: '15' };
    default:
      return { size: '720x1280', seconds: '10' };
  }
}

/** Get image buffer from URL or data URL */
async function getImageBuffer(imageUrl: string): Promise<{ buffer: Buffer; mime: string }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    const mime = match[1].trim();
    const base64 = match[2];
    const buffer = Buffer.from(base64, 'base64');
    return { buffer, mime };
  }
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': 'Kreator-Backend/1.0', Accept: 'image/*' },
  });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  return { buffer: buf, mime: contentType.split(';')[0].trim() };
}

/**
 * POST /api/video/generate
 * Create async video task (returns immediately, no 30s timeout).
 * Body: { prompt, imageUrl, model? }
 */
export async function videoGenerateHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === 'sk-YOUR_API_KEY_HERE') {
    res.status(500).json({ error: 'Server configuration error: LAOZHANG_API_KEY not set.' });
    return;
  }

  const body = req.body as { prompt?: string; imageUrl?: string; model?: string };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  const model = typeof body.model === 'string' && body.model ? body.model : 'sora_video2';

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
    const { size, seconds } = toAsyncParams(model);

    const form = new FormData();
    form.append('model', 'sora-2');
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('seconds', seconds);
    form.append('input_reference', new Blob([new Uint8Array(buffer)], { type: mime }), `image.${ext}`);

    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LAOZHANG_API_KEY}`,
      },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[video] LaoZhang create error:', response.status, errText);
      res.status(response.status).json({ error: errText || `Upstream error: ${response.status}` });
      return;
    }

    const data = (await response.json()) as { id?: string };
    const taskId = data?.id;
    if (!taskId) {
      res.status(500).json({ error: 'No task ID in response' });
      return;
    }

    res.status(200).json({ taskId });
  } catch (err) {
    console.error('[video] Create error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Video task creation failed' });
    }
  }
}

/**
 * GET /api/video/status/:taskId
 * Proxy task status from LaoZhang (for client polling).
 */
export async function videoStatusHandler(req: Request, res: Response): Promise<void> {
  const taskId = req.params.taskId;
  if (!taskId) {
    res.status(400).json({ error: 'Missing taskId' });
    return;
  }

  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === 'sk-YOUR_API_KEY_HERE') {
    res.status(500).json({ error: 'Server configuration error: LAOZHANG_API_KEY not set.' });
    return;
  }

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
 * Stream completed video from LaoZhang to client (so client doesn't need API key).
 */
export async function videoResultHandler(req: Request, res: Response): Promise<void> {
  const taskId = req.params.taskId;
  if (!taskId) {
    res.status(400).json({ error: 'Missing taskId' });
    return;
  }

  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === 'sk-YOUR_API_KEY_HERE') {
    res.status(500).json({ error: 'Server configuration error: LAOZHANG_API_KEY not set.' });
    return;
  }

  try {
    const response = await fetch(`${LAOZHANG_API_URL}/v1/videos/${taskId}/content`, {
      headers: { Authorization: `Bearer ${LAOZHANG_API_KEY}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: errText || `Upstream error: ${response.status}` });
      return;
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="kreator-video.mp4"');

    const reader = response.body?.getReader();
    if (!reader) {
      res.status(500).json({ error: 'No response body' });
      return;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[video] Result stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Video download failed' });
    }
  }
}
