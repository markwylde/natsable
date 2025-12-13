import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createCertificateRouter } from './routes/certificates.ts';
import { createNatsRouter } from './routes/nats.ts';
import { createUsersRouter } from './routes/users.ts';
import { createKvRouter } from './routes/kv.ts';
import { createJetstreamRouter } from './routes/jetstream.ts';
import { createStatsCollector } from './statsCollector.ts';
import { createAuthRouter } from './routes/auth.ts';
import { authMiddleware } from './middleware/auth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const NATS_MONITORING_URL = process.env.NATS_MONITORING_URL || 'http://localhost:8223';
const NATS_URL = process.env.NATS_URL || 'localhost:4223';
const NATS_TLS_ENABLED = process.env.NATS_TLS_ENABLED === 'true';
const CERTS_DIR = process.env.CERTS_DIR || join(__dirname, '..', 'certs');
const CONFIG_DIR = process.env.CONFIG_DIR || join(__dirname, '..', 'config');

// Create and start stats collector
const statsCollector = createStatsCollector(NATS_MONITORING_URL);
statsCollector.start();

// Middleware
app.use(express.json({ limit: '10mb' })); // Increase limit for key/cert uploads
app.use(express.static(join(__dirname, 'public')));

// Auth routes (before auth middleware)
app.use('/api/auth', createAuthRouter(CERTS_DIR));

// Auth middleware - protects all other API routes
app.use(authMiddleware);

// API Routes
app.use('/api/nats', createNatsRouter(NATS_MONITORING_URL, NATS_URL, NATS_TLS_ENABLED, CERTS_DIR));
app.use('/api/certificates', createCertificateRouter(CERTS_DIR));
app.use('/api/users', createUsersRouter(CONFIG_DIR, CERTS_DIR));
app.use('/api/kv', createKvRouter(NATS_URL, CERTS_DIR));
app.use('/api/jetstream', createJetstreamRouter(NATS_URL, CERTS_DIR));

// Stats history endpoint
app.get('/api/stats/history', (req, res) => {
  // Default to last 24 hours worth of data, or use ?seconds=N query param
  const maxSeconds = req.query.seconds ? parseInt(req.query.seconds as string) : 24 * 60 * 60;
  const history = statsCollector.getHistory(maxSeconds);
  res.json({
    summary: statsCollector.getSummary(),
    data: history
  });
});

app.get('/api/stats/summary', (req, res) => {
  res.json(statsCollector.getSummary());
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend for all other routes (Express 5 syntax)
app.get('/{*path}', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Natsable server running on http://localhost:${PORT}`);
  console.log(`NATS URL: ${NATS_URL}`);
  console.log(`NATS Monitoring URL: ${NATS_MONITORING_URL}`);
  console.log(`Certificates directory: ${CERTS_DIR}`);
});
