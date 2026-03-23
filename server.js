require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const { userStmts, orderStmts, logStmts, settingsStmts } = require('./database');
const botController = require('./botController');

const app = express();

// ─── File Storage ─────────────────────────────────────────────────────────────
const qrisStorage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, path.join(__dirname, 'public', 'qris')); },
    filename:    (req, file, cb) => { cb(null, `qris_${Date.now()}${path.extname(file.originalname)}`); }
});
const qrisUpload = multer({ storage: qrisStorage });
const msgStorage = multer.memoryStorage();
const msgUpload  = multer({ storage: msgStorage, limits: { fileSize: 8 * 1024 * 1024 } });

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    next();
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'sid',
    cookie: {
        secure: false,
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000,
    },
}));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
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

// Load discount from Turso on startup
let globalDiscount = 0;
(async () => {
    try {
        const d = await settingsStmts.get('shop_discount');
        globalDiscount = d ? parseInt(d) : 0;
    } catch {}
})();

// ═══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
        return res.status(400).json({ error: 'All fields are required.' });
    if (username.length < 3)
        return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    try {
        const existing = await userStmts.findByUsername(username) || await userStmts.findByEmail(email);
        if (existing) return res.status(409).json({ error: 'Username or email already exists.' });

        const hash = await bcrypt.hash(password, 10);
        const result = await userStmts.create(username, email, hash);
        req.session.userId = Number(result.lastInsertRowid);
        res.json({ success: true });
    } catch (e) {
        console.error('[register]', e.message);
        res.status(500).json({ error: 'Registration failed.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Username and password are required.' });

    try {
        const user = await userStmts.findByUsername(username);
        if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid username or password.' });

        req.session.userId = user.id;
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (e) {
        console.error('[login]', e.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const user = await userStmts.findById(req.session.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json(user);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch user.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  SHOP ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/shop/packages', (req, res) => {
    const discounted = PACKAGES.map(p => ({
        ...p,
        originalPrice: p.price,
        price: globalDiscount > 0 ? Math.round(p.price * (1 - globalDiscount / 100)) : p.price,
        discount: globalDiscount,
    }));
    res.json(discounted);
});

app.get('/api/shop/order-status/:id', requireAuth, async (req, res) => {
    try {
        const order = await orderStmts.getById(req.params.id);
        if (!order || order.user_id !== req.session.userId)
            return res.status(404).json({ error: 'Order not found' });
        res.json({ status: order.status });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

app.post('/api/shop/order', requireAuth, async (req, res) => {
    const { packageId } = req.body;
    const pkg = PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Invalid package.' });

    try {
        await orderStmts.expireOld();
        const pending = await orderStmts.getPendingByUser(req.session.userId);
        if (pending.length > 0)
            return res.status(409).json({ error: 'You have a pending order. Please wait for it to expire.' });

        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        const effectivePrice = globalDiscount > 0 ? Math.round(pkg.price * (1 - globalDiscount / 100)) : pkg.price;
        const result = await orderStmts.create(req.session.userId, pkg.id, pkg.credits, effectivePrice, expiresAt);

        res.json({ success: true, orderId: Number(result.lastInsertRowid), package: pkg, expiresAt, accounts: BANK_ACCOUNTS, discount: globalDiscount });
    } catch (e) {
        console.error('[order]', e.message);
        res.status(500).json({ error: 'Failed to create order.' });
    }
});

app.post('/api/shop/cancel-order', requireAuth, async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required.' });
    try {
        const order = await orderStmts.getById(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden.' });
        if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
        await orderStmts.cancel(orderId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

// ─── Admin ───────────────────────────────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
    await orderStmts.expireOld();
    res.json(await orderStmts.allPending());
});

app.post('/api/admin/confirm', requireAdmin, async (req, res) => {
    const { orderId } = req.body;
    try {
        const order = await orderStmts.getById(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
        await orderStmts.confirm(orderId);
        const pkg = PACKAGES.find(p => p.id === order.package_id);
        if (pkg && pkg.type === 'console') {
            await userStmts.addConsoles(pkg.consoles || 1, order.user_id);
        } else {
            await userStmts.addCredits(order.credits, order.user_id);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

// ─── User Stats ───────────────────────────────────────────────────────────────
app.get('/api/user/stats', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const [jobStats, orderCount] = await Promise.all([
            logStmts.countByUser(userId),
            orderStmts.countByUser(userId),
        ]);
        res.json({ jobs: jobStats?.total || 0, total_channels: jobStats?.total_channels || 0, orders: orderCount || 0 });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

app.get('/api/user/logs', requireAuth, async (req, res) => {
    res.json(await logStmts.recent(req.session.userId));
});

app.get('/api/user/consoles', requireAuth, async (req, res) => {
    try {
        const user = await userStmts.findById(req.session.userId);
        res.json({ extra_consoles: user?.extra_consoles ?? 0, total: (user?.extra_consoles ?? 0) + 1 });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

// ─── Discord Bot ───────────────────────────────────────────────────────────────
app.get('/api/stream', requireAuth, botController.handleStream);
app.post('/api/start', requireAuth, msgUpload.single('attachment'), botController.handleStartJob);
app.post('/api/stop', requireAuth, botController.handleStopJob);

// ─── Dashboard route (auth-protected) ────────────────────────────────────────
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ═══════════════════════════════════════════════════════════════
//  OWNER ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/owner/users', requireOwner, async (req, res) => {
    res.json(await userStmts.allUsers());
});

app.get('/api/owner/stats', requireOwner, async (req, res) => {
    try {
        const { db } = require('./database');
        const [totalUsers, jobsR, ordersR] = await Promise.all([
            userStmts.countAll(),
            db.execute(`SELECT COUNT(*) as jobs, SUM(channels) as channels FROM job_logs`),
            db.execute(`SELECT COUNT(*) as total, SUM(CASE WHEN status='confirmed' THEN amount ELSE 0 END) as revenue FROM orders`),
        ]);
        const jobs   = jobsR.rows[0]   || {};
        const orders = ordersR.rows[0] || {};
        res.json({
            totalUsers:    totalUsers || 0,
            totalJobs:     jobs.jobs || 0,
            totalChannels: jobs.channels || 0,
            revenue:       orders.revenue || 0,
            activeJobs:    botController.activeJobs.size,
        });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

app.post('/api/owner/set-credits', requireOwner, async (req, res) => {
    const { userId, credits } = req.body;
    const user = await userStmts.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await userStmts.setCredits(parseInt(credits), userId);
    res.json({ success: true });
});

app.post('/api/owner/add-credits', requireOwner, async (req, res) => {
    const { userId, amount } = req.body;
    const user = await userStmts.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await userStmts.addCredits(parseInt(amount), userId);
    res.json({ success: true });
});

app.post('/api/owner/set-role', requireOwner, async (req, res) => {
    const { userId, role } = req.body;
    const user = await userStmts.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await userStmts.setRole(role, userId);
    res.json({ success: true });
});

app.delete('/api/owner/user/:id', requireOwner, async (req, res) => {
    const userId = parseInt(req.params.id);
    const user = await userStmts.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete owner.' });
    await userStmts.deleteUser(userId);
    res.json({ success: true });
});

app.post('/api/owner/set-consoles', requireOwner, async (req, res) => {
    const { userId, amount } = req.body;
    await userStmts.addConsoles(parseInt(amount), userId);
    res.json({ success: true });
});

app.post('/api/owner/force-stop', requireOwner, (req, res) => {
    const { jobId } = req.body;
    if (jobId) {
        if (botController.activeJobs.has(jobId)) {
            botController.broadcastLog(jobId, 'stop', '⭕ Force-stopped oleh Owner.');
            botController.activeJobs.get(jobId).clients.forEach(c => { try { c.end(); } catch (e) {} });
            botController.activeJobs.delete(jobId);
        }
    } else {
        for (const [jid] of botController.activeJobs) {
            botController.broadcastLog(jid, 'stop', '⭕ Semua job dihentikan oleh Owner.');
            botController.activeJobs.get(jid).clients.forEach(c => { try { c.end(); } catch (e) {} });
        }
        botController.activeJobs.clear();
    }
    res.json({ success: true });
});

app.get('/api/owner/active-jobs', requireOwner, (req, res) => {
    const jobs = [];
    for (const [jid, job] of botController.activeJobs) {
        jobs.push({ jobId: jid, userId: job.userId, clients: job.clients.size });
    }
    res.json(jobs);
});

app.post('/api/owner/confirm-order', requireOwner, async (req, res) => {
    const { orderId } = req.body;
    try {
        const order = await orderStmts.getById(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
        await orderStmts.confirm(orderId);
        const pkg = PACKAGES.find(p => p.id === order.package_id);
        if (pkg && pkg.type === 'console') {
            await userStmts.addConsoles(pkg.consoles || 1, order.user_id);
        } else {
            await userStmts.addCredits(order.credits, order.user_id);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error.' }); }
});

app.post('/api/owner/cancel-order', requireOwner, async (req, res) => {
    const { orderId } = req.body;
    const order = await orderStmts.getById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
    await orderStmts.cancel(orderId);
    res.json({ success: true });
});

app.get('/api/owner/discount', requireOwner, (req, res) => {
    res.json({ discount: globalDiscount });
});
app.post('/api/owner/set-discount', requireOwner, async (req, res) => {
    const d = parseInt(req.body.discount);
    if (isNaN(d) || d < 0 || d > 100) return res.status(400).json({ error: 'Discount must be 0-100.' });
    globalDiscount = d;
    await settingsStmts.set('shop_discount', String(d));
    res.json({ success: true, discount: d });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
