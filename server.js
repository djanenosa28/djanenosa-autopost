require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const { userStmts, orderStmts, logStmts, settingsStmts } = require('./database');
const botController = require('./botController');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

// Sesi longgar untuk Vercel (Stateless)
app.use(cookieSession({
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'djanenosa-autopost-secret-xyz-789',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 hari
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // Set false agar lancar di Vercel/Proxy manapun
}));

// Layani file statis (Wajib sebelum route lain)
app.use(express.static(path.resolve(__dirname, 'public')));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Sesi habis. Silakan login ulang.' });
    next();
}
async function requireAdmin(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized.' });
    const user = await userStmts.findById(req.session.userId);
    if (!user || (user.role !== 'admin' && user.role !== 'owner')) return res.status(403).json({ error: 'Admin access required.' });
    next();
}
async function requireOwner(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized.' });
    const user = await userStmts.findById(req.session.userId);
    if (!user || user.role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
    next();
}

// ─── Config ───────────────────────────────────────────────────────────────────
const BANK_ACCOUNTS = [
    { bank: 'DANA',    number: '0889-8308-2523',   name: 'Djanenosa' },
    { bank: 'Seabank', number: '9019 3082 9780', name: 'Djanenosa' },
];

const PACKAGES = [
    { id: 'starter',      name: 'Starter Pack',  credits: 50,   price: 15000,  type: 'credits' },
    { id: 'basic',        name: 'Basic Pack',    credits: 150,  price: 35000,  type: 'credits' },
    { id: 'pro',          name: 'Pro Pack',      credits: 400,  price: 75000,  type: 'credits' },
    { id: 'elite',        name: 'Elite Pack',    credits: 1000, price: 150000, type: 'credits' },
    { id: 'more_console', name: 'More Console',  credits: 0,    price: 50000,  type: 'console', consoles: 1 },
];

let globalDiscount = 0;
(async () => {
    try {
        const d = await settingsStmts.get('shop_discount');
        globalDiscount = d ? parseInt(d) : 0;
    } catch {}
})();

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// Root Route (Sangat Penting untuk Vercel)
app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'dashboard.html'));
});

// Auth API
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Field wajib diisi.' });
    try {
        const uExisting = await userStmts.findByUsername(username);
        const eExisting = await userStmts.findByEmail(email);
        if (uExisting || eExisting) return res.status(409).json({ error: 'Username atau email sudah digunakan.' });

        const hash = await bcrypt.hash(password, 10);
        const result = await userStmts.create(username, email, hash);
        req.session.userId = Number(result.lastInsertRowid);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Gagal daftar: ' + e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await userStmts.findByUsername(username);
        if (!user) return res.status(401).json({ error: 'Username/Password salah.' });
        if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Username/Password salah.' });
        req.session.userId = user.id;
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (e) { res.status(500).json({ error: 'Gagal login.' }); }
});

app.post('/api/auth/logout', (req, res) => {
    req.session = null;
    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const user = await userStmts.findById(req.session.userId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
        res.json(user);
    } catch (e) { res.status(500).json({ error: 'Gagal.' }); }
});

// Shop API
app.get('/api/shop/packages', (req, res) => {
    const discounted = PACKAGES.map(p => ({
        ...p,
        originalPrice: p.price,
        price: globalDiscount > 0 ? Math.round(p.price * (1 - globalDiscount / 100)) : p.price,
        discount: globalDiscount,
    }));
    res.json(discounted);
});

app.post('/api/shop/order', requireAuth, async (req, res) => {
    const { packageId } = req.body;
    const pkg = PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Paket salah.' });
    try {
        await orderStmts.expireOld();
        if ((await orderStmts.getPendingByUser(req.session.userId)).length > 0)
            return res.status(409).json({ error: 'Ada pesanan pending.' });
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        const price = globalDiscount > 0 ? Math.round(pkg.price * (1 - globalDiscount / 100)) : pkg.price;
        const result = await orderStmts.create(req.session.userId, pkg.id, pkg.credits, price, expiresAt);
        res.json({ success: true, orderId: Number(result.lastInsertRowid), package: pkg, expiresAt, accounts: BANK_ACCOUNTS });
    } catch (e) { res.status(500).json({ error: 'Gagal buat pesanan.' }); }
});

// User API
app.get('/api/user/stats', requireAuth, async (req, res) => {
    try {
        const [jobStats, orderCount] = await Promise.all([
            logStmts.countByUser(req.session.userId),
            orderStmts.countByUser(req.session.userId),
        ]);
        res.json({ jobs: jobStats?.total || 0, total_channels: jobStats?.total_channels || 0, orders: orderCount || 0 });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

// Bot Control (Proxy through botController)
app.get('/api/stream', requireAuth, botController.handleStream);
app.post('/api/start', requireAuth, multer({ storage: multer.memoryStorage() }).single('attachment'), botController.handleStartJob);
app.post('/api/stop', requireAuth, botController.handleStopJob);

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));

module.exports = app;
