const pool = require('../config/db');

/**
 * Log an audit event.
 *
 * @param {Object} params
 * @param {number|null} params.userId - Authenticated user ID (null for unauthenticated actions)
 * @param {string|null} params.userEmail - User email for readability
 * @param {string} params.action - Action performed (e.g. 'LOGIN', 'TASK_CREATE')
 * @param {string|null} params.targetType - Type of entity affected (e.g. 'user', 'task', 'settings')
 * @param {string|null} params.targetId - ID of the entity affected
 * @param {Object} params.metadata - Additional context data
 * @param {string|null} params.ipAddress - Client IP address
 */
async function auditLog({ userId = null, userEmail = null, action, targetType = null, targetId = null, metadata = {}, ipAddress = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, user_email, action, target_type, target_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, userEmail, action, targetType, targetId, JSON.stringify(metadata), ipAddress]
    );
  } catch (err) {
    console.error('[Audit] Failed to write audit log:', err.message);
  }
}

module.exports = { auditLog };
