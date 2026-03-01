# Kreator Backend

Backend API for Kreator image generation. Handles LaoZhang API calls for image generation and prompt enhancement. Hosted on Heroku to avoid Vercel's 4.5MB request body limit—especially important when using reference images.

## Architecture

- **Frontend (Vercel)** → calls this backend
- **Backend (Heroku)** → calls LaoZhang API
- **Supabase** → auth, storage (generated images + reference images)

Reference images are uploaded to Supabase Storage first; the backend fetches them via URL. This keeps request payloads small and scalable.

## Setup

### 1. Install dependencies

```bash
cd kreator-backend
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env` and set:

- `LAOZHANG_API_KEY` – your LaoZhang API key (required)
- `LAOZHANG_API_URL` – default `https://api.laozhang.ai`
- `CORS_ORIGINS` – comma-separated frontend origins, e.g. `https://your-app.vercel.app,http://localhost:5173`
- `ENHANCE_PROMPT_MODEL` – optional, default `gpt-4o-mini`
- `SUPABASE_URL` – your Supabase project URL (for uploading generated images and persisting jobs)
- `SUPABASE_SERVICE_ROLE_KEY` – Supabase service role key (bypasses RLS for server uploads)

Without Supabase vars, the backend falls back to returning base64 in the JSON response (can cause "Failed to fetch" for large images). **Jobs require Supabase**—without it, generation will fail.

### Supabase: generation_jobs table

Run the migration in Supabase SQL Editor (see `../imagegenprivate/supabase-jobs.sql`):

```sql
CREATE TABLE IF NOT EXISTS public.generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  result jsonb,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.generation_jobs ENABLE ROW LEVEL SECURITY;
```

Jobs persist across dyno restarts and deploys.

### 3. Run locally

```bash
npm run dev
```

API base: `http://localhost:3000`

### 4. Deploy to Heroku

```bash
heroku create kreator-backend
heroku config:set LAOZHANG_API_KEY=sk-your-key
heroku config:set CORS_ORIGINS=https://your-app.vercel.app
git push heroku main
```

Or connect the GitHub repo in Heroku Dashboard and add Config Vars there.

### 5. Point frontend to backend

In your frontend `.env` (or Vercel env vars):

```
VITE_API_BASE_URL=https://kreator-backend-xxx.herokuapp.com
```

Leave empty to use same-origin (Vercel API routes).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/generate` | Start generation (returns 202 + jobId) |
| GET | `/api/generate/status/:jobId` | Poll for job result |
| POST | `/api/enhance-prompt` | Enhance prompt via LaoZhang |

### POST /api/generate

Body:

```json
{
  "prompt": "string",
  "aspectRatio": "3:2",
  "imageSize": "1K",
  "referenceImages": ["base64..."],
  "referenceImageUrls": ["https://..."]
}
```

- Use `referenceImageUrls` when reference images are already uploaded to Supabase. The backend fetches them and avoids large payloads.
- Use `referenceImages` (base64) as fallback; body limit is 50MB.

### POST /api/enhance-prompt

Body:

```json
{
  "prompt": "string"
}
```

## Supabase Storage for References

The frontend uploads reference images to the `generated-images` bucket under the `refs/` path. If you use RLS on storage, ensure your policies allow uploads to `refs/*`. The backend fetches from the public URLs returned by Supabase.
