import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { generateHandler, generateStatusHandler } from './routes/generate.js';
import { enhancePromptHandler } from './routes/enhance-prompt.js';
import { videoGenerateHandler, videoStatusHandler, videoResultHandler } from './routes/video.js';
import { stripeWebhookHandler } from './routes/stripe-webhook.js';
import { stripePortalHandler } from './routes/stripe-portal.js';
const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Heroku, etc.) so req.protocol is correct for proxy URLs
app.set('trust proxy', 1);

// Stripe webhook needs raw body for signature verification — must be before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// 50MB limit - handles large base64 reference images (Vercel's 4.5MB was the bottleneck)
app.use(express.json({ limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[request] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const ALLOWED_ORIGINS = [
  'https://www.kreator.vision',
  'https://kreator.vision',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : []),
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  })
);

// Root - friendly message when visiting in browser
app.get('/', (_req, res) => {
  res.json({ service: 'kreator-backend', status: 'ok', health: '/health' });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'kreator-backend' });
});

// API routes (same paths as Vercel for frontend compatibility)
app.post('/api/generate', generateHandler);
app.get('/api/generate/status/:jobId', generateStatusHandler);
app.post('/api/enhance-prompt', enhancePromptHandler);
app.post('/api/video/generate', videoGenerateHandler);
app.get('/api/video/status/:taskId', videoStatusHandler);
app.get('/api/video/result/:taskId', videoResultHandler);
app.post('/api/stripe/portal', stripePortalHandler);

app.listen(PORT, () => {
  console.log(`[start] kreator-backend listening on port ${PORT}`);
});
