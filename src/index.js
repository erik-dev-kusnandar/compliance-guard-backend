const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { swaggerUi, swaggerSpec } = require('./swagger');
const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');
const userRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const auditRoutes = require('./routes/audit');
const evidenceRoutes = require('./routes/evidence');
const scheduledTaskRoutes = require('./routes/scheduled-tasks');
const { loadScheduledTasks } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8080', 'http://127.0.0.1:8080'],
  credentials: true,
}));
app.use(express.json());

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Compliance Guard API Docs',
}));

// Static file serving for screenshots
app.use('/storage', express.static(path.join(__dirname, '..', 'storage')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/evidence', evidenceRoutes);
app.use('/api/scheduled-tasks', scheduledTaskRoutes);

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, async () => {
  console.log(`Compliance Guard API server running on port ${PORT}`);
  console.log(`Screenshots served from: /storage`);
  try {
    await loadScheduledTasks();
  } catch (err) {
    console.error('Failed to load scheduled tasks:', err.message);
  }
});

module.exports = app;
