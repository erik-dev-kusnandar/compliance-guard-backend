const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'storage', 'screenshots');
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

    // Find organic result containers
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

    // Fallback: all links in #rso
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
 * Full MIMIC workflow:
 * 1. Open google.co.id
 * 2. TYPE keyword in search box → Enter
 * 3. RIGHT CLICK each result → Open in new tab
 * 4. SWITCH to new tab → screenshot
 * 5. CLOSE tab → repeat
 *
 * @returns {Array<{url, screenshotPath, title}>}
 */
async function searchGoogleMimic(keyword, pages = 1, options = {}) {
  const {
    headless = false,
    locale = 'id-ID',
    timezone = 'Asia/Jakarta',
    proxy = null,
  } = options;

  let browser = null;
  let context;
  const evidence = [];

  try {
    const headlessMode = headless === true;
    console.log(`[MIMIC] Launching browser (headless: ${headlessMode}, proxy: ${proxy || 'none'})...`);

    const launchOptions = {
      headless: headlessMode,
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

    // Add proxy if provided (e.g. "socks5://127.0.0.1:1080" or "http://user:pass@host:port")
    if (proxy) {
      const proxyUrl = new URL(proxy);
      launchOptions.proxy = {
        server: proxy,
      };
      console.log(`[MIMIC] Using proxy: ${proxyUrl.hostname}:${proxyUrl.port}`);
    }

    browser = await chromium.launch(launchOptions);

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      locale,
      timezoneId: timezone,
      extraHTTPHeaders: {
        'Accept-Language': `${locale},id;q=0.9,en-US;q=0.8,en;q=0.7`,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });

    const page = await context.newPage();
    await page.addInitScript(STEALTH_SCRIPT);

    // Step 1: Open google.co.id
    console.log('[MIMIC] Step 1: Opening google.co.id...');
    await page.goto('https://www.google.co.id', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(1500, 3000);
    await acceptConsent(page);

    // Step 2: Type keyword in search box
    console.log(`[MIMIC] Step 2: Typing "${keyword}" in search box...`);
    const searchBox = 'textarea[name="q"], input[name="q"], textarea[title="Telusuri"], input[title="Telusuri"]';
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

    // Pagination loop: process each page of results
    for (let pageNum = 0; pageNum < pages; pageNum++) {
      console.log(`\n[MIMIC] ===== PAGE ${pageNum + 1}/${pages} =====`);

      // Step 4: Get organic result links from current page
      console.log('[MIMIC] Step 4: Extracting search result links...');
      const results = await getOrganicResultLinks(page);
      console.log(`[MIMIC] Found ${results.length} organic results on page ${pageNum + 1}`);

      if (results.length === 0) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
        console.error(`[MIMIC] No results found on page ${pageNum + 1}. Body: ${bodyText.substring(0, 200)}`);
        break;
      }

      // STEP A: Open ALL result URLs in new background tabs first
      console.log(`[MIMIC] Opening ${results.length} URLs in background tabs...`);
      const tabsBefore = context.pages().length;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        try {
          // Scroll result into view and click with Ctrl to open in new tab
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
            await newPage.goto(result.url, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
          }
          await randomDelay(800, 1500);
        } catch (err) {
          console.error(`[MIMIC]   Failed to open tab ${i + 1}: ${err.message}`);
        }
      }

      const tabsAfter = context.pages().length;
      const newTabCount = tabsAfter - tabsBefore;
      console.log(`[MIMIC] Opened ${newTabCount} new tabs (from ${tabsBefore} to ${tabsAfter})`);

      // Wait a bit for all tabs to start loading
      await randomDelay(3000, 5000);

      // STEP B: Collect all new tabs (everything except the Google search page)
      const allPages = context.pages();
      const newTabs = allPages.filter(p => p !== page);
      console.log(`[MIMIC] Processing ${newTabs.length} tabs for screenshots...`);

      // STEP C: Visit each tab → wait for full load → screenshot → close
      for (let i = 0; i < newTabs.length; i++) {
        const tab = newTabs[i];
        const globalIndex = evidence.length + 1;
        let tabUrl = '';
        try {
          tabUrl = tab.url();
          console.log(`[MIMIC] Tab ${i + 1}/${newTabs.length} (total #${globalIndex}): ${tabUrl.substring(0, 80)}...`);

          // Bring tab to front
          await tab.bringToFront();

          // Wait for full page load (networkidle = no network activity for 500ms)
          try {
            await tab.waitForLoadState('networkidle', { timeout: 30000 });
            console.log(`[MIMIC]   Page loaded (networkidle)`);
          } catch (_) {
            console.log(`[MIMIC]   networkidle timeout, falling back to load state`);
            try {
              await tab.waitForLoadState('load', { timeout: 10000 });
            } catch (_) {}
          }

          // Extra wait for JS rendering (SPAs, lazy-loaded images, etc.)
          await randomDelay(3000, 6000);

          // Scroll down to trigger lazy loading, then back to top
          try {
            await tab.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight / 2);
            });
            await randomDelay(1500, 2500);
            await tab.evaluate(() => {
              window.scrollTo(0, 0);
            });
            await randomDelay(1000, 2000);
          } catch (_) {}

          // Screenshot the fully loaded page
          const screenshotFilename = `evidence_mimic_${Date.now()}_${globalIndex}.png`;
          const screenshotPath = path.join(SCREENSHOT_DIR, screenshotFilename);
          await tab.screenshot({ path: screenshotPath, fullPage: true });

          const relativePath = `/storage/screenshots/${screenshotFilename}`;
          evidence.push({
            url: tab.url(),
            screenshotPath: relativePath,
            title: await tab.title(),
          });
          console.log(`[MIMIC]   Screenshot saved: ${relativePath}`);

          // Close the tab
          await tab.close();
          console.log(`[MIMIC]   Tab closed`);
          await randomDelay(500, 1000);
        } catch (err) {
          console.error(`[MIMIC]   Error processing tab ${i + 1}: ${err.message}`);
          try { await tab.close(); } catch (_) {}
        }
      }

      // Navigate to next page of Google results (if not last page)
      if (pageNum < pages - 1) {
        console.log(`[MIMIC] Navigating to next page of results...`);
        await randomDelay(2000, 4000);

        // Make sure we're back on the Google search page
        const currentPages = context.pages();
        const googlePage = currentPages.find(p => p.url().includes('google.co.id/search'));
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
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }

  return evidence;
}

module.exports = { searchGoogleMimic };
