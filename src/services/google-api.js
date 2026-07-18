const https = require('https');

const RESULTS_PER_PAGE = 10;

function validateGoogleCredentials() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cxId = process.env.GOOGLE_CX_ID;
  if (!apiKey || !cxId) {
    return { valid: false, error: 'GOOGLE_API_KEY and GOOGLE_CX_ID must be set in .env for API/HYBRID mode. Use MIMIC mode instead.' };
  }
  return { valid: true, apiKey, cxId };
}

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Google API response: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function searchGoogleAPI(keyword, pages = 1) {
  const creds = validateGoogleCredentials();
  if (!creds.valid) {
    throw new Error(creds.error);
  }

  const urls = [];

  for (let page = 0; page < pages; page++) {
    const startIndex = page * RESULTS_PER_PAGE + 1;
    const url = `https://www.googleapis.com/customsearch/v1?key=${creds.apiKey}&cx=${creds.cxId}&q=${encodeURIComponent(keyword)}&start=${startIndex}&num=${RESULTS_PER_PAGE}`;

    const data = await fetchJSON(url);

    if (data.error) {
      throw new Error(`Google API error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    if (data.items && data.items.length > 0) {
      for (const item of data.items) {
        if (item.link) {
          urls.push(item.link);
        }
      }
    }

    if (page < pages - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return urls;
}

module.exports = { searchGoogleAPI, validateGoogleCredentials };
