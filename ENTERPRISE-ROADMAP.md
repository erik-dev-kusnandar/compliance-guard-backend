# Compliance Guard — Enterprise Features Roadmap

> Tracking document for phased enterprise feature implementation.
> Last updated: 2026-07-18

---

## Tier 1: Role-Based Access Control (RBAC) — DONE

### Backend

| Item | File | Status |
|---|---|---|
| `requireRole(...roles)` middleware | `src/middleware/auth.js` | Done |
| `GET /api/users` → Admin only | `src/routes/users.js` | Done |
| `POST/DELETE /api/tasks` → Admin+Analyst | `src/routes/tasks.js` | Done |
| `DELETE /api/tasks/clear-completed` → Admin+Analyst | `src/routes/tasks.js` | Done |
| Role validation on user create | `src/routes/users.js` | Done |
| DB CHECK constraint on `users.role` | `src/db/schema.sql` | Done |
| DB migration script for existing DBs | `src/db/migrate.js` | Done |
| Swagger role enum updated (Viewer added) | `src/swagger.js` | Done |

### Frontend

| Item | File | Status |
|---|---|---|
| `hasRole()`, `isAdmin`, `isAnalyst`, `isViewer` helpers | `src/contexts/auth-context.tsx` | Done |
| `<ProtectedRoute requiredRole="Admin">` + Access Denied UI | `src/components/protected-route.tsx` | Done |
| Sidebar nav filtered by role | `src/components/dashboard-layout.tsx` | Done |
| Dashboard home: form hidden for Viewer | `src/components/dashboard-home.tsx` | Done |
| Queue page: Viewer read-only (no form, no delete, no clear) | `src/routes/queue.tsx` | Done |
| Settings page: Admin only | `src/routes/settings.tsx` | Done |
| Users page: Admin only | `src/routes/users.tsx` | Done |

### Verification

| Test | Count | Status |
|---|---|---|
| Original API tests | 19 | All pass |
| RBAC integration tests (`tests/rbac.test.js`) | 25 | All pass |
| TypeScript compile | — | Clean |

### Test Users Created

| Email | Password | Role |
|---|---|---|
| `admin@complianceguard.com` | `admin123` | Admin |
| `analyst@test.com` | `test1234` | Analyst |
| `viewer@test.com` | `test1234` | Viewer |

---

## Tier 1.5: Self-Registration Toggle — DONE

| Item | File | Status |
|---|---|---|
| `system_settings` DB table | `src/db/schema.sql`, `src/db/migrate.js` | Done |
| `GET /api/settings/public` (no auth) | `src/routes/settings.js` | Done |
| `GET /api/settings` (Admin only) | `src/routes/settings.js` | Done |
| `PUT /api/settings` (Admin only) | `src/routes/settings.js` | Done |
| Settings route mounted in Express | `src/index.js` | Done |
| Auth register checks `self_registration` flag | `src/routes/auth.js` | Done |
| Frontend settings API client | `src/lib/settings-api.ts` | Done |
| Frontend `useSettings` / `useUpdateSettings` hooks | `src/hooks/use-settings.ts` | Done |
| Settings page wired to API (real persistence) | `src/routes/settings.tsx` | Done |
| Register page checks setting, shows "disabled" UI | `src/routes/register.tsx` | Done |

### Verified

- `PUT /api/settings` disable → `GET /api/settings/public` returns `false` → `POST /api/auth/register` returns 403
- Re-enable → registration works again

---

## Tier 2: Dashboard Charts — TODO

Compliance metrics visualization on the home dashboard.

### Planned

- [ ] Task volume over time (line/bar chart, daily/weekly)
- [ ] Success vs failure rate (donut/pie chart)
- [ ] Search method breakdown (API / MIMIC / HYBRID distribution)
- [ ] Average completion time metric
- [ ] Evidence collection trend

### Tech decisions

- [ ] Charting library: Recharts / Chart.js / Victory (pick one)
- [ ] Backend: new `GET /api/tasks/stats` endpoint with aggregated data
- [ ] Time range filter (last 7d / 30d / all)

---

## Tier 3: Audit Log — TODO

Track all user actions for compliance and accountability.

### Planned

- [ ] `audit_log` DB table (user_id, action, target_type, target_id, metadata, timestamp)
- [ ] Log middleware or helper: login, logout, task create/delete, settings change, user create/delete
- [ ] `GET /api/audit` endpoint (Admin only, paginated, filterable by user/action/date)
- [ ] Frontend: audit log viewer page (Admin only)
- [ ] Export audit log (CSV/JSON)

---

## Tier 4: Evidence Management — TODO

Advanced evidence handling beyond basic screenshots.

### Planned

- [ ] Bulk evidence download (ZIP)
- [ ] Evidence comparison view (side-by-side)
- [ ] Evidence tagging / labeling
- [ ] SHA-256 hash chain-of-custody (capture + verify)
- [ ] Evidence metadata panel (capture date, method, search query, proxy used)
- [ ] Evidence retention policy (auto-delete after N days, configurable in Settings)

---

## Tier 5: Task Scheduling — TODO

Recurring and scheduled crawling.

### Planned

- [ ] `scheduled_tasks` DB table (cron expression or frequency enum)
- [ ] Scheduler service (node-cron or similar)
- [ ] Frontend: schedule config in task creation form
- [ ] Scheduled task list view (Admin/Analyst)
- [ ] Pause / resume individual schedules
- [ ] Execution history per schedule

---

## Tier 6: Security Hardening — TODO

Production-grade security features.

### Planned

- [ ] Rate limiting (express-rate-limit on auth + task endpoints)
- [ ] CSRF protection
- [ ] Session management (active sessions list, force logout)
- [ ] Password policy enforcement (min length, complexity)
- [ ] Password change endpoint (requires current password)
- [ ] Account lockout after N failed login attempts
- [ ] JWT refresh token flow (short-lived access + long-lived refresh)
- [ ] Audit all auth events (login success/failure, password changes)

---

## UI Polish — TODO

- [ ] Mobile responsive sidebar (hamburger menu)
- [ ] Loading skeletons instead of spinners
- [ ] Dark mode support
- [ ] Keyboard shortcuts (e.g., `Ctrl+K` command palette)
- [ ] Empty states with illustrations
- [ ] Confirmation dialogs for destructive actions
- [ ] Toast notification consistency audit
