CREATE TABLE IF NOT EXISTS pharmacy_status (
    pharmacy_id VARCHAR(50) PRIMARY KEY,
    training BOOLEAN DEFAULT FALSE,
    "brandedPacket" BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS status_changes (
    id SERIAL PRIMARY KEY,
    pharmacy_id VARCHAR(50),
    field VARCHAR(50),
    old_value BOOLEAN,
    new_value BOOLEAN,
    comment TEXT,
    changed_by VARCHAR(100),
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add index for better performance
CREATE INDEX IF NOT EXISTS idx_status_changes_pharmacy_id ON status_changes(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_status_changes_changed_at ON status_changes(changed_at DESC);
