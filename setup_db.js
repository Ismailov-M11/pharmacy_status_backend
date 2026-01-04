const { Client } = require("pg");

async function setupDatabase() {
    // First connect to default 'postgres' database to create pharmacy_db
    const client = new Client({
        host: "localhost",
        user: "postgres",
        password: "8438822",
        database: "postgres", // Connect to default database
        port: 5432,
    });

    try {
        await client.connect();
        console.log("✅ Connected to PostgreSQL");

        // Check if pharmacy_db exists
        const checkDb = await client.query(`
      SELECT 1 FROM pg_database WHERE datname = 'pharmacy_db'
    `);

        if (checkDb.rows.length === 0) {
            console.log("🔄 Creating pharmacy_db database...");
            await client.query("CREATE DATABASE pharmacy_db");
            console.log("✅ Database pharmacy_db created!");
        } else {
            console.log("ℹ️  Database pharmacy_db already exists");
        }

    } catch (error) {
        console.error("❌ Error:", error.message);
        throw error;
    } finally {
        await client.end();
    }

    // Now connect to pharmacy_db and create tables
    const dbClient = new Client({
        host: "localhost",
        user: "postgres",
        password: "8438822",
        database: "pharmacy_db",
        port: 5432,
    });

    try {
        await dbClient.connect();
        console.log("✅ Connected to pharmacy_db");

        // Create tables
        console.log("🔄 Creating tables...");

        await dbClient.query(`
      CREATE TABLE IF NOT EXISTS pharmacy_status (
        pharmacy_id VARCHAR(50) PRIMARY KEY,
        training BOOLEAN DEFAULT FALSE,
        "brandedPacket" BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await dbClient.query(`
      CREATE TABLE IF NOT EXISTS status_changes (
        id SERIAL PRIMARY KEY,
        pharmacy_id VARCHAR(50),
        field VARCHAR(50),
        old_value BOOLEAN,
        new_value BOOLEAN,
        comment TEXT,
        changed_by VARCHAR(100),
        changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        console.log("✅ Tables created!");

        // Add indexes
        console.log("🔄 Adding indexes...");

        await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_status_changes_pharmacy_id 
      ON status_changes(pharmacy_id)
    `);

        await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_status_changes_changed_at 
      ON status_changes(changed_at DESC)
    `);

        console.log("✅ Indexes created!");

        // Verify schema
        const schema = await dbClient.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'pharmacy_status'
      ORDER BY ordinal_position
    `);

        console.log("\n📋 Schema for pharmacy_status:");
        schema.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

        console.log("\n✅ Database setup completed successfully!");

    } catch (error) {
        console.error("❌ Error:", error.message);
        throw error;
    } finally {
        await dbClient.end();
    }
}

setupDatabase().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
