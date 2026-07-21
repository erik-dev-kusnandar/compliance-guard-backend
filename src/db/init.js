const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const RESET = process.argv.includes('--reset');

async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/compliance_guard';
  const adminDbUrl = dbUrl.replace(/\/[^/]*$/, '/postgres');
  const adminPool = new Pool({ connectionString: adminDbUrl });

  try {
    const dbCheck = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = 'compliance_guard'");
    if (dbCheck.rows.length === 0) {
      await adminPool.query('CREATE DATABASE compliance_guard');
      console.log('Database "compliance_guard" created successfully');
    } else {
      console.log('Database "compliance_guard" already exists');
    }
  } catch (err) {
    console.error('Error creating database:', err.message);
    console.log('Attempting to continue with existing database...');
  } finally {
    await adminPool.end();
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    if (RESET) {
      console.log('\n⚠️  RESET MODE — dropping all tables!\n');
      const dropSQL = fs.readFileSync(
        path.join(__dirname, 'schema.sql'),
        'utf8'
      );
      await pool.query(dropSQL);
      console.log('Schema reset applied successfully');
    } else {
      const safeSQL = fs.readFileSync(
        path.join(__dirname, 'schema-safe.sql'),
        'utf8'
      );
      await pool.query(safeSQL);
      console.log('Schema applied (safe mode — no data dropped)');
    }

    // Seed admin user
    const adminPassword = 'admin123';
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(adminPassword, salt);

    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         status = EXCLUDED.status`,
      ['Admin', 'admin@complianceguard.com', passwordHash, 'Admin', 'Active']
    );
    console.log('Admin user seeded successfully');
    console.log('Email: admin@complianceguard.com');
    console.log('Password: admin123');
  } catch (err) {
    console.error('Error initializing database:', err.message);
  } finally {
    await pool.end();
  }
}

initDatabase();
