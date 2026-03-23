// db.js — Turso (libSQL) connection
// Serverless-safe: creates client per import (stateless)

const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('[db.js] TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in .env');
}

const db = createClient({
    url:       process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

module.exports = db;
