import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { generateHandler } from './routes/generate.js';
import { enhancePromptHandler } from './routes/enhance-prompt.js';

const app = express();
const PORT = process.env.PORT || 3000;

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

const corsOrigins = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) || [
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use(
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'kreator-backend' });
});

// API routes (same paths as Vercel for frontend compatibility)
app.post('/api/generate', generateHandler);
app.post('/api/enhance-prompt', enhancePromptHandler);

app.listen(PORT, () => {
  console.log(`[start] kreator-backend listening on port ${PORT}`);
  console.log(`[start] CORS origins: ${corsOrigins.join(', ')}`);
});
