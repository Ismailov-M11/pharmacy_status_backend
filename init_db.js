const { Pool } = require('pg');

// Create tables if they don't exist
async function initializeDatabase() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        console.log('Initializing database...');

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

        console.log('Database initialized successfully!');
    } catch (error) {
        console.error('Error initializing database:', error);
    } finally {
        await pool.end();
    }
}

// Run initialization
initializeDatabase();
