const express = require('express');
const pool = require('../config/db');
const { verifyJWT } = require('../middleware/auth');
const { searchGoogleAPI, validateGoogleCredentials } = require('../services/google-api');
const { searchGoogleMimic } = require('../services/google-mimic');

const router = express.Router();

// All routes require authentication
router.use(verifyJWT);

const VALID_METHODS = ['API', 'MIMIC', 'HYBRID'];

async function upsertTargetUrl(client, searchQuery, targetUrl, method) {
  const existing = await client.query(
    `SELECT id, status FROM scraping_queue WHERE target_url = $1`,
    [targetUrl]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.status === 'COMPLETED' || row.status === 'FAILED') {
      await client.query(
        `UPDATE scraping_queue
         SET status = 'PENDING',
             method = $1,
             screenshot_path = NULL,
             completed_at = NULL,
             error_message = NULL,
             retry_count = 0,
             locked_at = NULL
         WHERE id = $2`,
        [method, row.id]
      );
      const updated = await client.query(
        `SELECT id, search_query, target_url, status, method, created_at
         FROM scraping_queue WHERE id = $1`,
        [row.id]
      );
      return updated.rows[0];
    }
    return null;
  }

  const result = await client.query(
    `INSERT INTO scraping_queue (search_query, target_url, status, method)
     VALUES ($1, $2, 'PENDING', $3)
     RETURNING id, search_query, target_url, status, method, created_at`,
    [searchQuery, targetUrl, method]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

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
 *                 description: Number of pages to scrape (1-5)
 *                 default: 1
 *                 example: 3
 *               method:
 *                 type: string
 *                 enum: [API, MIMIC, HYBRID]
 *                 description: |
 *                   Search execution mode:
 *                   - API: Google Custom Search API (fast, safe, requires GOOGLE_API_KEY + GOOGLE_CX_ID)
 *                   - MIMIC: Playwright browser automation (scrapes Google directly, no API key needed)
 *                   - HYBRID: Google API for URLs + Playwright for screenshots (requires API keys)
 *                 default: API
 *               headless:
 *                 type: boolean
 *                 description: |
 *                   Browser headless mode (MIMIC/HYBRID only):
 *                   - false: Opens visible browser window (default, best for anti-detection)
 *                   - true: Uses headless mode (hidden browser window)
 *                 default: false
 *               proxy:
 *                 type: string
 *                 nullable: true
 *                 description: |
 *                   Proxy URL for MIMIC mode (routes browser traffic through proxy):
 *                   - SOCKS5: socks5://127.0.0.1:1080
 *                   - HTTP: http://user:pass@host:port
 *                   - null: No proxy, uses server IP directly
 *                 example: socks5://127.0.0.1:1080
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
 *                   example: 10 URL(s) found via API and added to queue
 *                 method:
 *                   type: string
 *                   example: API
 *                 tasks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Task'
 *       400:
 *         description: Invalid input or missing API credentials
 *       401:
 *         description: Unauthorized - invalid or missing token
 */
router.post('/', async (req, res) => {
  try {
    const { keyword, pages = 1, method = 'API', headless = false, proxy = null } = req.body;

    if (!keyword) {
      return res.status(400).json({ error: 'Keyword is required.' });
    }

    const upperMethod = method.toUpperCase();
    if (!VALID_METHODS.includes(upperMethod)) {
      return res.status(400).json({
        error: `Invalid method "${method}". Must be one of: ${VALID_METHODS.join(', ')}`,
      });
    }

    if ((upperMethod === 'API' || upperMethod === 'HYBRID') && !validateGoogleCredentials().valid) {
      return res.status(400).json({
        error: `GOOGLE_API_KEY and GOOGLE_CX_ID must be set in .env for ${upperMethod} mode. Use MIMIC mode instead.`,
      });
    }

    let urls = [];
    let mimicEvidence = [];

    if (upperMethod === 'MIMIC') {
      console.log(`[Tasks] Starting MIMIC search for "${keyword}" (${pages} pages, headless: ${headless}, proxy: ${proxy || 'none'})...`);
      mimicEvidence = await searchGoogleMimic(keyword, pages, { headless, proxy });
      console.log(`[Tasks] MIMIC captured ${mimicEvidence.length} screenshots`);
    } else {
      console.log(`[Tasks] Starting ${upperMethod} search for "${keyword}" (${pages} pages)...`);
      urls = await searchGoogleAPI(keyword, pages);
      console.log(`[Tasks] ${upperMethod} found ${urls.length} URLs`);
    }

    // MIMIC mode: insert directly as COMPLETED with screenshots
    if (upperMethod === 'MIMIC') {
      if (mimicEvidence.length === 0) {
        return res.status(200).json({
          message: `No results captured for "${keyword}" using MIMIC mode`,
          method: upperMethod,
          tasks: [],
        });
      }

      const tasks = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of mimicEvidence) {
          try {
            // Upsert: if URL exists and is COMPLETED/FAILED, reset; else insert new
            const existing = await client.query(
              `SELECT id, status FROM scraping_queue WHERE target_url = $1`, [item.url]
            );
            if (existing.rows.length > 0) {
              const row = existing.rows[0];
              if (row.status === 'COMPLETED' || row.status === 'FAILED') {
                await client.query(
                  `UPDATE scraping_queue SET status = 'COMPLETED', method = $1,
                   screenshot_path = $2, completed_at = NOW(), error_message = NULL,
                   retry_count = 0, locked_at = NULL WHERE id = $3`,
                  [upperMethod, item.screenshotPath, row.id]
                );
                const updated = await client.query(
                  `SELECT id, search_query, target_url, status, method, created_at FROM scraping_queue WHERE id = $1`,
                  [row.id]
                );
                tasks.push(updated.rows[0]);
              }
            } else {
              const result = await client.query(
                `INSERT INTO scraping_queue (search_query, target_url, status, method, screenshot_path, completed_at)
                 VALUES ($1, $2, 'COMPLETED', $3, $4, NOW())
                 RETURNING id, search_query, target_url, status, method, created_at`,
                [keyword, item.url, upperMethod, item.screenshotPath]
              );
              if (result.rows.length > 0) tasks.push(result.rows[0]);
            }
          } catch (insertErr) {
            console.error('Error inserting MIMIC task:', insertErr.message);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return res.status(201).json({
        message: `${tasks.length} screenshot(s) captured via MIMIC for "${keyword}"`,
        method: upperMethod,
        tasks,
      });
    }

    // API / HYBRID mode: insert as PENDING for worker to screenshot
    if (urls.length === 0) {
      return res.status(200).json({
        message: `No URLs found for "${keyword}" using ${upperMethod} mode`,
        method: upperMethod,
        tasks: [],
      });
    }

    const tasks = [];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const url of urls) {
        try {
          const task = await upsertTargetUrl(client, keyword, url, upperMethod);
          if (task) {
            tasks.push(task);
          }
        } catch (insertErr) {
          console.error('Error inserting task:', insertErr.message);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      message: `${tasks.length} URL(s) found via ${upperMethod} and added to queue`,
      method: upperMethod,
      tasks,
    });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/tasks:
 *   get:
 *     tags: [Tasks]
 *     summary: Get all tasks
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of tasks
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, search_query, target_url, status, method, screenshot_path, completed_at, created_at
       FROM scraping_queue
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json({ tasks: result.rows });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/tasks/clear-completed:
 *   delete:
 *     tags: [Tasks]
 *     summary: Clear completed and failed tasks
 *     security:
 *       - bearerAuth: []
 */
router.delete('/clear-completed', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM scraping_queue WHERE status IN ('COMPLETED', 'FAILED')`
    );
    res.json({ message: `${result.rowCount} task(s) cleared`, count: result.rowCount });
  } catch (err) {
    console.error('Clear completed error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/tasks/{id}:
 *   delete:
 *     tags: [Tasks]
 *     summary: Delete a single task by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Task ID to delete
 *     responses:
 *       200:
 *         description: Task deleted successfully
 *       404:
 *         description: Task not found
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM scraping_queue WHERE id = $1 RETURNING id, search_query, target_url, status`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    res.json({ message: 'Task deleted successfully', task: result.rows[0] });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/tasks/queue-status:
 *   get:
 *     tags: [Tasks]
 *     summary: Get queue status counts
 *     security:
 *       - bearerAuth: []
 */
router.get('/queue-status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, COUNT(*)::INTEGER as count
       FROM scraping_queue
       GROUP BY status`
    );

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
 *     security:
 *       - bearerAuth: []
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
