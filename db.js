// db.js — Turso (libSQL) connection
const { createClient } = require('@libsql/client');

let url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;

if (!url || !token) {
    console.error('[db.js] Error: TURSO_DATABASE_URL or TURSO_AUTH_TOKEN missing');
}

// For better compatibility in some environments, ensure https:// if it's a turso.io URL
if (url && url.startsWith('libsql://')) {
    url = url.replace('libsql://', 'https://');
}

const db = createClient({
    url: url || '',
    authToken: token || '',
});

module.exports = db;
