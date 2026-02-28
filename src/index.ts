import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { generateHandler, generateStatusHandler } from './routes/generate.js';
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

app.use(
  cors({
    origin: true,
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

app.listen(PORT, () => {
  console.log(`[start] kreator-backend listening on port ${PORT}`);
});
