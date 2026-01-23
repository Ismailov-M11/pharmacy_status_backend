const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const statusRoutes = require("./routes/statusRoutes");

const app = express();

// CORS configuration - allow requests from your Netlify frontend
const corsOptions = {
  origin: process.env.CORS_ORIGIN || "http://localhost:5173",
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

app.use("/api/status", statusRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running" });
});

// Initialize database tables on startup
async function initializeDatabase() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? {
      rejectUnauthorized: false
    } : false
  });

  try {
    console.log('Checking database tables...');

    // Create pharmacy_status table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pharmacy_status (
        id SERIAL PRIMARY KEY,
        pharmacy_id VARCHAR(50) UNIQUE NOT NULL,
        training BOOLEAN DEFAULT FALSE,
        branded_packet BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    /* Refactoring Schema for Strict Polling Logic */

    // 1. Rename pharmacy_activity_events -> pharmacy_events if exists
    const checkEventsTable = await pool.query("SELECT to_regclass('pharmacy_activity_events')");
    if (checkEventsTable.rows[0].to_regclass) {
      await pool.query("ALTER TABLE pharmacy_activity_events RENAME TO pharmacy_events");
    }

    // 2. Ensure pharmacy_events exists (if not renamed)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pharmacy_events(
      id SERIAL PRIMARY KEY,
      pharmacy_id VARCHAR(50) NOT NULL,
      event_type VARCHAR(20) NOT NULL,
      event_at TIMESTAMP NOT NULL DEFAULT NOW(),
      source VARCHAR(20) NOT NULL
    );
        CREATE INDEX IF NOT EXISTS idx_events_time ON pharmacy_events(event_at DESC);
        CREATE INDEX IF NOT EXISTS idx_events_pid_time ON pharmacy_events(pharmacy_id, event_at DESC);
    `);

    // 3. Update pharmacy_status columns (Rename to match new spec)
    const checkStatusColumns = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'pharmacy_status'
      `);
    const columns = checkStatusColumns.rows.map(r => r.column_name);

    if (columns.includes('is_active')) {
      await pool.query("ALTER TABLE pharmacy_status RENAME COLUMN is_active TO last_active");
    }
    if (columns.includes('onboarding_started_at')) {
      await pool.query("ALTER TABLE pharmacy_status RENAME COLUMN onboarding_started_at TO first_deactivated_at");
    }
    if (columns.includes('onboarded_at')) {
      await pool.query("ALTER TABLE pharmacy_status RENAME COLUMN onboarded_at TO first_trained_activation_at");
    }

    // 4. Add missing columns if they don't exist
    await pool.query(`
        ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS last_active BOOLEAN DEFAULT TRUE; /* Fallback if rename didn't run */
        ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS first_deactivated_at TIMESTAMP NULL;
        ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS first_trained_activation_at TIMESTAMP NULL;
        ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP NULL;
        ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    /* Cleanup: Drop redundant columns (data now comes from external API) - Legacy cleanup */
    await pool.query(`
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS name;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS address;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS district;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS phone;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS responsible_phone;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS landmark;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS code;
    `);

    // Create status_history table (Kept for training/brandedPacket history)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS status_history(
      id SERIAL PRIMARY KEY,
      pharmacy_id VARCHAR(50) NOT NULL,
      field VARCHAR(50) NOT NULL,
      old_value BOOLEAN,
      new_value BOOLEAN NOT NULL,
      changed_by VARCHAR(100) NOT NULL,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      comment TEXT
    );
    `);

    // Create user_column_settings table for storing user preferences
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_column_settings (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        page VARCHAR(50) NOT NULL,
        settings JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, page)
      );
      CREATE INDEX IF NOT EXISTS idx_user_settings ON user_column_settings(user_id, page);
    `);


    console.log('Database tables ready!');
  } catch (error) {
    console.error('Error initializing database:', error);
  } finally {
    await pool.end();
  }
}

const PORT = process.env.PORT || 5000;

// Initialize database then start server
initializeDatabase().then(() => {
  // Start Polling Service
  const pollingService = require('./services/pollingService');
  pollingService.startPolling();

  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT} `);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
