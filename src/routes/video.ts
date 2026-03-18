import type { Request, Response } from 'express';

const LAOZHANG_API_KEY = process.env.LAOZHANG_API_KEY;
const LAOZHANG_API_URL = process.env.LAOZHANG_API_URL || 'https://api.laozhang.ai';

/** Sora 2 image-to-video: stream from LaoZhang /v1/chat/completions to client (SSE). */
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

  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: imageUrl } },
  ];

  try {
    const response = await fetch(`${LAOZHANG_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LAOZHANG_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        stream: true,
      }),
      signal: AbortSignal.timeout(360_000), // 6 min for video gen
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[video] LaoZhang error:', response.status, errText);
      res.status(response.status).json({ error: errText || `Upstream error: ${response.status}` });
      return;
    }

    const requestOrigin = req.get('Origin');
    if (requestOrigin) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body?.getReader();
    if (!reader) {
      res.status(500).json({ error: 'No response body' });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          res.write(line + '\n');
        }
      }
    }
    if (buffer) {
      res.write(buffer + (buffer.endsWith('\n') ? '' : '\n'));
    }
    res.end();
  } catch (err) {
    console.error('[video] Stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Video generation failed' });
    }
  }
}
