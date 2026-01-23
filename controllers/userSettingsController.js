const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
    } : false
});

// Get user column settings
exports.getColumnSettings = async (req, res) => {
    const { userId } = req.params;
    const { page } = req.query; // e.g., 'leads'

    try {
        const result = await pool.query(
            `SELECT settings FROM user_column_settings 
       WHERE user_id = $1 AND page = $2`,
            [userId, page || 'leads']
        );

        if (result.rows.length === 0) {
            return res.json({ settings: null });
        }

        res.json({ settings: result.rows[0].settings });
    } catch (error) {
        console.error("Error fetching column settings:", error);
        res.status(500).json({ error: "Failed to fetch column settings" });
    }
};

// Save user column settings
exports.saveColumnSettings = async (req, res) => {
    const { userId } = req.params;
    const { page, settings } = req.body;

    try {
        await pool.query(
            `INSERT INTO user_column_settings (user_id, page, settings, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, page)
       DO UPDATE SET settings = $3, updated_at = NOW()`,
            [userId, page || 'leads', JSON.stringify(settings)]
        );

        res.json({ success: true, message: "Column settings saved successfully" });
    } catch (error) {
        console.error("Error saving column settings:", error);
        res.status(500).json({ error: "Failed to save column settings" });
    }
};
