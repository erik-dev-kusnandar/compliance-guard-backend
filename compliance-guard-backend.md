Act as a Senior Backend Architect and Automation Engineer.
I need you to build the Backend API and Worker Engine for a web scraping system from scratch.

TECH STACK:
Node.js (Express or Fastify), PostgreSQL (pg module), Playwright, playwright-stealth.

SYSTEM ARCHITECTURE (Producer-Consumer Pattern):
The system is divided into two main parts that share the same PostgreSQL database:
1. API (Producer): Receives scraping tasks and manages data.
2. Worker (Consumer): Pulls tasks from the database queue, executes Playwright, and saves results.

PHASE 1: DATABASE SCHEMA (Execute this first)
- Create a PostgreSQL schema with a custom ENUM type `queue_status` ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED').
- Create a `scraping_queue` table with columns: id, search_query, target_url (UNIQUE), status, retry_count, error_message, created_at, locked_at, completed_at, and screenshot_path.
- Create a Partial Index on `created_at` WHERE status = 'PENDING'.

PHASE 2: API ENDPOINTS
Create a Node.js server with these endpoints:
- POST /api/tasks: Accepts { keyword, pages }. (Mock the Google Search extraction logic for now, just insert dummy target_urls into the queue with PENDING status).
- GET /api/queue-status: Returns aggregated counts of tasks grouped by status.
- GET /api/evidences: Returns a list of COMPLETED tasks with their screenshot paths.

PHASE 3: PLAYWRIGHT WORKER ENGINE
Create a separate worker script that runs continuously:
- Use PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` to atomically pull one PENDING task and update it to PROCESSING.
- Initialize Playwright with `playwright-stealth` enabled.
- Launch ONLY ONE Browser instance, and use `browser.newContext()` for each individual task to save memory.
- Implement human mimicry: Add random delays and smooth scrolling simulation before taking a full-page screenshot.
- Save the screenshot locally (or mock S3 upload) and update the database row to COMPLETED with the screenshot path.
- MUST INCLUDE: A `try...finally` block to ensure `context.close()` is always called, preventing memory leaks even if the page times out or hits a Cloudflare block. If failed, update status back to PENDING (increment retry_count) or FAILED if max retries reached.

Please generate the project structure and the core code files for Phase 1, 2, and 3.

ADDITIONAL COMPATIBILITY REQUIREMENTS (For Frontend Integration):

1. DATABASE UPDATE (Add to Phase 1):
- Create a `users` table: id (SERIAL PRIMARY KEY), name (TEXT), email (TEXT UNIQUE), password_hash (TEXT), role (TEXT DEFAULT 'Analyst'), status (TEXT DEFAULT 'Active'), created_at (TIMESTAMP WITH TIME ZONE DEFAULT NOW()).
- Seed one default admin user with a hashed password (using bcrypt) for testing.

2. AUTHENTICATION ENDPOINTS (Add to Phase 2):
- Install dependencies: `bcryptjs`, `jsonwebtoken`, and `cors`.
- Implement `POST /api/auth/register`: Hash password using bcrypt and save to the `users` table.
- Implement `POST /api/auth/login`: Verify email/password, generate a JWT token containing user ID, role, and name.
- Create a `verifyJWT` middleware. Protect ALL scraping endpoints (POST /api/tasks, GET /api/queue-status, GET /api/evidences) and Team Management endpoints, ensuring only authenticated requests can access them.

3. TEAM MANAGEMENT ENDPOINTS (Add to Phase 2):
- GET /api/users: Return list of users (exclude password_hash).
- POST /api/users: Allow Admin role to invite/create a new user.
- DELETE /api/users/:id: Allow Admin to delete/revoke access.

4. STATIC SCREENSHOT SERVING & CORS:
- Enable CORS in Express/Fastify to allow cross-origin requests from the Next.js Frontend.
- Serve the local storage screenshots directory statically (e.g., `app.use('/storage', express.static(path.join(__dirname, '../storage')))`).
- Ensure that when the Worker saves a screenshot, the database column `screenshot_path` stores the relative URL (e.g., `/storage/screenshots/evidence_1.png`) instead of the absolute file system path. This allows the Frontend to easily render the image using: `http://localhost:API_PORT/storage/screenshots/evidence_1.png`.

5. ENVIRONMENT VARIABLES (.env):
- Create a `.env` template containing:
  PORT=5000 (Ensure it doesn't clash with Next.js port 3000)
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/compliance_guard
  JWT_SECRET=your_super_secret_jwt_key_here
  NODE_ENV=development