require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const { userStmts, orderStmts, logStmts } = require('./database');
const botController = require('./botController');

const app = express();

// ─── Static File Storage (QRIS Images) ───────────────────────────────────────
const qrisStorage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, path.join(__dirname, 'public', 'qris')); },
    filename: (req, file, cb) => { cb(null, `qris_${Date.now()}${path.extname(file.originalname)}`); }
});
const qrisUpload = multer({ storage: qrisStorage });

// Discord message file storage (memory)
const msgStorage = multer.memoryStorage();
const msgUpload = multer({ storage: msgStorage, limits: { fileSize: 8 * 1024 * 1024 } });

// ─── Security Headers ────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    next();
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: false })); // disable CORS for same-origin only
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'sid', // hide default 'connect.sid' name
    cookie: {
        secure: false,        // set true if behind HTTPS
        httpOnly: true,       // prevent JS access to cookie
        sameSite: 'strict',   // block CSRF
        maxAge: 24 * 60 * 60 * 1000, // 24h
    },
}));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    next();
}
function requireAdmin(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized.' });
    const user = userStmts.findById.get(req.session.userId);
    if (!user || (user.role !== 'admin' && user.role !== 'owner')) return res.status(403).json({ error: 'Admin access required.' });
    next();
}
function requireOwner(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized.' });
    const user = userStmts.findById.get(req.session.userId);
    if (!user || user.role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
    next();
}
// credits === -1 means unlimited
function isUnlimited(credits) { return credits === -1; }

// ─── Bank Account Config ──────────────────────────────────────────────────────
const BANK_ACCOUNTS = [
    { bank: 'DANA', number: '0889-8308-2523', name: 'Djanenosa' },
    { bank: 'Seabank', number: '9019 3082 9780', name: 'Djanenosa' },
];

const PACKAGES = [
    { id: 'starter',       name: 'Starter Pack',   credits: 50,   price: 15000,  label: '50 Credits',    type: 'credits' },
    { id: 'basic',         name: 'Basic Pack',     credits: 150,  price: 35000,  label: '150 Credits',   type: 'credits' },
    { id: 'pro',           name: 'Pro Pack',       credits: 400,  price: 75000,  label: '400 Credits',   type: 'credits' },
    { id: 'elite',         name: 'Elite Pack',     credits: 1000, price: 150000, label: '1000 Credits',  type: 'credits' },
    { id: 'more_console',  name: 'More Console',   credits: 0,    price: 50000,  label: '+1 Console Slot', type: 'console', consoles: 1 },
];

// ─── Global Discount (owner-controlled) ───────────────────────────────────────────────
let globalDiscount = 0; // Percentage 0-100

// ═══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    try {
        const existing = userStmts.findByUsername.get(username) || userStmts.findByEmail.get(email);
        if (existing) return res.status(409).json({ error: 'Username or email already exists.' });

        const hash = await bcrypt.hash(password, 10);
        const info = userStmts.create.run(username, email, hash);
        req.session.userId = info.lastInsertRowid;
        
        res.json({ success: true, message: 'Registration successful!' });
    } catch (e) {
        res.status(500).json({ error: 'Registration failed.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const user = userStmts.findByUsername.get(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid username or password.' });

    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = userStmts.findById.get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user);
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

app.get('/api/shop/payment-info', requireAuth, (req, res) => {
    res.json({ accounts: BANK_ACCOUNTS });
});

app.get('/api/shop/order-status/:id', requireAuth, (req, res) => {
    const order = orderStmts.getById.get(req.params.id);
    if (!order || order.user_id !== req.session.userId) return res.status(404).json({ error: 'Order not found' });
    res.json({ status: order.status });
});

