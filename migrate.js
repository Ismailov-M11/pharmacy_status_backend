const { Pool } = require("pg");

const pool = new Pool({
    host: "localhost",
    user: "postgres",
    password: "8438822",
    database: "pharmacy_db",
    port: 5432,
});

async function migrate() {
    const client = await pool.connect();

    try {
        console.log("🔄 Starting migration...");

        // Check if column exists with old name
        const checkOld = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'pharmacy_status' AND column_name = 'brandedpacket'
    `);

        if (checkOld.rows.length > 0) {
            console.log("✅ Found old column 'brandedpacket', renaming...");

            // Rename column
            await client.query(`
        ALTER TABLE pharmacy_status 
        RENAME COLUMN brandedpacket TO "brandedPacket"
      `);

            console.log("✅ Column renamed successfully!");
        } else {
            console.log("ℹ️  Column 'brandedpacket' not found, checking for 'brandedPacket'...");

            const checkNew = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'pharmacy_status' AND column_name = 'brandedPacket'
      `);

            if (checkNew.rows.length > 0) {
                console.log("✅ Column 'brandedPacket' already exists - migration not needed!");
            } else {
                console.log("❌ Neither column found - please check your database schema");
            }
        }

        // Add indexes
        console.log("🔄 Adding indexes...");

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_changes_pharmacy_id 
      ON status_changes(pharmacy_id)
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_changes_changed_at 
      ON status_changes(changed_at DESC)
    `);

        console.log("✅ Indexes created successfully!");

        // Verify final schema
        const finalSchema = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'pharmacy_status'
      ORDER BY ordinal_position
    `);

        console.log("\n📋 Final schema for pharmacy_status:");
        finalSchema.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

        console.log("\n✅ Migration completed successfully!");

    } catch (error) {
        console.error("❌ Migration failed:", error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
