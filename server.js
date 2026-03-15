const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const statusRoutes = require("./routes/statusRoutes");
const osonRoutes = require("./routes/osonRoutes");

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
app.use("/api/oson", osonRoutes);

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

    // Create oson_pharmacies table for OSON Slug List module
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oson_pharmacies (
        id               SERIAL PRIMARY KEY,
        slug             TEXT UNIQUE NOT NULL,
        name_ru          TEXT,
        name_uz          TEXT,
        parent_region_ru TEXT,
        parent_region_uz TEXT,
        region_ru        TEXT,
        region_uz        TEXT,
        address_ru       TEXT,
        address_uz       TEXT,
        landmark_ru      TEXT,
        landmark_uz      TEXT,
        latitude         DECIMAL(10,7),
        longitude        DECIMAL(10,7),
        phone            VARCHAR(50),
        open_time        VARCHAR(10),
        close_time       VARCHAR(10),
        has_delivery     BOOLEAN DEFAULT FALSE,
        is_verified      BOOLEAN DEFAULT FALSE,
        discount_percent INTEGER DEFAULT 0,
        cashback_percent INTEGER DEFAULT 0,
        oson_status      VARCHAR(20) DEFAULT 'not_connected',
        last_synced_at   TIMESTAMP DEFAULT NOW(),
        created_at       TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_oson_slug ON oson_pharmacies(slug);
      CREATE INDEX IF NOT EXISTS idx_oson_status ON oson_pharmacies(oson_status);
      CREATE INDEX IF NOT EXISTS idx_oson_parent_region ON oson_pharmacies(parent_region_ru);
    `);

    // Migrate existing oson_pharmacies columns from VARCHAR to TEXT (for production)
    await pool.query(`
      ALTER TABLE oson_pharmacies ALTER COLUMN slug TYPE TEXT;
      ALTER TABLE oson_pharmacies ALTER COLUMN name_ru TYPE TEXT;
      ALTER TABLE oson_pharmacies ALTER COLUMN name_uz TYPE TEXT;
      ALTER TABLE oson_pharmacies ALTER COLUMN parent_region_ru TYPE TEXT;
      ALTER TABLE oson_pharmacies ALTER COLUMN parent_region_uz TYPE TEXT;
      ALTER TABLE oson_pharmacies ALTER COLUMN region_ru TYPE TEXT;
      ALTER TABLE oson_pharmacies ALTER COLUMN region_uz TYPE TEXT;
    `);

    // Seed: pharmacies that were connected in Davo but do NOT exist in OSON at all.
    // These must be marked as 'deleted'. Only insert if slug not already present;
    // if already present and NOT 'connected', set to 'deleted'.
    const deletedSlugs = [
      'islam-pharm-90904',
      'neofarm-137918',
      '100-apteka-166144',
      '5555-pharm-group-14608',
      'marjon-farm-trade-n3-24266',
      'marjon-farm-trade-n2-42042',
      'marjon-farm-trade-n11-226446',
      'marjon-farm-trade-n9-226468',
      'access-pharm-102454',
      'aptyeka-a5-n6-38038',
      'aptyeka-a5-n15-62458',
      'aptyeka-a5-n14-6710',
      'aptyeka-a5-n1-726',
      'aptyeka-a5-n5-8272',
      'aptyeka-a5-n17-9174',
      'aptyeka-a5-n19-94116',
      'aptyeka-a5-n8-8602',
      'aptyeka-a5-n2-11506',
      'aptyeka-a5-n7-116798',
      'ssss-med-apteka-14344',
      'al-madina-pharm-81928',
      'shahrizoda-biznes-servis-171996',
      'nice-farm-n2-37070',
      'akmal-farm-medical-n3-parkent-bozori-104676',
      'genesis-trade-yunusabod-108152',
      'top-farm-n16-130174',
      'top-pharm-n2-72974',
      'top-farm-n14-83028',
      'nuriymon-pharm-health-23254',
      'genesis-trade-sirg-ali-78320',
      'top-farm-56078',
      'genesis-trade-s1-78386',
      'genesis-trade-yangiobod-16148',
      'genesis-trade-chilonzor-30734',
      'onko-farm-73788',
      'farm-servis-193776',
      'accees-pharm-102454',
    ];

    for (const slug of deletedSlugs) {
      await pool.query(`
        INSERT INTO oson_pharmacies (slug, oson_status, last_synced_at, created_at)
        VALUES ($1, 'deleted', NOW(), NOW())
        ON CONFLICT (slug) DO UPDATE
          SET oson_status = 'deleted', last_synced_at = NOW()
          WHERE oson_pharmacies.oson_status <> 'connected';
      `, [slug]);
    }
    console.log(`Seeded ${deletedSlugs.length} manually-deleted OSON pharmacies.`);

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

  // Start OSON Cron Sync (daily at 12:00 Tashkent time)
  const osonSyncService = require('./services/osonSyncService');
  osonSyncService.startOsonCron();

  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT} `);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
