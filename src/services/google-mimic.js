const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'storage', 'screenshots');
const PROFILE_COPY_DIR = path.join(os.tmpdir(), 'compliance-guard-chrome-profile');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function randomDelay(min = 800, max = 2500) {
  return new Promise((resolve) =>
    setTimeout(resolve, min + Math.random() * (max - min)),
  );
}

async function humanType(page, selector, text) {
  await page.click(selector);
  await randomDelay(300, 600);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 120 });
    if (Math.random() < 0.15) {
      await randomDelay(200, 500);
    }
  }
}

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const p = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      p.length = 3;
      return p;
    },
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  window.chrome = {
    runtime: {
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      connect: function() {},
      sendMessage: function() {},
    },
    loadTimes: function() { return {}; },
    csi: function() { return {}; },
  };
`;

function isGoogleBlocked(title, url) {
  const t = (title || '').toLowerCase();
  const u = (url || '').toLowerCase();
  return (
    t.includes('sorry') ||
    t.includes('captcha') ||
    t.includes('unusual traffic') ||
    t.includes('not a robot') ||
    u.includes('/sorry/')
  );
}

async function acceptConsent(page) {
  try {
    const consentBtn = await page.$('button#L2AGLb, button[aria-label="Accept all"], button[aria-label="Setuju"], form[action*="consent"] button');
    if (consentBtn) {
      await consentBtn.click();
      console.log('[MIMIC] Accepted consent dialog');
      await randomDelay(1500, 3000);
    }
  } catch (_) {}
}

function getOrganicResultLinks(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    const BLOCKED_HOSTS = [
      'google.com', 'google.co.id', 'googleapis.com', 'gstatic.com',
      'webcache.googleusercontent.com', 'accounts.google.com',
      'support.google.com', 'policies.google.com',
      'maps.google.com', 'play.google.com',
    ];

    function isBlocked(href) {
      try {
        const u = new URL(href);
        return BLOCKED_HOSTS.some((h) => u.hostname.endsWith(h));
      } catch { return true; }
    }

    const containers = document.querySelectorAll('#rso .g, #rso > div > div');
    for (const container of containers) {
      const anchor = container.querySelector('a[href^="http"]');
      if (anchor && !isBlocked(anchor.href) && !seen.has(anchor.href)) {
        seen.add(anchor.href);
        const h3 = container.querySelector('h3');
        results.push({
          url: anchor.href,
          title: h3 ? h3.innerText : '',
          element: true,
        });
      }
    }

    if (results.length === 0) {
      const resultArea = document.querySelector('#rso');
      if (resultArea) {
        const allAnchors = resultArea.querySelectorAll('a[href^="http"]');
        for (const a of allAnchors) {
          if (!isBlocked(a.href) && !seen.has(a.href) && a.href.length > 25) {
            seen.add(a.href);
            results.push({ url: a.href, title: a.innerText || '', element: true });
          }
        }
      }
    }

    return results;
  });
}

/**
 * Find the default Chrome profile directory on Windows.
 * Tries "Default" first, then "Profile 1", "Profile 2", etc.
 */
function findChromeProfileDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const chromeUserData = path.join(localAppData, 'Google', 'Chrome', 'User Data');

  if (!fs.existsSync(chromeUserData)) {
    console.log(`[MIMIC] Chrome User Data not found at: ${chromeUserData}`);
    return null;
  }

  // Try Default profile first
  const defaultProfile = path.join(chromeUserData, 'Default');
  if (fs.existsSync(defaultProfile)) {
    console.log(`[MIMIC] Found Chrome profile: ${defaultProfile}`);
    return chromeUserData;
  }

  // Try Profile 1, Profile 2, etc.
  for (let i = 1; i <= 5; i++) {
    const profilePath = path.join(chromeUserData, `Profile ${i}`);
    if (fs.existsSync(profilePath)) {
      console.log(`[MIMIC] Found Chrome profile: ${profilePath}`);
      return chromeUserData;
    }
  }

  console.log(`[MIMIC] No Chrome profile found in: ${chromeUserData}`);
  return null;
}

/**
 * Copy Chrome profile to temp directory for Playwright to use.
 * Only copies essential files to keep it fast.
 */
async function copyChromeProfile(srcDir) {
  const destDir = PROFILE_COPY_DIR;

  // If profile copy already exists and is recent (< 1 hour), reuse it
  if (fs.existsSync(destDir)) {
    const stat = fs.statSync(destDir);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 60 * 60 * 1000) {
      console.log(`[MIMIC] Reusing existing profile copy (${Math.round(ageMs / 60000)} min old)`);
      return destDir;
    }
    // Remove stale copy
    console.log(`[MIMIC] Removing stale profile copy...`);
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  console.log(`[MIMIC] Copying Chrome profile from: ${srcDir}`);
  console.log(`[MIMIC] This may take a moment on first run...`);

  // Copy essential directories/files only
  const essentialItems = [
    'Default',
    'Local State',
  ];

  fs.mkdirSync(destDir, { recursive: true });

  for (const item of essentialItems) {
    const srcPath = path.join(srcDir, item);
    const destPath = path.join(destDir, item);

    if (!fs.existsSync(srcPath)) continue;

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirSync(srcPath, destPath, [
        'Cache', 'Code Cache', 'GPUCache', 'Service Worker',
        'Session Storage', 'IndexedDB', 'databases',
      ]);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  const sizeMB = getDirSizeMB(destDir);
  console.log(`[MIMIC] Profile copied (${sizeMB} MB)`);
  return destDir;
}

function copyDirSync(src, dest, excludeDirs = []) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeDirs.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, excludeDirs);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch (_) {
        // Skip locked files (like Cookies, etc.)
      }
    }
  }
}

function getDirSizeMB(dir) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSizeMB(p);
      } else {
        try { total += fs.statSync(p).size; } catch (_) {}
      }
    }
  } catch (_) {}
  return Math.round(total / (1024 * 1024));
}

/**
 * Full MIMIC workflow:
 * 1. Launch Chrome with user profile (or fresh if unavailable)
 * 2. Open google.co.id
 * 3. TYPE keyword in search box → Enter
 * 4. CTRL+CLICK each result → Open in new tab
 * 5. SWITCH to new tab → wait for full load → screenshot
 * 6. CLOSE tab → repeat
 */
async function searchGoogleMimic(keyword, pages = 1, options = {}) {
  const {
    headless = false,
    locale = 'id-ID',
    timezone = 'Asia/Jakarta',
    proxy = null,
    tabDelayMin = 1,
    tabDelayMax = 3,
  } = options;

  let context = null;
  let profileDir = null;
  const evidence = [];

  try {
    const headlessMode = headless === true;
    console.log(`[MIMIC] Launching Chrome (headless: ${headlessMode}, proxy: ${proxy || 'none'})...`);

    // Try to find and copy Chrome profile
    const chromeUserDataDir = findChromeProfileDir();
    if (chromeUserDataDir) {
      profileDir = await copyChromeProfile(chromeUserDataDir);
      console.log(`[MIMIC] Using Chrome profile from: ${profileDir}`);
    } else {
      console.log(`[MIMIC] No Chrome profile found, using fresh profile`);
    }

    const contextOptions = {
      viewport: { width: 1920, height: 1080 },
      locale,
      timezoneId: timezone,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
    };

    if (proxy) {
      contextOptions.proxy = { server: proxy };
      console.log(`[MIMIC] Using proxy: ${proxy}`);
    }

    // Use launchPersistentContext to keep cookies/session between runs
    if (profileDir) {
      console.log(`[MIMIC] Launching with persistent context (profile: ${profileDir})...`);
      context = await chromium.launchPersistentContext(profileDir, {
        headless: headlessMode,
        channel: 'chrome',
        ...contextOptions,
      });
    } else {
      console.log(`[MIMIC] Launching without persistent profile...`);
      const browser = await chromium.launch({
        headless: headlessMode,
        channel: 'chrome',
        args: contextOptions.args,
        ...(contextOptions.proxy ? { proxy: contextOptions.proxy } : {}),
      });
      context = await browser.newContext({
        viewport: contextOptions.viewport,
        locale: contextOptions.locale,
        timezoneId: contextOptions.timezoneId,
      });
    }

    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(STEALTH_SCRIPT);

    // Step 1: Open google.co.id
    console.log('[MIMIC] Step 1: Opening google.co.id...');
    await page.goto('https://www.google.co.id', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(1500, 3000);
    await acceptConsent(page);

    // Step 2: Type keyword in search box
    console.log(`[MIMIC] Step 2: Typing "${keyword}" in search box...`);
    const searchBox = 'textarea[name="q"], input[name="q"], textarea[title="Telusuri"], input[title="Telusuri"], textarea[title="Search"], input[title="Search"]';
    try {
      await page.waitForSelector(searchBox, { timeout: 10000 });
    } catch (_) {
      console.error('[MIMIC] Search box not found');
      return evidence;
    }

    await humanType(page, searchBox, keyword);
    await randomDelay(500, 1000);

    // Step 3: Press Enter
    console.log('[MIMIC] Step 3: Pressing Enter...');
    await page.keyboard.press('Enter');

    // Wait for results
    try {
      await page.waitForSelector('#rso, #search', { timeout: 15000 });
    } catch (_) {
      console.log('[MIMIC] Timeout waiting for search results');
    }
    await randomDelay(2000, 4000);

    const title = await page.title();
    const currentUrl = page.url();
    console.log(`[MIMIC] Search results loaded. Title: "${title}" | URL: ${currentUrl}`);

    if (isGoogleBlocked(title, currentUrl)) {
      console.error(`[MIMIC] Google blocked the request (title="${title}")`);
      const debugPath = path.join(SCREENSHOT_DIR, `debug_blocked_${Date.now()}.png`);
      try {
        await page.screenshot({ path: debugPath, fullPage: true });
        console.error(`[MIMIC] Debug screenshot: ${debugPath}`);
      } catch (_) {}
      return evidence;
    }

    // Pagination loop
    for (let pageNum = 0; pageNum < pages; pageNum++) {
      console.log(`\n[MIMIC] ===== PAGE ${pageNum + 1}/${pages} =====`);

      // Step 4: Get organic result links
      console.log('[MIMIC] Step 4: Extracting search result links...');
      const results = await getOrganicResultLinks(page);
      console.log(`[MIMIC] Found ${results.length} organic results on page ${pageNum + 1}`);

      if (results.length === 0) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
        console.error(`[MIMIC] No results found on page ${pageNum + 1}. Body: ${bodyText.substring(0, 200)}`);
        break;
      }

      // STEP A: Open ALL result URLs in new background tabs
      console.log(`[MIMIC] Opening ${results.length} URLs in background tabs...`);
      const tabsBefore = context.pages().length;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        try {
          await page.evaluate((idx) => {
            const containers = document.querySelectorAll('#rso .g, #rso > div > div');
            if (containers[idx]) {
              containers[idx].scrollIntoView({ block: 'center' });
            }
          }, i);
          await randomDelay(400, 800);

          const resultSelector = `#rso .g a[href="${result.url}"], #rso > div > div a[href="${result.url}"]`;
          const linkElement = await page.$(resultSelector);

          if (linkElement) {
            await linkElement.click({ modifiers: ['Control'] });
            console.log(`[MIMIC]   Opened tab ${i + 1}/${results.length}: ${result.url.substring(0, 80)}...`);
          } else {
            console.log(`[MIMIC]   Link not found for result ${i + 1}, using page.goto fallback`);
            const newPage = await context.newPage();
            await newPage.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          }
          await randomDelay(tabDelayMin * 1000, tabDelayMax * 1000);
        } catch (err) {
          console.error(`[MIMIC]   Failed to open tab ${i + 1}: ${err.message}`);
        }
      }

      const tabsAfter = context.pages().length;
      const newTabCount = tabsAfter - tabsBefore;
      console.log(`[MIMIC] Opened ${newTabCount} new tabs (from ${tabsBefore} to ${tabsAfter})`);

      // Wait for all tabs to start loading
      await randomDelay(5000, 8000);

      // STEP B: Collect all new tabs
      const allPages = context.pages();
      const newTabs = allPages.filter(p => p !== page);
      console.log(`[MIMIC] Processing ${newTabs.length} tabs for screenshots...`);

      // STEP C: Visit each tab → wait → screenshot → close
      for (let i = 0; i < newTabs.length; i++) {
        const tab = newTabs[i];
        const globalIndex = evidence.length + 1;
        try {
          const tabUrl = tab.url();
          console.log(`[MIMIC] Tab ${i + 1}/${newTabs.length} (total #${globalIndex}): ${tabUrl.substring(0, 80)}...`);

          await tab.bringToFront();

          // Wait for page load — load first, then networkidle
          try {
            await tab.waitForLoadState('load', { timeout: 20000 });
            console.log(`[MIMIC]   Page load event fired`);
          } catch (_) {
            console.log(`[MIMIC]   load timeout, continuing...`);
          }

          try {
            await tab.waitForLoadState('networkidle', { timeout: 25000 });
            console.log(`[MIMIC]   Page networkidle reached`);
          } catch (_) {
            console.log(`[MIMIC]   networkidle timeout, continuing with current state`);
          }

          // Extra wait for JS rendering
          await randomDelay(4000, 7000);

          // Scroll down incrementally to trigger lazy loading
          try {
            const scrollHeight = await tab.evaluate(() => document.body.scrollHeight);
            const viewportHeight = 1080;
            const steps = Math.min(Math.ceil(scrollHeight / viewportHeight), 5);
            for (let s = 1; s <= steps; s++) {
              await tab.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), s * viewportHeight);
              await randomDelay(1200, 2000);
            }
            await randomDelay(1000, 1500);
            await tab.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
            await randomDelay(1500, 2500);
          } catch (_) {}

          // Screenshot
          const screenshotFilename = `evidence_mimic_${Date.now()}_${globalIndex}.png`;
          const screenshotPath = path.join(SCREENSHOT_DIR, screenshotFilename);
          await tab.screenshot({ path: screenshotPath, fullPage: true });

          // Compute SHA-256 hash of the screenshot file
          let sha256Hash = null;
          try {
            const fileBuffer = fs.readFileSync(screenshotPath);
            sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          } catch (_) {}

          const relativePath = `/storage/screenshots/${screenshotFilename}`;
          evidence.push({
            url: tab.url(),
            screenshotPath: relativePath,
            sha256Hash,
            title: await tab.title(),
          });
          console.log(`[MIMIC]   Screenshot saved: ${relativePath}`);

          await tab.close();
          console.log(`[MIMIC]   Tab closed`);
          await randomDelay(500, 1000);
        } catch (err) {
          console.error(`[MIMIC]   Error processing tab ${i + 1}: ${err.message}`);
          try { await tab.close(); } catch (_) {}
        }
      }

      // Navigate to next page of results
      if (pageNum < pages - 1) {
        console.log(`[MIMIC] Navigating to next page of results...`);
        await randomDelay(2000, 4000);

        const currentPages = context.pages();
        const googlePage = currentPages.find(p => p.url().includes('google'));
        if (googlePage) {
          await googlePage.bringToFront();
        }

        const nextBtn = await page.$('#pnnext, a[id="pnnext"], a[aria-label="Next"], a[aria-label="Berikutnya"], td.d6cvqb a');
        if (nextBtn) {
          await nextBtn.click();
          try {
            await page.waitForSelector('#rso, #search', { timeout: 15000 });
          } catch (_) {}
          await randomDelay(2000, 4000);
          console.log(`[MIMIC] Navigated to page ${pageNum + 2}`);
        } else {
          console.log('[MIMIC] No "Next" button found, stopping pagination');
          break;
        }
      }
    }

    console.log(`[MIMIC] Done! Captured ${evidence.length} screenshots total`);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }

  return evidence;
}

module.exports = { searchGoogleMimic };
