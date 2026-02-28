import type { Request, Response } from 'express';

const LAOZHANG_API_KEY = process.env.LAOZHANG_API_KEY;
const LAOZHANG_API_URL = process.env.LAOZHANG_API_URL || 'https://api.laozhang.ai';
const ENHANCE_MODEL = process.env.ENHANCE_PROMPT_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are an expert prompt enhancer for AI image generation.

Your job is to rewrite user prompts into clear, structured, high-quality image generation prompts.

CORE RULES:

1. Preserve the user's intent exactly.
- Do NOT change the subject, style, or concept.
- Only improve clarity, specificity, and visual control.

2. Write prompts for image models, not humans.
- Use concise visual language.
- Avoid storytelling, emotional fluff, or poetic wording.
- Every word must influence the image visually.

3. Always enhance using this structure when possible:
SUBJECT → ENVIRONMENT → COMPOSITION → CAMERA → LIGHTING → STYLE → QUALITY

4. Add missing professional visual details when not provided:
- camera/lens terms (macro, 35mm, 50mm, 85mm, wide-angle, close-up)
- composition (close-up, medium shot, low angle, overhead, centered framing)
- lighting (soft directional light, studio lighting, cinematic lighting, rim light)
- depth cues (shallow depth of field, foreground, background separation)
- rendering style (photorealistic, commercial photography, cinematic, illustration)

5. Keep prompts efficient.
- Remove filler words and vague phrases.
- Replace descriptive sentences with visual tokens.

6. If reference images are mentioned:
- Preserve them explicitly.
Example:
"exact watch design from reference image clearly visible"

7. Output rules:
- Output ONE final enhanced prompt only.
- No explanations.
- No bullet points.
- No quotes.
- No markdown.

QUALITY STANDARD:
The output must resemble professional image-generation prompts used in high-end tools.`;

export async function enhancePromptHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!LAOZHANG_API_KEY || LAOZHANG_API_KEY === 'sk-YOUR_API_KEY_HERE') {
    console.error('[enhance-prompt] LAOZHANG_API_KEY not set');
    res.status(500).json({
      error: 'Server configuration error: LAOZHANG_API_KEY not set.',
    });
    return;
  }

  try {
    const body = req.body as { prompt?: string };
    const prompt = body?.prompt;

    if (!prompt || typeof prompt !== 'string') {
      console.warn('[enhance-prompt] Missing or invalid prompt');
      res.status(400).json({ error: 'Missing or invalid prompt' });
      return;
    }

    console.log(`[enhance-prompt] Request: "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`);
    const startTime = Date.now();
    const response = await fetch(`${LAOZHANG_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LAOZHANG_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ENHANCE_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
        temperature: 0.5,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = `API error: ${response.status}`;
      try {
        const errData = JSON.parse(errText) as { error?: { message?: string } | string };
        const err = errData.error;
        errMsg = String(typeof err === 'object' ? err?.message ?? errMsg : err ?? errMsg);
      } catch {
        if (errText) errMsg = errText.slice(0, 200);
      }
      console.error('[enhance-prompt] LaoZhang API error:', response.status, errMsg);
      res.status(500).json({ error: errMsg });
      return;
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let enhanced = result.choices?.[0]?.message?.content?.trim();

    if (!enhanced) {
      res.status(500).json({ error: 'No enhanced prompt returned' });
      return;
    }

    if (
      (enhanced.startsWith('"') && enhanced.endsWith('"')) ||
      (enhanced.startsWith("'") && enhanced.endsWith("'"))
    ) {
      enhanced = enhanced.slice(1, -1);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[enhance-prompt] Success (${elapsed}ms): "${enhanced.slice(0, 60)}${enhanced.length > 60 ? '...' : ''}"`);
    res.status(200).json({ enhancedPrompt: enhanced });
  } catch (error) {
    console.error('[enhance-prompt] Unexpected error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to enhance prompt',
    });
  }
}
