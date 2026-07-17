const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const pool = require('./config/db');
require('dotenv').config();

const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 3000;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'storage', 'screenshots');

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function randomDelay(min = 500, max = 2000) {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

async function humanScroll(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const scrollStep = Math.floor(Math.random() * 300) + 100;
    const steps = Math.floor(Math.random() * 5) + 3;

    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, scrollStep);
      await delay(Math.floor(Math.random() * 500) + 200);
    }

    // Scroll back to top
    window.scrollTo(0, 0);
    await delay(300);
  });
}

async function fetchAndProcessTask(browser) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Atomically pull one PENDING task with FOR UPDATE SKIP LOCKED
    const result = await client.query(
      `SELECT id, search_query, target_url, retry_count
       FROM scraping_queue
       WHERE status = 'PENDING'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const task = result.rows[0];

    // Update to PROCESSING
    await client.query(
      `UPDATE scraping_queue
       SET status = 'PROCESSING', locked_at = NOW()
       WHERE id = $1`,
      [task.id]
    );

    await client.query('COMMIT');
    return task;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processTask(browser, task) {
  let context;
  try {
    console.log(`[Worker] Processing task #${task.id}: ${task.search_query}`);

    // Create a new context for each task (memory efficient)
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    const page = await context.newPage();

    // Stealth: Override navigator properties to avoid detection
    await page.addInitScript(() => {
      // Override webdriver property
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Override platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32',
      });

      // Override chrome runtime
      window.chrome = { runtime: {} };
    });

    // Navigate to target URL with timeout
    await page.goto(task.target_url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Human mimicry: random delays and smooth scrolling
    await randomDelay(1000, 3000);
    await humanScroll(page);
    await randomDelay(500, 1500);

    // Take full-page screenshot
    const filename = `evidence_${task.id}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });

    // Update database with screenshot path (relative URL)
    const screenshotPath = `/storage/screenshots/${filename}`;
    await pool.query(
      `UPDATE scraping_queue
       SET status = 'COMPLETED',
           screenshot_path = $1,
           completed_at = NOW()
       WHERE id = $2`,
      [screenshotPath, task.id]
    );

    console.log(`[Worker] Task #${task.id} completed. Screenshot: ${screenshotPath}`);
    return true;
  } catch (err) {
    console.error(`[Worker] Task #${task.id} failed:`, err.message);

    const newRetryCount = task.retry_count + 1;
    const newStatus = newRetryCount >= MAX_RETRIES ? 'FAILED' : 'PENDING';

    await pool.query(
      `UPDATE scraping_queue
       SET status = $1,
           retry_count = $2,
           error_message = $3,
           locked_at = NULL
       WHERE id = $4`,
      [newStatus, newRetryCount, err.message, task.id]
    );

    console.log(`[Worker] Task #${task.id} set to ${newStatus} (retry ${newRetryCount}/${MAX_RETRIES})`);
    return false;
  } finally {
    // ALWAYS close context to prevent memory leaks
    if (context) {
      await context.close();
    }
  }
}

async function main() {
  console.log('[Worker] Starting Playwright Worker Engine...');

  // Launch browser ONCE
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  console.log('[Worker] Browser launched successfully');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Worker] Shutting down...');
    await browser.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Worker loop
  while (true) {
    try {
      const task = await fetchAndProcessTask(browser);

      if (task) {
        await processTask(browser, task);
      } else {
        // No pending tasks, wait before polling again
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error('[Worker] Error in main loop:', err.message);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