app.post('/api/shop/order', requireAuth, (req, res) => {
    const { packageId } = req.body;
    const pkg = PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Invalid package.' });

    // Expire old pending orders first
    orderStmts.expireOld.run();

    // Check if user has a pending order already
    const pending = orderStmts.getPendingByUser.all(req.session.userId);
    if (pending.length > 0) return res.status(409).json({ error: 'You have a pending order. Please wait for confirmation or wait for it to expire.' });

    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const effectivePrice = globalDiscount > 0 ? Math.round(pkg.price * (1 - globalDiscount / 100)) : pkg.price;
    const info = orderStmts.create.run(req.session.userId, pkg.id, pkg.credits, effectivePrice, expiresAt);

    res.json({ success: true, orderId: info.lastInsertRowid, package: pkg, expiresAt, accounts: BANK_ACCOUNTS, discount: globalDiscount });
});

// ─── User: Cancel their own pending order ─────────────────────────────────────
app.post('/api/shop/cancel-order', requireAuth, (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required.' });
    const order = orderStmts.getById.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
    orderStmts.cancel.run(orderId);
    res.json({ success: true });
});

// ─── Admin: Confirm payment manually ─────────────────────────────────────────
app.post('/api/admin/confirm', requireAdmin, (req, res) => {
    const { orderId } = req.body;
    const order = orderStmts.getById.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });

    orderStmts.confirm.run(orderId);
    // Give credits OR extra_console slot depending on package type
    const pkg = PACKAGES.find(p => p.id === order.package_id);
    if (pkg && pkg.type === 'console') {
        userStmts.addConsoles.run(pkg.consoles || 1, order.user_id);
    } else {
        userStmts.addCredits.run(order.credits, order.user_id);
    }

    res.json({ success: true, message: `Confirmed order for user ${order.user_id}.` });
});

app.post('/api/admin/cancel-order', requireAdmin, (req, res) => {
    const { orderId } = req.body;
    const order = orderStmts.getById.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
    orderStmts.cancel.run(orderId);
    res.json({ success: true });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
    orderStmts.expireOld.run();
    const orders = orderStmts.allPending.all();
    res.json(orders);
});

// ─── User Stats ───────────────────────────────────────────────────────────────
app.get('/api/user/stats', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const jobStats = logStmts.countByUser.get(userId);
    const orderStats = orderStmts.countByUser.get(userId);
    res.json({ jobs: jobStats?.total || 0, total_channels: jobStats?.total_channels || 0, orders: orderStats?.total || 0 });
});

app.get('/api/user/logs', requireAuth, (req, res) => {
    const logs = logStmts.recent.all(req.session.userId);
    res.json(logs);
});

// ═══════════════════════════════════════════════════════════════
//  DISCORD BOT ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/stream', requireAuth, botController.handleStream);
app.post('/api/start', requireAuth, msgUpload.single('attachment'), botController.handleStartJob);
app.post('/api/stop', requireAuth, botController.handleStopJob);

// ─── Serve dashboard for all non-api routes (SPA) ────────────────────────────
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ═══════════════════════════════════════════════════════════════
//  OWNER-ONLY ROUTES
// ═══════════════════════════════════════════════════════════════

// Get all users
app.get('/api/owner/users', requireOwner, (req, res) => {
    const users = userStmts.allUsers.all();
    res.json(users);
});

