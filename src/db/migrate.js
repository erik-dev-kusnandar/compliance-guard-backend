const { Pool } = require('pg');
require('dotenv').config();

/**
 * Safe migration script for existing databases.
 * Applies CHECK constraint on users.role column if not already present.
 * Run with: node src/db/migrate.js
 */
async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const migrations = [
    {
      name: 'add_role_check_constraint',
      up: `
        DO $$ BEGIN
          ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('Admin', 'Analyst', 'Viewer'));
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `,
    },
    {
      name: 'add_screenshot_columns',
      up: `
        DO $$ BEGIN
          ALTER TABLE scraping_queue ADD COLUMN IF NOT EXISTS screenshot_path TEXT;
        EXCEPTION
          WHEN duplicate_column THEN null;
        END $$;

        DO $$ BEGIN
          ALTER TABLE scraping_queue ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
        EXCEPTION
          WHEN duplicate_column THEN null;
        END $$;
      `,
    },
    {
      name: 'add_status_column_to_users',
      up: `
        DO $$ BEGIN
          ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Active';
        EXCEPTION
          WHEN duplicate_column THEN null;
        END $$;
      `,
    },
    {
      name: 'create_system_settings_table',
      up: `
        CREATE TABLE IF NOT EXISTS system_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        INSERT INTO system_settings (key, value)
        VALUES ('self_registration', 'true')
        ON CONFLICT (key) DO NOTHING;
      `,
    },
  ];

  try {
    // Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Get applied migrations
    const applied = await pool.query('SELECT name FROM _migrations');
    const appliedNames = new Set(applied.rows.map((r) => r.name));

    // Apply pending migrations
    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) {
        console.log(`  Skipping "${migration.name}" (already applied)`);
        continue;
      }
      console.log(`  Applying "${migration.name}"...`);
      await pool.query(migration.up);
      await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
      console.log(`  Done.`);
    }

    console.log('All migrations applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
