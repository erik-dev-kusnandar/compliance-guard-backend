const express = require('express');
const cron = require('node-cron');
const pool = require('../config/db');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { loadScheduledTasks, computeNextRun } = require('../services/scheduler');
const { auditLog } = require('../services/audit');

const router = express.Router();

router.use(verifyJWT);

const VALID_METHODS = ['API', 'MIMIC', 'HYBRID'];

/**
 * @swagger
 * /api/scheduled-tasks:
 *   get:
 *     tags: [Scheduled Tasks]
 *     summary: Get all scheduled tasks
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of scheduled tasks
 */
router.get('/', requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT st.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM scheduled_task_history h WHERE h.scheduled_task_id = st.id) AS total_runs,
              (SELECT COUNT(*) FROM scheduled_task_history h WHERE h.scheduled_task_id = st.id AND h.status = 'COMPLETED') AS successful_runs,
              (SELECT COUNT(*) FROM scheduled_task_history h WHERE h.scheduled_task_id = st.id AND h.status = 'FAILED') AS failed_runs
       FROM scheduled_tasks st
       LEFT JOIN users u ON st.created_by = u.id
       ORDER BY st.created_at DESC`
    );
    res.json({ scheduled_tasks: result.rows });
  } catch (err) {
    console.error('Get scheduled tasks error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/scheduled-tasks:
 *   post:
 *     tags: [Scheduled Tasks]
 *     summary: Create a scheduled task
 *     security:
 *       - bearerAuth: []
 */
router.post('/', requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const { name, keyword, pages = 1, method = 'API', headless = false, proxy = null, cron_expression, tab_delay_min = 1, tab_delay_max = 3 } = req.body;

    if (!name || !keyword || !cron_expression) {
      return res.status(400).json({ error: 'Name, keyword, and cron_expression are required.' });
    }

    if (!cron.validate(cron_expression)) {
      return res.status(400).json({ error: `Invalid cron expression: "${cron_expression}". Format: minute hour day-of-month month day-of-week.` });
    }

    const upperMethod = method.toUpperCase();
    if (!VALID_METHODS.includes(upperMethod)) {
      return res.status(400).json({ error: `Invalid method "${method}". Must be one of: ${VALID_METHODS.join(', ')}` });
    }

    if (pages < 1 || pages > 5) {
      return res.status(400).json({ error: 'Pages must be between 1 and 5.' });
    }

    const result = await pool.query(
      `INSERT INTO scheduled_tasks (name, keyword, pages, method, headless, proxy, cron_expression, tab_delay_min, tab_delay_max, created_by, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       RETURNING *`,
      [name, keyword, pages, upperMethod, headless, proxy || null, cron_expression, tab_delay_min, tab_delay_max, req.user.id]
    );

    await loadScheduledTasks();

    res.status(201).json({ message: 'Scheduled task created successfully', scheduled_task: result.rows[0] });

    auditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'SCHEDULED_TASK_CREATE',
      targetType: 'scheduled_task',
      targetId: String(result.rows[0].id),
      metadata: { name, keyword, method: upperMethod, cron_expression, tab_delay_min, tab_delay_max },
      ipAddress: req.ip,
    });
  } catch (err) {
    console.error('Create scheduled task error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/scheduled-tasks/{id}:
 *   put:
 *     tags: [Scheduled Tasks]
 *     summary: Update a scheduled task
 *     security:
 *       - bearerAuth: []
 */
router.put('/:id', requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, keyword, pages, method, headless, proxy, cron_expression, enabled } = req.body;

    const existing = await pool.query('SELECT * FROM scheduled_tasks WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Scheduled task not found.' });
    }

    if (cron_expression && !cron.validate(cron_expression)) {
      return res.status(400).json({ error: `Invalid cron expression: "${cron_expression}".` });
    }

    const current = existing.rows[0];
    const updatedName = name ?? current.name;
    const updatedKeyword = keyword ?? current.keyword;
    const updatedPages = pages ?? current.pages;
    const updatedMethod = method ? method.toUpperCase() : current.method;
    const updatedHeadless = headless ?? current.headless;
    const updatedProxy = proxy !== undefined ? (proxy || null) : current.proxy;
    const updatedCron = cron_expression ?? current.cron_expression;
    const updatedEnabled = enabled ?? current.enabled;

    const result = await pool.query(
      `UPDATE scheduled_tasks
       SET name = $1, keyword = $2, pages = $3, method = $4, headless = $5, proxy = $6,
           cron_expression = $7, enabled = $8, updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [updatedName, updatedKeyword, updatedPages, updatedMethod, updatedHeadless, updatedProxy, updatedCron, updatedEnabled, id]
    );

    await loadScheduledTasks();

    res.json({ message: 'Scheduled task updated successfully', scheduled_task: result.rows[0] });

    auditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'SCHEDULED_TASK_UPDATE',
      targetType: 'scheduled_task',
      targetId: id,
      metadata: { name: updatedName, enabled: updatedEnabled, cron_expression: updatedCron },
      ipAddress: req.ip,
    });
  } catch (err) {
    console.error('Update scheduled task error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/scheduled-tasks/{id}/toggle:
 *   post:
 *     tags: [Scheduled Tasks]
 *     summary: Toggle pause/resume a scheduled task
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/toggle', requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM scheduled_tasks WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Scheduled task not found.' });
    }

    const newEnabled = !existing.rows[0].enabled;
    const result = await pool.query(
      `UPDATE scheduled_tasks SET enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [newEnabled, id]
    );

    await loadScheduledTasks();

    const action = newEnabled ? 'Resumed' : 'Paused';
    res.json({ message: `Scheduled task ${action.toLowerCase()} successfully`, scheduled_task: result.rows[0] });

    auditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'SCHEDULED_TASK_TOGGLE',
      targetType: 'scheduled_task',
      targetId: id,
      metadata: { name: existing.rows[0].name, enabled: newEnabled },
      ipAddress: req.ip,
    });
  } catch (err) {
    console.error('Toggle scheduled task error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/scheduled-tasks/{id}:
 *   delete:
 *     tags: [Scheduled Tasks]
 *     summary: Delete a scheduled task
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM scheduled_tasks WHERE id = $1 RETURNING name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Scheduled task not found.' });
    }

    await loadScheduledTasks();

    res.json({ message: 'Scheduled task deleted successfully' });

    auditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'SCHEDULED_TASK_DELETE',
      targetType: 'scheduled_task',
      targetId: id,
      metadata: { name: result.rows[0].name },
      ipAddress: req.ip,
    });
  } catch (err) {
    console.error('Delete scheduled task error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/scheduled-tasks/{id}/history:
 *   get:
 *     tags: [Scheduled Tasks]
 *     summary: Get execution history for a scheduled task
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id/history', requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const existing = await pool.query('SELECT id FROM scheduled_tasks WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Scheduled task not found.' });
    }

    const result = await pool.query(
      `SELECT * FROM scheduled_task_history
       WHERE scheduled_task_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [id, limit]
    );

    res.json({ history: result.rows });
  } catch (err) {
    console.error('Get scheduled task history error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
