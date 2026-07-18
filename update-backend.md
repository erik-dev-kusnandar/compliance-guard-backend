Act as a Senior Backend Architect and Automation Engineer.
I need you to refactor the existing Node.js backend to support THREE flexible execution modes for the Compliance Guard system.

UPDATE REQUIREMENTS:

1. ENDPOINT UPDATE (`POST /api/tasks`)
Accept an additional parameter `method` in the request body. 
Example body: { "keyword": "...", "pages": 3, "method": "API" | "MIMIC" | "HYBRID" }

Implement the logic for each method inside the API (Producer) as follows:

- MODE 1: "API" (Official Google API Search Only)
  The API calls the official Google Custom Search API, extracts the target URLs from the JSON response, and directly inserts them into the `scraping_queue` table with 'COMPLETED' status (or a new status if required, but since it doesn't need screenshotting in this mode, it logs the URL directly. Alternatively, if all modes require screenshots, see Mode 3).
  *Correction for our workflow*: To ensure ALL modes get a visual screenshot dashboard, let's define the methods based on how the URL is *found* vs how it is *captured*:

  - "API" Mode (Fast & Safe Link Gathering): 
    The API uses the Google Custom Search JSON API to fetch URLs and pushes them to the queue as 'PENDING'. The Worker will pull them later normally to take screenshots.
  
  - "MIMIC" Mode (Full Browser Automation Search): 
    The API does NOT use the Google API. Instead, it pushes a special search task into a new/existing table, or directly opens Playwright in the API/Worker to physically type the keyword into google.com/search, click through pages, scrape the links manually using human mimicry, and push discovered target URLs to the queue as 'PENDING'.

  - "HYBRID" Mode (Google API Search + Playwright Mimic Validation):
    The API uses the official Google Custom Search API to safely get clean target URLs instantly (saving proxy/captcha hassle on Google), inserts them as 'PENDING', and then the Worker uses full Playwright Stealth with human mimicry (scrolling, random delays) to open the target site and capture the screenshot evidence.

2. REFACTORING WORKER & PRODUCER LOGIC:
To accommodate the "MIMIC" mode where Google itself is scraped, please update the system:
- Add `google_search_engine_scraper` function using Playwright Stealth. It must navigate to `google.com`, simulate typing the keyword with human-like delays, press Enter, wait for results, and extract organic search links (`href` from result selectors) across the specified number of pages, using randomized jitter between page navigation to prevent Google blocks.
- Ensure that environment variables for Google API (`GOOGLE_API_KEY`, `GOOGLE_CX_ID`) are checked; if they are missing and the user selects "API" or "HYBRID", gracefully return an error asking to use "MIMIC" mode instead.

3. CODE MAINTENANCE:
- Retain all previous configurations: JWT Authentication (`verifyJWT`), CORS setup, static file serving via `/storage`, PostgreSQL `SKIP LOCKED` queue processing, and `try...finally` memory leak protections.
- Update the API documentation or response structure to reflect which method was used to initiate the task.

Please read the existing code files and apply these architectural upgrades seamlessly.