// System-wide stats
app.get('/api/owner/stats', requireOwner, (req, res) => {
    const totalUsers = userStmts.countAll.get();
    const { db } = require('./database');
    const allJobs = db.prepare(`SELECT COUNT(*) as jobs, SUM(channels) as channels FROM job_logs`).get();
    const allOrders = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='confirmed' THEN amount ELSE 0 END) as revenue FROM orders`).get();
    const activeCount = botController.activeJobs.size;
    res.json({
        totalUsers: totalUsers.total,
        totalJobs: allJobs.jobs || 0,
        totalChannels: allJobs.channels || 0,
        totalOrders: allOrders.total || 0,
        revenue: allOrders.revenue || 0,
        activeJobs: activeCount,
    });
});

// Set credits for any user
app.post('/api/owner/set-credits', requireOwner, (req, res) => {
    const { userId, credits } = req.body;
    if (userId === undefined || credits === undefined) return res.status(400).json({ error: 'userId and credits required.' });
    const user = userStmts.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    userStmts.setCredits.run(parseInt(credits), userId);
    res.json({ success: true, message: `Credits set to ${credits} for ${user.username}.` });
});

// Add credits to any user
app.post('/api/owner/add-credits', requireOwner, (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required.' });
    const user = userStmts.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    userStmts.addCredits.run(parseInt(amount), userId);
    res.json({ success: true, message: `Added ${amount} credits to ${user.username}.` });
});

// Set role for a user
app.post('/api/owner/set-role', requireOwner, (req, res) => {
    const { userId, role } = req.body;
    const validRoles = ['user', 'admin', 'owner'];
    if (!userId || !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid userId or role.' });
    const user = userStmts.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    userStmts.setRole.run(role, userId);
    res.json({ success: true, message: `${user.username} is now ${role}.` });
});

// Delete user
app.delete('/api/owner/user/:id', requireOwner, (req, res) => {
    const userId = parseInt(req.params.id);
    const user = userStmts.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete owner.' });
    userStmts.deleteUser.run(userId);
    res.json({ success: true, message: `User ${user.username} deleted.` });
});

// Force-stop any running job
app.post('/api/owner/force-stop', requireOwner, (req, res) => {
    const { jobId } = req.body;
    if (jobId) {
        if (botController.activeJobs.has(jobId)) {
            botController.broadcastLog(jobId, 'stop', '⭕ Force-stopped oleh Owner.');
            botController.activeJobs.get(jobId).clients.forEach(c => { try { c.end(); } catch (e) {} });
            botController.activeJobs.delete(jobId);
        }
    } else {
        // Stop ALL jobs
        for (const [jid] of botController.activeJobs) {
            botController.broadcastLog(jid, 'stop', '⭕ Semua job dihentikan oleh Owner.');
            botController.activeJobs.get(jid).clients.forEach(c => { try { c.end(); } catch (e) {} });
        }
        botController.activeJobs.clear();
    }
    res.json({ success: true });
});

// List all active jobs
app.get('/api/owner/active-jobs', requireOwner, (req, res) => {
    const jobs = [];
    for (const [jid, job] of botController.activeJobs) {
        jobs.push({ jobId: jid, userId: job.userId, clients: job.clients.size });
    }
    res.json(jobs);
});

// Confirm order (owner + packages type-aware)
app.post('/api/owner/confirm-order', requireOwner, (req, res) => {
    const { orderId } = req.body;
    const order = orderStmts.getById.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
    orderStmts.confirm.run(orderId);
    const pkg = PACKAGES.find(p => p.id === order.package_id);
    if (pkg && pkg.type === 'console') {
        userStmts.addConsoles.run(pkg.consoles || 1, order.user_id);
    } else {
        userStmts.addCredits.run(order.credits, order.user_id);
    }
    res.json({ success: true });
});

// Cancel order (owner)
app.post('/api/owner/cancel-order', requireOwner, (req, res) => {
    const { orderId } = req.body;
    const order = orderStmts.getById.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Order already ${order.status}.` });
    orderStmts.cancel.run(orderId);
    res.json({ success: true });
});

// Discount management
app.get('/api/owner/discount', requireOwner, (req, res) => {
    res.json({ discount: globalDiscount });
});
app.post('/api/owner/set-discount', requireOwner, (req, res) => {
    const { discount } = req.body;
    const d = parseInt(discount);
    if (isNaN(d) || d < 0 || d > 100) return res.status(400).json({ error: 'Discount must be 0-100.' });
    globalDiscount = d;
    res.json({ success: true, discount: globalDiscount });
});

// Set extra_consoles directly (owner)
app.post('/api/owner/set-consoles', requireOwner, (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || amount === undefined) return res.status(400).json({ error: 'userId and amount required.' });
    userStmts.addConsoles.run(parseInt(amount), userId);
    res.json({ success: true });
});

// User: get their own extra_consoles count
app.get('/api/user/consoles', requireAuth, (req, res) => {
    const user = userStmts.findById.get(req.session.userId);
    res.json({ extra_consoles: user?.extra_consoles ?? 0, total: (user?.extra_consoles ?? 0) + 1 });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => { console.log('HTTP server closed.'); process.exit(0); });
});
process.on('SIGINT', () => {
    server.close(() => { process.exit(0); });
});
