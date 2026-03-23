// database.js — All DB operations using Turso (libSQL)
// Every function is async — await them in server.js

const db = require('./db');

// ─── Helpers ──────────────────────────────────────────────────────────────────
// libSQL returns { rows: [ {col: val, ...} ] }
// rows[0] gives the first row as an object
function row(rs)  { return rs.rows[0] ?? null; }
function rows(rs) { return rs.rows; }
function scalar(rs, col) {
    const r = rs.rows[0];
    return r ? (r[col] ?? null) : null;
}

// ─── USER QUERIES ─────────────────────────────────────────────────────────────
const userStmts = {

    create: (username, email, password) =>
        db.execute({
            sql: `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`,
            args: [username, email, password],
        }),

    findByUsername: async (username) =>
        row(await db.execute({
            sql: `SELECT * FROM users WHERE username = ?`,
            args: [username],
        })),

    findByEmail: async (email) =>
        row(await db.execute({
            sql: `SELECT * FROM users WHERE email = ?`,
            args: [email],
        })),

    findById: async (id) =>
        row(await db.execute({
            sql: `SELECT id, username, email, credits, role, extra_consoles, created_at FROM users WHERE id = ?`,
            args: [id],
        })),

    addCredits: (amount, userId) =>
        db.execute({
            sql: `UPDATE users SET credits = credits + ? WHERE id = ?`,
            args: [amount, userId],
        }),

    setCredits: (credits, userId) =>
        db.execute({
            sql: `UPDATE users SET credits = ? WHERE id = ?`,
            args: [credits, userId],
        }),

    deductCredits: (userId) =>
        db.execute({
            sql: `UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0`,
            args: [userId],
        }),

    getCredits: async (userId) =>
        row(await db.execute({
            sql: `SELECT credits, extra_consoles FROM users WHERE id = ?`,
            args: [userId],
        })),

    addConsoles: (amount, userId) =>
        db.execute({
            sql: `UPDATE users SET extra_consoles = extra_consoles + ? WHERE id = ?`,
            args: [amount, userId],
        }),

    allUsers: async () =>
        rows(await db.execute(
            `SELECT id, username, email, credits, role, extra_consoles, created_at FROM users ORDER BY created_at DESC`
        )),

    setRole: (role, userId) =>
        db.execute({
            sql: `UPDATE users SET role = ? WHERE id = ?`,
            args: [role, userId],
        }),

    deleteUser: (userId) =>
        db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] }),

    countAll: async () =>
        scalar(await db.execute(`SELECT COUNT(*) as total FROM users`), 'total'),
};

// ─── ORDER QUERIES ────────────────────────────────────────────────────────────
const orderStmts = {

    create: (userId, packageId, credits, amount, expiresAt) =>
        db.execute({
            sql: `INSERT INTO orders (user_id, package_id, credits, amount, expires_at) VALUES (?, ?, ?, ?, ?)`,
            args: [userId, packageId, credits, amount, expiresAt],
        }),

    getPendingByUser: async (userId) =>
        rows(await db.execute({
            sql: `SELECT * FROM orders WHERE user_id = ? AND status = 'pending'`,
            args: [userId],
        })),

    getById: async (id) =>
        row(await db.execute({
            sql: `SELECT * FROM orders WHERE id = ?`,
            args: [id],
        })),

    confirm: (id) =>
        db.execute({ sql: `UPDATE orders SET status = 'confirmed' WHERE id = ?`, args: [id] }),

    cancel: (id) =>
        db.execute({ sql: `UPDATE orders SET status = 'cancelled' WHERE id = ?`, args: [id] }),

    expireOld: () =>
        db.execute(`UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at < datetime('now')`),

    allPending: async () =>
        rows(await db.execute(`
            SELECT o.*, u.username FROM orders o
            JOIN users u ON u.id = o.user_id
            WHERE o.status = 'pending' ORDER BY o.created_at DESC
        `)),

    countByUser: async (userId) =>
        scalar(await db.execute({
            sql: `SELECT COUNT(*) as total FROM orders WHERE user_id = ? AND status = 'confirmed'`,
            args: [userId],
        }), 'total'),

    totalRevenue: async () =>
        scalar(await db.execute(`SELECT SUM(amount) as total FROM orders WHERE status = 'confirmed'`), 'total'),
};

// ─── JOB LOG QUERIES ──────────────────────────────────────────────────────────
const logStmts = {

    insert: (userId, channels) =>
        db.execute({
            sql: `INSERT INTO job_logs (user_id, channels) VALUES (?, ?)`,
            args: [userId, channels],
        }),

    countByUser: async (userId) =>
        row(await db.execute({
            sql: `SELECT COUNT(*) as total, SUM(channels) as total_channels FROM job_logs WHERE user_id = ?`,
            args: [userId],
        })),

    recent: async (userId) =>
        rows(await db.execute({
            sql: `SELECT * FROM job_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
            args: [userId],
        })),

    globalStats: async () =>
        row(await db.execute(`SELECT COUNT(*) as total_jobs, SUM(channels) as total_channels FROM job_logs`)),
};

// ─── APP SETTINGS ─────────────────────────────────────────────────────────────
const settingsStmts = {

    get: async (key) => {
        const r = row(await db.execute({ sql: `SELECT value FROM app_settings WHERE key = ?`, args: [key] }));
        return r ? r.value : null;
    },

    set: (key, value) =>
        db.execute({
            sql: `INSERT INTO app_settings (key, value) VALUES (?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
            args: [key, value],
        }),

    all: async () =>
        rows(await db.execute(`SELECT key, value FROM app_settings`)),
};

module.exports = { db, userStmts, orderStmts, logStmts, settingsStmts };
