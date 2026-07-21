const express = require('express');
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const { verifyJWT, requireRole } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const router = express.Router();

router.use(verifyJWT);

const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'storage', 'screenshots');

/**
 * Verify JWT from query param (for streaming downloads where headers can't be set).
 */
function verifyTokenFromQuery(req, res, next) {
  // Already authenticated via verifyJWT middleware — just pass through
  if (req.user) return next();

  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

/**
 * @swagger
 * /api/evidence:
 *   get:
 *     tags: [Evidence]
 *     summary: Get all evidence with tags and metadata
 *     security:
 *       - bearerAuth: []
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sq.id, sq.search_query, sq.target_url, sq.screenshot_path,
              sq.sha256_hash, sq.method, sq.completed_at, sq.created_at,
              COALESCE(
                (SELECT json_agg(et.tag) FROM evidence_tags et WHERE et.evidence_id = sq.id),
                '[]'::json
              ) AS tags
       FROM scraping_queue sq
       WHERE sq.status = 'COMPLETED' AND sq.screenshot_path IS NOT NULL
       ORDER BY sq.completed_at DESC`
    );

    res.json({ evidences: result.rows });
  } catch (err) {
    console.error('Get evidences error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/evidence/{id}:
 *   get:
 *     tags: [Evidence]
 *     summary: Get single evidence with full metadata
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT sq.id, sq.search_query, sq.target_url, sq.screenshot_path,
              sq.sha256_hash, sq.method, sq.completed_at, sq.created_at,
              COALESCE(
                (SELECT json_agg(et.tag) FROM evidence_tags et WHERE et.evidence_id = sq.id),
                '[]'::json
              ) AS tags
       FROM scraping_queue sq
       WHERE sq.id = $1 AND sq.status = 'COMPLETED'`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evidence not found.' });
    }

    res.json({ evidence: result.rows[0] });
  } catch (err) {
    console.error('Get evidence error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/evidence/{id}/tags:
 *   post:
 *     tags: [Evidence]
 *     summary: Add a tag to evidence
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/tags', requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const { id } = req.params;
    const { tag } = req.body;

    if (!tag || !tag.trim()) {
      return res.status(400).json({ error: 'Tag is required.' });
    }

    const normalizedTag = tag.trim().toLowerCase();

    // Verify evidence exists
    const evResult = await pool.query(
      'SELECT id FROM scraping_queue WHERE id = $1 AND status = $2',
      [id, 'COMPLETED']
    );
    if (evResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evidence not found.' });
    }

    await pool.query(
      `INSERT INTO evidence_tags (evidence_id, tag)
       VALUES ($1, $2)
       ON CONFLICT (evidence_id, tag) DO NOTHING`,
      [id, normalizedTag]
    );

    // Return updated tags
    const tagsResult = await pool.query(
      'SELECT tag FROM evidence_tags WHERE evidence_id = $1 ORDER BY tag',
      [id]
    );

    res.json({ tags: tagsResult.rows.map((r) => r.tag) });
  } catch (err) {
    console.error('Add tag error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/evidence/{id}/tags/{tag}:
 *   delete:
 *     tags: [Evidence]
 *     summary: Remove a tag from evidence
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id/tags/:tag', requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const { id, tag } = req.params;
    const normalizedTag = decodeURIComponent(tag).trim().toLowerCase();

    await pool.query(
      'DELETE FROM evidence_tags WHERE evidence_id = $1 AND tag = $2',
      [id, normalizedTag]
    );

    const tagsResult = await pool.query(
      'SELECT tag FROM evidence_tags WHERE evidence_id = $1 ORDER BY tag',
      [id]
    );

    res.json({ tags: tagsResult.rows.map((r) => r.tag) });
  } catch (err) {
    console.error('Remove tag error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/evidence/tags:
 *   get:
 *     tags: [Evidence]
 *     summary: Get all distinct tags
 *     security:
 *       - bearerAuth: []
 */
router.get('/tags/all', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT tag FROM evidence_tags ORDER BY tag'
    );
    res.json({ tags: result.rows.map((r) => r.tag) });
  } catch (err) {
    console.error('Get tags error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * @swagger
 * /api/evidence/download:
 *   get:
 *     tags: [Evidence]
 *     summary: Bulk download evidence as ZIP
 *     security:
 *       - bearerAuth: []
 */
router.get('/download/bulk', verifyTokenFromQuery, requireRole('Admin', 'Analyst'), async (req, res) => {
  try {
    const ids = req.query.ids
      ? req.query.ids.split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean)
      : null;

    let query = `SELECT id, search_query, target_url, screenshot_path
                 FROM scraping_queue
                 WHERE status = 'COMPLETED' AND screenshot_path IS NOT NULL`;
    const params = [];

    if (ids && ids.length > 0) {
      query += ` AND id = ANY($1)`;
      params.push(ids);
    }

    query += ' ORDER BY completed_at DESC';

    const result = await pool.query(query, params);
    const rows = result.rows;

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No evidence to download.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-guard-evidence-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => res.status(500).json({ error: err.message }));
    archive.pipe(res);

    for (const row of rows) {
      const filename = path.basename(row.screenshot_path);
      const filePath = path.join(SCREENSHOT_DIR, filename);

      if (fs.existsSync(filePath)) {
        const safeName = `${row.id}_${filename}`.replace(/[^a-zA-Z0-9._-]/g, '_');
        archive.file(filePath, { name: safeName });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('Bulk download error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
