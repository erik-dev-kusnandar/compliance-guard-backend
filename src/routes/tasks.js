const express = require('express');
const pool = require('../config/db');
const { verifyJWT } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(verifyJWT);

/**
 * @swagger
 * /api/tasks:
 *   post:
 *     tags: [Tasks]
 *     summary: Create scraping tasks
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [keyword]
 *             properties:
 *               keyword:
 *                 type: string
 *                 description: Search keyword for scraping
 *                 example: compliance regulation
 *               pages:
 *                 type: integer
 *                 description: Number of pages to scrape
 *                 default: 1
 *                 example: 3
 *     responses:
 *       201:
 *         description: Tasks added to queue
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: 3 task(s) added to queue
 *                 tasks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Task'
 *       400:
 *         description: Keyword is required
 *       401:
 *         description: Unauthorized - invalid or missing token
 */
router.post('/', async (req, res) => {
  try {
    const { keyword, pages = 1 } = req.body;

    if (!keyword) {
      return res.status(400).json({ error: 'Keyword is required.' });
    }

    // Mock Google Search extraction - generate dummy target URLs
    const tasks = [];
    for (let i = 1; i <= pages; i++) {
      const targetUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&page=${i}`;
      const searchQuery = `${keyword} - page ${i}`;

      try {
        const result = await pool.query(
          `INSERT INTO scraping_queue (search_query, target_url, status)
           VALUES ($1, $2, 'PENDING')
           ON CONFLICT (target_url) DO NOTHING
           RETURNING id, search_query, target_url, status, created_at`,
          [searchQuery, targetUrl]
        );

        if (result.rows.length > 0) {
          tasks.push(result.rows[0]);
        }
      } catch (insertErr) {
        console.error('Error inserting task:', insertErr.message);
      }
    }

    res.status(201).json({
      message: `${tasks.length} task(s) added to queue`,
      tasks,
    });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/tasks/queue-status:
 *   get:
 *     tags: [Tasks]
 *     summary: Get queue status counts
 *     description: Returns aggregated task counts grouped by status
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Queue status counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queue_status:
 *                   $ref: '#/components/schemas/QueueStatus'
 *       401:
 *         description: Unauthorized - invalid or missing token
 */
router.get('/queue-status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, COUNT(*)::INTEGER as count
       FROM scraping_queue
       GROUP BY status`
    );

    // Format as object for easy consumption
    const statusCounts = {
      PENDING: 0,
      PROCESSING: 0,
      COMPLETED: 0,
      FAILED: 0,
    };

    result.rows.forEach((row) => {
      statusCounts[row.status] = row.count;
    });

    res.json({ queue_status: statusCounts });
  } catch (err) {
    console.error('Queue status error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/tasks/evidences:
 *   get:
 *     tags: [Tasks]
 *     summary: Get completed tasks with screenshots
 *     description: Returns list of completed tasks with their screenshot paths
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of evidences
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 evidences:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Evidence'
 *       401:
 *         description: Unauthorized - invalid or missing token
 */
router.get('/evidences', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, search_query, target_url, screenshot_path, completed_at, created_at
       FROM scraping_queue
       WHERE status = 'COMPLETED'
       ORDER BY completed_at DESC`
    );

    res.json({ evidences: result.rows });
  } catch (err) {
    console.error('Evidences error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
