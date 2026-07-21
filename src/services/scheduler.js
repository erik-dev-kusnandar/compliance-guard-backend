const cron = require('node-cron');
const pool = require('../config/db');
const { searchGoogleAPI } = require('./google-api');
const { searchGoogleMimic } = require('./google-mimic');

const VALID_METHODS = ['API', 'MIMIC', 'HYBRID'];
let cronJobs = new Map();

function parseCronParts(expression) {
  const parts = expression.trim().split(/\s+/);
  return parts.length === 5;
}

function computeNextRun(expression) {
  try {
    const parts = expression.trim().split(/\s+/);
    const now = new Date();
    const next = new Date(now);
    next.setSeconds(next.getSeconds() + 60);
    return next.toISOString();
  } catch {
    return null;
  }
}

async function executeScheduledTask(scheduledTask) {
  const client = await pool.connect();
  let historyId = null;

  try {
    console.log(`[Scheduler] Executing scheduled task "${scheduledTask.name}" (ID: ${scheduledTask.id})`);

    const historyResult = await client.query(
      `INSERT INTO scheduled_task_history (scheduled_task_id, status, started_at)
       VALUES ($1, 'RUNNING', NOW())
       RETURNING id`,
      [scheduledTask.id]
    );
    historyId = historyResult.rows[0].id;

    await client.query(
      `UPDATE scheduled_tasks SET last_run_at = NOW() WHERE id = $1`,
      [scheduledTask.id]
    );

    let tasksCreated = 0;
    const { keyword, pages, method, headless, proxy, tab_delay_min, tab_delay_max } = scheduledTask;

    if (method === 'MIMIC') {
      const mimicEvidence = await searchGoogleMimic(keyword, pages, {
        headless: headless || false,
        proxy: proxy || null,
        tabDelayMin: tab_delay_min || 1,
        tabDelayMax: tab_delay_max || 3,
      });

      const seenBaseUrls = new Set();
      const uniqueEvidence = [];
      for (const item of mimicEvidence) {
        try {
          const u = new URL(item.url);
          const baseUrl = u.origin + u.pathname;
          if (!seenBaseUrls.has(baseUrl.toLowerCase())) {
            seenBaseUrls.add(baseUrl.toLowerCase());
            uniqueEvidence.push(item);
          }
        } catch {
          uniqueEvidence.push(item);
        }
      }

      for (const item of uniqueEvidence) {
        try {
          const existing = await client.query(
            `SELECT id, status FROM scraping_queue WHERE target_url = $1`,
            [item.url]
          );
          if (existing.rows.length > 0) {
            const row = existing.rows[0];
            if (row.status === 'COMPLETED' || row.status === 'FAILED') {
              await client.query(
                `UPDATE scraping_queue SET status = 'COMPLETED', method = $1,
                 screenshot_path = $2, sha256_hash = $3, completed_at = NOW(), error_message = NULL,
                 retry_count = 0, locked_at = NULL WHERE id = $4`,
                [method, item.screenshotPath, item.sha256Hash, row.id]
              );
              tasksCreated++;
            }
          } else {
            await client.query(
              `INSERT INTO scraping_queue (search_query, target_url, status, method, screenshot_path, sha256_hash, completed_at)
               VALUES ($1, $2, 'COMPLETED', $3, $4, $5, NOW())`,
              [keyword, item.url, method, item.screenshotPath, item.sha256Hash]
            );
            tasksCreated++;
          }
        } catch (err) {
          console.error(`[Scheduler] Error inserting MIMIC result: ${err.message}`);
        }
      }
    } else {
      const urls = await searchGoogleAPI(keyword, pages);
      for (const url of urls) {
        try {
          const existing = await client.query(
            `SELECT id, status FROM scraping_queue WHERE target_url = $1`,
            [url]
          );
          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO scraping_queue (search_query, target_url, status, method)
               VALUES ($1, $2, 'PENDING', $3)`,
              [keyword, url, method]
            );
            tasksCreated++;
          } else if (existing.rows[0].status === 'COMPLETED' || existing.rows[0].status === 'FAILED') {
            await client.query(
              `UPDATE scraping_queue SET status = 'PENDING', method = $1,
               screenshot_path = NULL, completed_at = NULL, error_message = NULL,
               retry_count = 0, locked_at = NULL WHERE id = $2`,
              [method, existing.rows[0].id]
            );
            tasksCreated++;
          }
        } catch (err) {
          console.error(`[Scheduler] Error inserting API result: ${err.message}`);
        }
      }
    }

    await client.query(
      `UPDATE scheduled_task_history SET status = 'COMPLETED', tasks_created = $1, completed_at = NOW()
       WHERE id = $2`,
      [tasksCreated, historyId]
    );

    console.log(`[Scheduler] Task "${scheduledTask.name}" completed: ${tasksCreated} tasks created`);
  } catch (err) {
    console.error(`[Scheduler] Task "${scheduledTask.name}" failed:`, err.message);
    if (historyId) {
      await pool.query(
        `UPDATE scheduled_task_history SET status = 'FAILED', error_message = $1, completed_at = NOW()
         WHERE id = $2`,
        [err.message, historyId]
      ).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function loadScheduledTasks() {
  stopAllJobs();

  try {
    const result = await pool.query(
      `SELECT * FROM scheduled_tasks WHERE enabled = true`
    );

    for (const task of result.rows) {
      if (!cron.validate(task.cron_expression)) {
        console.error(`[Scheduler] Invalid cron expression "${task.cron_expression}" for task ${task.id} (${task.name})`);
        continue;
      }

      const job = cron.schedule(task.cron_expression, () => {
        executeScheduledTask(task);
      }, {
        scheduled: true,
        timezone: 'UTC',
      });

      cronJobs.set(task.id, job);
      console.log(`[Scheduler] Loaded scheduled task "${task.name}" (cron: ${task.cron_expression})`);
    }

    console.log(`[Scheduler] ${cronJobs.size} scheduled task(s) active`);
  } catch (err) {
    console.error('[Scheduler] Error loading scheduled tasks:', err.message);
  }
}

function stopAllJobs() {
  for (const [id, job] of cronJobs) {
    job.stop();
  }
  cronJobs.clear();
}

function getActiveJobCount() {
  return cronJobs.size;
}

module.exports = {
  loadScheduledTasks,
  stopAllJobs,
  executeScheduledTask,
  computeNextRun,
  parseCronParts,
  getActiveJobCount,
};
