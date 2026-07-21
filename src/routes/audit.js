const express = require('express');
const pool = require('../config/db');
const { verifyJWT, requireRole } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication + Admin role
router.use(verifyJWT);
router.use(requireRole('Admin'));

/**
 * @swagger
 * /api/audit:
 *   get:
 *     tags: [Audit]
 *     summary: Get audit log entries (Admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: user_id
 *         schema:
 *           type: integer
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *     responses:
 *       200:
 *         description: Paginated audit log entries
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const days = parseInt(req.query.days, 10) || 30;
    const userId = parseInt(req.query.user_id, 10) || null;
    const action = req.query.action || null;

    const conditions = [`al.created_at >= NOW() - INTERVAL '1 day' * $1`];
    const params = [days];
    let paramIdx = 2;

    if (userId) {
      conditions.push(`al.user_id = $${paramIdx}`);
      params.push(userId);
      paramIdx++;
    }

    if (action) {
      conditions.push(`al.action = $${paramIdx}`);
      params.push(action);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // Count total
    const countResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total FROM audit_log al WHERE ${whereClause}`,
      params
    );
    const total = countResult.rows[0].total;

    // Fetch page
    const dataResult = await pool.query(
      `SELECT al.id, al.user_id, al.user_email, al.action, al.target_type,
              al.target_id, al.metadata, al.ip_address, al.created_at
       FROM audit_log al
       WHERE ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({
      entries: dataResult.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('Get audit log error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/audit/actions:
 *   get:
 *     tags: [Audit]
 *     summary: Get distinct action types for filter dropdown
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of distinct actions
 */
router.get('/actions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT action FROM audit_log ORDER BY action`
    );
    res.json({ actions: result.rows.map((r) => r.action) });
  } catch (err) {
    console.error('Get audit actions error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
