const { Pool } = require("pg");

const pool = new Pool({
  host: "localhost",
  user: "postgres",
  password: "8438822",
  database: "pharmacy_db",
  port: 5432,
});

module.exports = pool;
