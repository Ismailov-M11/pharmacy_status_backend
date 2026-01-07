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

      /* Migrate/Add new columns safely */
      ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS onboarding_started_at TIMESTAMP NULL;
      ALTER TABLE pharmacy_status ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP NULL;

      /* Cleanup: Drop redundant columns (data now comes from external API) */
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS name;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS address;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS district;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS phone;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS responsible_phone;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS landmark;
      ALTER TABLE pharmacy_status DROP COLUMN IF EXISTS code;
    `);

    // Create status_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS status_history (
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

    // Create pharmacy_activity_events table (New Strict Logic)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pharmacy_activity_events (
        id SERIAL PRIMARY KEY,
        pharmacy_id VARCHAR(50) NOT NULL,
        event_type VARCHAR(20) NOT NULL,
        event_at TIMESTAMP NOT NULL DEFAULT NOW(),
        source VARCHAR(20) NOT NULL,
        meta JSONB NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_activity_events_time ON pharmacy_activity_events(event_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_events_pid_time ON pharmacy_activity_events(pharmacy_id, event_at DESC);
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
  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
