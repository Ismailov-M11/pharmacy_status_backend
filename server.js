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
