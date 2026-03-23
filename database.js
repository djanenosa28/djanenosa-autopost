const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './database.db';
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username    TEXT UNIQUE NOT NULL COLLATE NOCASE,
        email       TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password    TEXT NOT NULL,
        credits     INTEGER NOT NULL DEFAULT 0,
        role        TEXT NOT NULL DEFAULT 'user',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        package_id  TEXT NOT NULL,
        credits     INTEGER NOT NULL,
        amount      INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        expires_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS job_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        channels    INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'completed',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
`);

// ─── User Queries ─────────────────────────────────────────────────────────────
const userStmts = {
    create:         db.prepare(`INSERT INTO users (username, email, password) VALUES (?, ?, ?)`),
    findByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
    findByEmail:    db.prepare(`SELECT * FROM users WHERE email = ?`),
    findById:       db.prepare(`SELECT id, username, email, credits, role, extra_consoles, created_at FROM users WHERE id = ?`),
    addCredits:     db.prepare(`UPDATE users SET credits = credits + ? WHERE id = ?`),
    setCredits:     db.prepare(`UPDATE users SET credits = ? WHERE id = ?`),
    deductCredits:  db.prepare(`UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0`),
    getCredits:     db.prepare(`SELECT credits, extra_consoles FROM users WHERE id = ?`),
    addConsoles:    db.prepare(`UPDATE users SET extra_consoles = extra_consoles + ? WHERE id = ?`),
    // Owner-only
    allUsers:       db.prepare(`SELECT id, username, email, credits, role, extra_consoles, created_at FROM users ORDER BY created_at DESC`),
    setRole:        db.prepare(`UPDATE users SET role = ? WHERE id = ?`),
    deleteUser:     db.prepare(`DELETE FROM users WHERE id = ?`),
    countAll:       db.prepare(`SELECT COUNT(*) as total FROM users`),
};

// ─── Order Queries ───────────────────────────────────────────────────────────
const orderStmts = {
    create: db.prepare(`
        INSERT INTO orders (user_id, package_id, credits, amount, expires_at)
        VALUES (?, ?, ?, ?, ?)
    `),
    getPendingByUser: db.prepare(`SELECT * FROM orders WHERE user_id = ? AND status = 'pending'`),
    getById:  db.prepare(`SELECT * FROM orders WHERE id = ?`),
    confirm:  db.prepare(`UPDATE orders SET status = 'confirmed' WHERE id = ?`),
    expireOld: db.prepare(`UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at < datetime('now')`),
    allPending: db.prepare(`
        SELECT o.*, u.username FROM orders o
        JOIN users u ON u.id = o.user_id
        WHERE o.status = 'pending' ORDER BY o.created_at DESC
    `),
    countByUser: db.prepare(`SELECT COUNT(*) as total FROM orders WHERE user_id = ? AND status = 'confirmed'`),
    cancel: db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`),
};

// ─── Job Log Queries ─────────────────────────────────────────────────────────
const logStmts = {
    insert: db.prepare(`INSERT INTO job_logs (user_id, channels) VALUES (?, ?)`),
    countByUser: db.prepare(`SELECT COUNT(*) as total, SUM(channels) as total_channels FROM job_logs WHERE user_id = ?`),
    recent: db.prepare(`SELECT * FROM job_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`),
};

module.exports = { db, userStmts, orderStmts, logStmts };
