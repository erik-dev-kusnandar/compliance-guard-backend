const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const pool = require('./config/db');
require('dotenv').config();

const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 3000;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'storage', 'screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function randomDelay(min = 500, max = 2000) {
  return new Promise((resolve) =>
    setTimeout(resolve, min + Math.random() * (max - min)),
  );
}

const STEALTH_SCRIPT = `
  // Override webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });

  // Override plugins
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    },
  });

  // Override mimeTypes
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      const mimeTypes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      mimeTypes.length = 1;
      return mimeTypes;
    },
  });

  // Override languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });

  // Override platform
  Object.defineProperty(navigator, 'platform', {
    get: () => 'Win32',
  });

  // Override hardwareConcurrency
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => 8,
  });

  // Override deviceMemory
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => 8,
  });

  // Override maxTouchPoints
  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => 0,
  });

  // Override chrome runtime
  window.chrome = {
    runtime: {
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      connect: function() {},
      sendMessage: function() {},
    },
    loadTimes: function() {
      return {};
    },
    csi: function() {
      return {};
    },
  };

  // Override permissions
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);

  // Override WebGL vendor and renderer
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) {
      return 'Intel Inc.';
    }
    if (parameter === 37446) {
      return 'Intel Iris OpenGL Engine';
    }
    return getParameter.call(this, parameter);
  };

  const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) {
      return 'Intel Inc.';
    }
    if (parameter === 37446) {
      return 'Intel Iris OpenGL Engine';
    }
    return getParameter2.call(this, parameter);
  };

  // Override console.debug to prevent detection
  const oldDebug = console.debug;
  console.debug = function() {
    return oldDebug.apply(this, arguments);
  };

  // Override toString to prevent detection
  const originalToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (this === navigator.permissions.query) {
      return 'function query() { [native code] }';
    }
    return originalToString.call(this);
  };
`;

async function humanScroll(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const scrollStep = Math.floor(Math.random() * 300) + 100;
    const steps = Math.floor(Math.random() * 5) + 3;

    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, scrollStep);
      await delay(Math.floor(Math.random() * 500) + 200);
    }

    window.scrollTo(0, 0);
    await delay(300);
  });
}

async function fetchAndProcessTask(browser) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, search_query, target_url, retry_count, method
       FROM scraping_queue
       WHERE status = 'PENDING'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const task = result.rows[0];

    await client.query(
      `UPDATE scraping_queue
       SET status = 'PROCESSING', locked_at = NOW()
       WHERE id = $1`,
      [task.id],
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
    console.log(
      `[Worker] Processing task #${task.id} [${task.method || 'API'}]: ${task.search_query}`,
    );

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });

    const page = await context.newPage();

    await page.addInitScript(STEALTH_SCRIPT);

    await page.goto(task.target_url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await randomDelay(2000, 5000);
    await humanScroll(page);
    await randomDelay(1000, 3000);

    const filename = `evidence_${task.id}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });

    const screenshotPath = `/storage/screenshots/${filename}`;
    await pool.query(
      `UPDATE scraping_queue
       SET status = 'COMPLETED',
           screenshot_path = $1,
           completed_at = NOW()
       WHERE id = $2`,
      [screenshotPath, task.id],
    );

    console.log(
      `[Worker] Task #${task.id} completed. Screenshot: ${screenshotPath}`,
    );
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
      [newStatus, newRetryCount, err.message, task.id],
    );

    console.log(
      `[Worker] Task #${task.id} set to ${newStatus} (retry ${newRetryCount}/${MAX_RETRIES})`,
    );
    return false;
  } finally {
    if (context) {
      await context.close();
    }
  }
}

async function main() {
  console.log('[Worker] Starting Playwright Worker Engine...');

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  if (process.env.PROXY_SERVER) {
    launchOptions.proxy = { server: process.env.PROXY_SERVER };
    console.log(`[Worker] Using proxy: ${process.env.PROXY_SERVER}`);
  }

  const browser = await chromium.launch(launchOptions);

  console.log('[Worker] Browser launched successfully');

  const shutdown = async () => {
    console.log('[Worker] Shutting down...');
    await browser.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    try {
      const task = await fetchAndProcessTask(browser);

      if (task) {
        await processTask(browser, task);
      } else {
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
