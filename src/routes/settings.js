const express = require('express');
const pool = require('../config/db');
const { verifyJWT, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/settings - Get all settings (Admin only)
router.get('/', verifyJWT, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value, updated_at FROM system_settings ORDER BY key');
    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = {
        value: row.value,
        updated_at: row.updated_at,
      };
    }
    res.json({ settings });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings - Update settings (Admin only)
router.put('/', verifyJWT, requireRole('Admin'), async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Settings object is required.' });
  }

  try {
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value !== 'string') continue;
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
    res.json({ message: 'Settings updated successfully.' });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/settings/public - Public settings (no auth required, for registration check)
router.get('/public', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM system_settings WHERE key = 'self_registration'"
    );
    const selfRegistration = result.rows[0]?.value === 'true';
    res.json({ self_registration: selfRegistration });
  } catch (err) {
    // If table doesn't exist, default to allowing registration
    res.json({ self_registration: true });
  }
});

module.exports = router;
