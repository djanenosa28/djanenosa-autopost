// ─── State ─────────────────────────────────────────────────────────────────
let currentUser = null;
let activeEventSources = {};
let orderTimerInterval = null;
let dispatchCount = 0;
window._consoleJobs = {};

// ─── Navigation ────────────────────────────────────────────────────────────
function navigateTo(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.bn-item').forEach(l => l.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll(`[data-page="${page}"]`).forEach(el => el.classList.add('active'));
    if (page === 'home') loadHome();
    if (page === 'shop') loadShop();
    if (page === 'account') loadAccount();
    if (page === 'owner') loadOwnerPanel();
    // Help page has static content, no load needed
}

// ─── Init ───────────────────────────────────────────────────────────────────
async function init() {
    try {
        const r = await fetch('/api/auth/me');
        if (!r.ok) { window.location = '/'; return; }
        currentUser = await r.json();
        document.getElementById('homeUsername').textContent = currentUser.username;
        // Show ∞ for unlimited credits (-1)
        const credDisplay = currentUser.credits === -1 ? '∞' : currentUser.credits;
        document.getElementById('sbCredits').textContent = credDisplay;
        const mCred = document.getElementById('sbCreditsMobile'); if (mCred) mCred.textContent = credDisplay;
        document.getElementById('accAvatar').textContent = currentUser.username[0].toUpperCase();
        // Show Owner nav link if owner
        if (currentUser.role === 'owner') {
            document.getElementById('ownerNavLink').style.display = 'flex';
            const bnOwner = document.getElementById('ownerBnItem'); if (bnOwner) bnOwner.style.display = 'flex';
        }
        loadHome();
        initConsoleList(); // init console slot section visibility
    } catch {
        window.location = '/';
    }
}

// ─── Logout ─────────────────────────────────────────────────────────────────
async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location = '/';
}

// Also update refreshCredits to handle unlimited
async function refreshCredits() {
    const r = await fetch('/api/auth/me');
    if (r.ok) {
        const d = await r.json();
        currentUser = d;
        const credDisplay = d.credits === -1 ? '∞' : d.credits;
        document.getElementById('sbCredits').textContent = credDisplay;
        const mCred = document.getElementById('sbCreditsMobile'); if (mCred) mCred.textContent = credDisplay;
        const hcEl = document.getElementById('homeCredits'); if (hcEl) hcEl.textContent = credDisplay;
        const acEl = document.getElementById('accCredits'); if (acEl) acEl.textContent = credDisplay;
    }
}

// ─── HOME PAGE ───────────────────────────────────────────────────────────────
async function loadHome() {
    await refreshCredits();
    try {
        const [statsR, logsR] = await Promise.all([
            fetch('/api/user/stats').then(r => r.json()),
            fetch('/api/user/logs').then(r => r.json()),
        ]);
        document.getElementById('homeCredits').textContent = currentUser.credits;
        document.getElementById('homeJobs').textContent = statsR.jobs ?? 0;
        document.getElementById('homeChannels').textContent = statsR.total_channels ?? 0;
        document.getElementById('homeOrders').textContent = statsR.orders ?? 0;

        const logContainer = document.getElementById('recentLogs');
        if (!logsR.length) {
            logContainer.innerHTML = '<div class="log-empty">No activity yet. Run your first job!</div>';
        } else {
            logContainer.innerHTML = logsR.map(l => `
                <div class="log-row">
                    <span>${new Date(l.created_at).toLocaleString('id-ID')}</span>
                    <span>${l.channels} channels</span>
                    <span class="${l.status ==='completed' ? 'highlight' : ''}">${l.status}</span>
                </div>
            `).join('');
        }
    } catch (e) { console.error(e); }
}

// ─── CONSOLE PAGE ─────────────────────────────────────────────────────────────
function countChannels() {
    const channels = document.getElementById('dcChannels').value.split(/[\n,]+/).filter(s => s.trim());
    document.getElementById('chCount').textContent = `${channels.length} channels`;
}

function handleTokenWarn() {
    document.getElementById('tokenWarn').style.display =
        document.getElementById('dcTokenType').value === 'user' ? 'block' : 'none';
}

function togglePw(id, btn) {
    const inp = document.getElementById(id);
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? '👁️' : '🙈';
}

function addLog(message, type = 'info') {
    const logEl = document.getElementById('liveLog');
    const now = new Date().toLocaleTimeString('id-ID');
    const div = document.createElement('div');
    div.className = `log-e log-${type}`;
    div.innerHTML = `<span>[${now}]</span><span>${escapeHtml(message)}</span>`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;

    if (type === 'error' || type === 'stop') {
        stopUIReset();
    }
}

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function initSSE(jobId) {
    if (activeEventSources[jobId]) activeEventSources[jobId].close();
    const es = new EventSource(`/api/stream?jobId=${jobId}`);
    activeEventSources[jobId] = es;
    
    if (!window._consoleJobs) window._consoleJobs = {};
    if (!window._consoleJobs[jobId]) window._consoleJobs[jobId] = { running: true, channelCount: '...' };

    es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        addLog(`[Job ${jobId}] ` + data.message, data.type);
        if (data.incrementOk) {
            dispatchCount++;
            document.getElementById('dispatchCount').textContent = dispatchCount;
        }
        if (data.type === 'stop' || data.type === 'error') {
            es.close();
            delete activeEventSources[jobId];
            if (window._consoleJobs[jobId]) window._consoleJobs[jobId].running = false;
            renderConsoleList();
            setTimeout(refreshCredits, 500);
        }
    };
    es.onerror = () => {
        addLog(`⚠️ [Job ${jobId}] Connection lost...`, 'warning');
    };
}

document.addEventListener('DOMContentLoaded', () => {
    init();

    document.getElementById('posterForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const err = document.getElementById('consoleErr');
        err.style.display = 'none';

        const token = document.getElementById('dcToken').value;
        const tokenType = document.getElementById('dcTokenType').value;
        const channelIds = document.getElementById('dcChannels').value;
        const message = document.getElementById('dcMessage').value;
        const durationMin = document.getElementById('dcDuration').value;
        const loopIntervalSec = document.getElementById('dcLoop').value;
        const fileInput = document.getElementById('dcAttachment');

        if (!message && fileInput.files.length === 0) {
            err.textContent = 'Message or attachment required.';
            err.style.display = 'block'; return;
        }

        const activeCount = Object.values(window._consoleJobs || {}).filter(j => j.running).length;
        const limit = (currentUser && currentUser.role === 'owner') ? 999 : (window._consoleSlotsTotal || 1);
        if (activeCount >= limit) {
            err.textContent = 'Maksimal console berjalan telah tercapai. Beli More Console di Shop untuk menambah slot.';
            err.style.display = 'block'; return;
        }

        const startBtn = document.getElementById('startBtn');
        startBtn.textContent = 'Starting...'; startBtn.disabled = true;

        const fd = new FormData();
        fd.append('token', token); fd.append('tokenType', tokenType);
        fd.append('channelIds', channelIds); fd.append('message', message);
        fd.append('durationMin', durationMin); fd.append('loopIntervalSec', loopIntervalSec);
        if (fileInput.files.length > 0) fd.append('attachment', fileInput.files[0]);

        try {
            const r = await fetch('/api/start', { method: 'POST', body: fd });
            const d = await r.json();

            if (d.success) {
                const jobId = d.jobId;
                window._consoleJobs[jobId] = { running: true, channelCount: channelIds.split(/[\n,]+/).filter(i=>i.trim()).length };
                initSSE(jobId);
                renderConsoleList(); // Update UI
                addLog(`📡 Job ${jobId} started. Connecting to telemetry...`, 'info');
                
                // Reset form to allow multiple starts
                document.getElementById('posterForm').reset();
                document.getElementById('chCount').textContent = '0 channels';
                startBtn.textContent = '🚀 Start'; startBtn.disabled = false;
            } else {
                err.textContent = d.error || 'Failed to start.'; err.style.display = 'block';
                startBtn.textContent = '🚀 Start'; startBtn.disabled = false;
            }
        } catch (ex) {
            err.textContent = 'Network error.'; err.style.display = 'block';
            startBtn.textContent = '🚀 Start'; startBtn.disabled = false;
        }
    });
});

async function stopJob(jobId) {
    if (!jobId) return;
    try {
        const r = await fetch('/api/stop', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId })
        });
        const d = await r.json();
        if (!d.success) alert(d.error);
    } catch (e) { console.error('Stop error', e); }
}

// ─── SHOP PAGE ────────────────────────────────────────────────────────────────
let activeOrderId = null, activeOrderExpiry = null;

async function loadShop() {
    const r = await fetch('/api/shop/packages');
    const pkgs = await r.json();
    const grid = document.getElementById('shopPackages');
    grid.innerHTML = pkgs.map((p, i) => {
        const isConsole = p.type === 'console';
        const discountBadge = p.discount > 0 ? `<div class="pkg-discount-badge">🔥 DISKON ${p.discount}%</div>` : '';
        const priceHtml = p.discount > 0
            ? `<div class="pkg-price"><span class="pkg-orig-price">Rp${p.originalPrice.toLocaleString('id-ID')}</span> Rp${p.price.toLocaleString('id-ID')}</div>`
            : `<div class="pkg-price">Rp${p.price.toLocaleString('id-ID')}</div>`;
        if (isConsole) {
            return `
            <div class="pkg-card console-pkg" onclick="buyPackage('${p.id}')">
                ${discountBadge}
                <div class="pkg-label">🖥 Extra Feature</div>
                <div class="pkg-name">${p.name}</div>
                <div class="pkg-credits">+1 <span>Console Slot</span></div>
                <div class="pkg-desc">Jalankan lebih dari 1 auto-poster secara bersamaan. Slot tidak habis — permanen!</div>
                ${priceHtml}
                <button class="btn-primary pkg-btn" type="button">Beli Sekarang →</button>
            </div>`;
        }
        return `
        <div class="pkg-card ${i===2?'featured':''}" onclick="buyPackage('${p.id}')">
            ${discountBadge}
            ${i===2 ? '<div class="pkg-label">⭐ Most Popular</div>' : '<div class="pkg-label">Credits Pack</div>'}
            <div class="pkg-name">${p.name}</div>
            <div class="pkg-credits">${p.credits} <span>credits</span></div>
            ${priceHtml}
            <button class="btn-primary pkg-btn" type="button">Buy Now →</button>
        </div>`;
    }).join('');
}


async function buyPackage(packageId) {
    const pkgRes = await fetch('/api/shop/packages').then(r => r.json());
    const pkg = pkgRes.find(p => p.id === packageId);
    if (!pkg) return;

    const r = await fetch('/api/shop/order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId })
    });
    const d = await r.json();

    if (!d.success) {
        alert(d.error || 'Failed to create order.'); return;
    }

    activeOrderId = d.orderId;
    activeOrderExpiry = new Date(d.expiresAt);

    document.getElementById('checkoutPkgName').textContent = pkg.name;
    document.getElementById('checkoutPkgDesc').textContent = `${pkg.credits} credits akan ditambahkan setelah admin konfirmasi pembayaran.`;
    document.getElementById('checkoutPrice').textContent = `Rp${pkg.price.toLocaleString('id-ID')}`;
    
    // Tampilkan rekening bank
    const bankContainer = document.getElementById('bankAccountsContainer');
    if (d.accounts && d.accounts.length) {
        bankContainer.innerHTML = d.accounts.map(acc => `
            <div class="bank-card">
                <div class="bank-name">${acc.bank}</div>
                <div class="bank-number">${acc.number}</div>
                <div class="bank-holder">a/n ${acc.name}</div>
            </div>
        `).join('');
    } else {
        bankContainer.innerHTML = `<div class="bank-card">Tidak ada rekening tersedia. Hubungi admin.</div>`;
    }

    document.getElementById('checkoutPanel').style.display = 'block';
    startOrderTimer();
}

function startOrderTimer() {
    if (orderTimerInterval) clearInterval(orderTimerInterval);
    let pollCounter = 0;
    orderTimerInterval = setInterval(async () => {
        if (!activeOrderExpiry) return;
        const diff = activeOrderExpiry - new Date();
        if (diff <= 0) {
            clearInterval(orderTimerInterval);
            document.getElementById('orderTimer').textContent = 'EXPIRED';
            document.getElementById('checkoutPanel').style.display = 'none';
            return;
        }
        const h = Math.floor(diff/3600000).toString().padStart(2,'0');
        const m = Math.floor((diff%3600000)/60000).toString().padStart(2,'0');
        const s = Math.floor((diff%60000)/1000).toString().padStart(2,'0');
        document.getElementById('orderTimer').textContent = `${h}:${m}:${s}`;
        
        // Poll status every 3 seconds
        pollCounter++;
        if (activeOrderId && pollCounter % 3 === 0) {
            try {
                const r = await fetch(`/api/shop/order-status/${activeOrderId}`);
                if (r.ok) {
                    const d = await r.json();
                    if (d.status === 'confirmed') {
                        clearInterval(orderTimerInterval);
                        document.getElementById('checkoutPanel').style.display = 'none';
                        showOrderSuccess();
                    } else if (d.status === 'cancelled') {
                        clearInterval(orderTimerInterval);
                        document.getElementById('checkoutPanel').style.display = 'none';
                        alert('Order dibatalkan oleh Admin.');
                        activeOrderId = null; activeOrderExpiry = null;
                    }
                }
            } catch(e) {}
        }
    }, 1000);
}

function showOrderSuccess() {
    activeOrderId = null; activeOrderExpiry = null;
    const shopSection = document.getElementById('page-shop');
    const successOverlay = document.createElement('div');
    successOverlay.className = 'glass';
    successOverlay.style = 'margin-top:2rem; padding: 2.5rem; border: 1px solid var(--success); background: var(--surface-hover); text-align: center; border-radius: 8px;';
    successOverlay.innerHTML = `
        <div style="font-size: 3rem; margin-bottom: 1rem; color: var(--success)">✓</div>
        <h2 style="color: var(--text); margin-bottom: .5rem; font-weight: 600;">Order Berhasil!</h2>
        <p style="color: var(--text-muted); font-size: 1.1rem">Uang sudah diterima Admin. Item telah otomatis masuk ke akunmu.</p>
        <button class="btn-primary" style="margin-top: 1.5rem; padding: .6rem 2rem; font-size: 1rem;" onclick="this.parentElement.remove()">Tutup</button>
    `;
    const header = shopSection.querySelector('.page-header');
    header.after(successOverlay);
    
    refreshCredits();
    initConsoleList(); // refresh slots internally
}

async function cancelCheckout() {
    clearInterval(orderTimerInterval);
    document.getElementById('checkoutPanel').style.display = 'none';
    if (activeOrderId) {
        try {
            await fetch('/api/shop/cancel-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: activeOrderId })
            });
        } catch (e) { console.error('Cancel order error', e); }
    }
    activeOrderId = null; activeOrderExpiry = null;
}

// ─── ACCOUNT PAGE ──────────────────────────────────────────────────────────────
async function loadAccount() {
    await refreshCredits();
    document.getElementById('accUsername').textContent = currentUser.username;
    document.getElementById('accEmail').textContent = currentUser.email;
    document.getElementById('accRole').textContent = currentUser.role.charAt(0).toUpperCase() + currentUser.role.slice(1);
    document.getElementById('accCredits').textContent = currentUser.credits;
    document.getElementById('accAvatar').textContent = currentUser.username[0].toUpperCase();
    document.getElementById('accJoined').textContent = new Date(currentUser.created_at).toLocaleDateString('id-ID', { year:'numeric', month:'long', day:'numeric' });

    if (currentUser.role === 'admin') {
        document.getElementById('adminPanel').style.display = 'block';
        loadPendingOrders();
    }
}

async function loadPendingOrders() {
    const r = await fetch('/api/admin/orders');
    const orders = await r.json();
    const el = document.getElementById('pendingOrders');
    if (!orders.length) { el.innerHTML = '<div class="log-empty">No pending orders.</div>'; return; }
    el.innerHTML = orders.map(o => `
        <div class="order-item">
            <div>
                <b>${o.username}</b> — ${o.credits} credits<br>
                <small>Rp${parseInt(o.amount).toLocaleString('id-ID')} | Expires: ${new Date(o.expires_at).toLocaleString('id-ID')}</small>
            </div>
            <button class="btn-primary sm" onclick="confirmOrder(${o.id},this)">Confirm</button>
        </div>
    `).join('');
}

async function confirmOrder(orderId, btn) {
    btn.textContent = '...'; btn.disabled = true;
    const r = await fetch('/api/admin/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId })
    });
    const d = await r.json();
    if (d.success) { loadPendingOrders(); refreshCredits(); }
    else { btn.textContent = 'Confirm'; btn.disabled = false; alert(d.error); }
}

// ─── OWNER PANEL ─────────────────────────────────────────────────────────────
async function loadOwnerPanel() {
    await Promise.all([loadOwnerStats(), loadOwnerUsers(), loadOwnerActiveJobs(), loadOwnerOrders()]);
}

async function loadOwnerStats() {
    const r = await fetch('/api/owner/stats');
    if (!r.ok) return;
    const d = await r.json();
    document.getElementById('ownerTotalUsers').textContent = d.totalUsers;
    document.getElementById('ownerTotalJobs').textContent = d.totalJobs;
    document.getElementById('ownerTotalChannels').textContent = d.totalChannels;
    document.getElementById('ownerRevenue').textContent = `${(d.revenue||0).toLocaleString('id-ID')}`;
    document.getElementById('ownerActiveJobs').textContent = d.activeJobs;
}

async function loadOwnerActiveJobs() {
    const r = await fetch('/api/owner/active-jobs');
    const jobs = await r.json();
    const el = document.getElementById('ownerActiveJobsList');
    if (!jobs.length) { el.innerHTML = '<span style="color:var(--text-muted)">No active jobs.</span>'; return; }
    el.innerHTML = jobs.map(j => `
        <div class="order-item">
            <div><b>Job ${j.jobId}</b> | User #${j.userId} | Clients: ${j.clients}</div>
            <button class="btn-danger" style="padding:.4rem .8rem;font-size:.8rem" onclick="ownerForceStop('${j.jobId}',this)">Force Stop</button>
        </div>
    `).join('');
}

async function ownerForceStop(jobId, btn) {
    if (btn) { btn.textContent='...'; btn.disabled=true; }
    await fetch('/api/owner/force-stop', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jobId }) });
    setTimeout(() => loadOwnerPanel(), 500);
}
async function ownerForceStopAll() {
    if (!confirm('Stop ALL running jobs?')) return;
    await fetch('/api/owner/force-stop', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) });
    setTimeout(() => loadOwnerPanel(), 500);
}

async function loadOwnerUsers() {
    const r = await fetch('/api/owner/users');
    const users = await r.json();
    const el = document.getElementById('ownerUsersList');
    el.innerHTML = users.map(u => `
        <div class="order-item" style="flex-wrap:wrap;gap:.5rem">
            <div style="min-width:0;flex:1">
                <b>${u.username}</b> <span class="badge">${u.role}</span><br>
                <small style="color:var(--text-muted)">${u.email}</small><br>
                <small style="color:var(--accent)">💎 Kredit: <b>${u.credits === -1 ? '∞ Unlimited' : u.credits}</b> &nbsp;|&nbsp; 🖥 Console Slot: <b>${(u.extra_consoles || 0) + 1}</b></small>
            </div>
            <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
                <input type="number" placeholder="Kredit" id="cr_${u.id}" style="width:85px;padding:.35rem .5rem;font-size:.8rem">
                <button class="btn-primary sm" onclick="ownerSetCredits(${u.id})" title="Set kredit ke nilai">Set</button>
                <button class="btn-primary sm" style="background:rgba(63,185,80,.2);border:1px solid rgba(63,185,80,.4)" onclick="ownerAddCredits(${u.id})" title="Tambah kredit">+Add</button>
                <input type="number" placeholder="Console" id="con_${u.id}" min="1" style="width:85px;padding:.35rem .5rem;font-size:.8rem">
                <button class="btn-primary sm" style="background:rgba(99,102,241,.2);border:1px solid rgba(99,102,241,.4)" onclick="ownerAddConsoles(${u.id})" title="Tambah slot console">+Con</button>
                <select id="role_${u.id}" style="padding:.35rem .5rem;font-size:.8rem;width:85px">
                    <option value="user" ${u.role==='user'?'selected':''}>user</option>
                    <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
                    <option value="owner" ${u.role==='owner'?'selected':''}>owner</option>
                </select>
                <button class="btn-primary sm" onclick="ownerSetRole(${u.id})">Role</button>
                ${u.role !== 'owner' ? `<button class="btn-danger" style="padding:.35rem .6rem;font-size:.8rem" onclick="ownerDeleteUser(${u.id},'${u.username}')">🗑</button>` : ''}
            </div>
        </div>
    `).join('');
}

async function ownerSetCredits(userId) {
    const val = document.getElementById(`cr_${userId}`).value;
    if (val === '') return alert('Enter a credit value (-1 for unlimited)');
    const r = await fetch('/api/owner/set-credits', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, credits: parseInt(val) }) });
    const d = await r.json();
    if (d.success) loadOwnerUsers(); else alert(d.error);
}
async function ownerAddCredits(userId) {
    const val = document.getElementById(`cr_${userId}`).value;
    if (!val) return alert('Enter amount to add');
    const r = await fetch('/api/owner/add-credits', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, amount: parseInt(val) }) });
    const d = await r.json();
    if (d.success) loadOwnerUsers(); else alert(d.error);
}
async function ownerSetRole(userId) {
    const role = document.getElementById(`role_${userId}`).value;
    const r = await fetch('/api/owner/set-role', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, role }) });
    const d = await r.json();
    if (d.success) loadOwnerUsers(); else alert(d.error);
}
async function ownerDeleteUser(userId, username) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    const r = await fetch(`/api/owner/user/${userId}`, { method:'DELETE' });
    const d = await r.json();
    if (d.success) loadOwnerUsers(); else alert(d.error);
}

async function loadOwnerOrders() {
    const r = await fetch('/api/admin/orders');
    const orders = await r.json();
    const el = document.getElementById('ownerOrdersList');
    if (!orders.length) { el.innerHTML = '<div class="log-empty">No pending orders.</div>'; return; }
    el.innerHTML = orders.map(o => `
        <div class="order-item">
            <div>
                <b>${o.username}</b> — ${o.package_id === 'more_console' ? '🖥 +1 Console Slot' : `${o.credits} credits`}<br>
                <small>Rp${parseInt(o.amount).toLocaleString('id-ID')} | Pkg: ${o.package_id} | ${new Date(o.created_at).toLocaleString('id-ID')}</small>
            </div>
            <div style="display:flex;gap:.5rem">
                <button class="btn-primary sm" onclick="ownerConfirmOrder(${o.id},this)">✔ Confirm</button>
                <button class="btn-danger" style="padding:.35rem .7rem;font-size:.8rem" onclick="ownerCancelOrder(${o.id},this)">✕ Cancel</button>
            </div>
        </div>
    `).join('');
}
async function ownerConfirmOrder(orderId, btn) {
    btn.textContent='...'; btn.disabled=true;
    const r = await fetch('/api/owner/confirm-order', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ orderId }) });
    const d = await r.json();
    if (d.success) loadOwnerOrders(); else { btn.textContent='✔ Confirm'; btn.disabled=false; alert(d.error); }
}
async function ownerCancelOrder(orderId, btn) {
    if (!confirm('Cancel dan hapus order ini?')) return;
    btn.textContent='...'; btn.disabled=true;
    const r = await fetch('/api/owner/cancel-order', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ orderId }) });
    const d = await r.json();
    if (d.success) loadOwnerOrders(); else { btn.textContent='✕ Cancel'; btn.disabled=false; alert(d.error); }
}

// ─── Owner: Discount ─────────────────────────────────────────────────────
async function loadOwnerDiscount() {
    const r = await fetch('/api/owner/discount');
    if (!r.ok) return;
    const d = await r.json();
    const el = document.getElementById('ownerDiscountDisplay');
    const range = document.getElementById('discountRange');
    const val = document.getElementById('discountVal');
    if (el) el.textContent = d.discount + '%';
    if (range) range.value = d.discount;
    if (val) val.textContent = d.discount + '%';
}
async function ownerSetDiscount() {
    const val = parseInt(document.getElementById('discountRange').value);
    await ownerSetDiscountDirect(val);
}
async function ownerSetDiscountDirect(val) {
    const r = await fetch('/api/owner/set-discount', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ discount: val }) });
    const d = await r.json();
    if (d.success) {
        document.getElementById('ownerDiscountDisplay').textContent = d.discount + '%';
        document.getElementById('discountRange').value = d.discount;
        document.getElementById('discountVal').textContent = d.discount + '%';
    }
}

// ─── Owner: User Management extras ──────────────────────────────────────────
async function ownerGiveConsole(userId) {
    const r = await fetch('/api/owner/set-consoles', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ userId, amount: 1 }) });
    if ((await r.json()).success) loadOwnerUsers();
}
async function ownerAddConsoles(userId) {
    const val = parseInt(document.getElementById(`con_${userId}`)?.value);
    if (!val || val < 1) return alert('Masukkan jumlah console yang ingin ditambahkan (min 1)');
    const r = await fetch('/api/owner/set-consoles', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ userId, amount: val }) });
    const d = await r.json();
    if (d.success) loadOwnerUsers(); else alert(d.error);
}

// Update loadOwnerPanel to also load discount
const _origLoadOwnerPanel = loadOwnerPanel;
async function loadOwnerPanel() {
    await Promise.all([loadOwnerStats(), loadOwnerUsers(), loadOwnerActiveJobs(), loadOwnerOrders(), loadOwnerDiscount()]);
}

// ─── Multi-Console List (visible only to users with extra_consoles) ─────────────
async function initConsoleList() {
    const r = await fetch('/api/user/consoles');
    if (!r.ok) return;
    const d = await r.json();

    renderConsoleList();

    const grid = document.getElementById('consoleListGrid');
    const overlay = document.getElementById('consoleUpgradeOverlay');
    
    // Always show clear if they have extra consoles OR if they are owner
    // If not, blur the grid and show the overlay wrapper
    if (d.extra_consoles > 0 || (currentUser && currentUser.role === 'owner')) {
        if (grid) grid.classList.remove('locked-grid');
        if (overlay) overlay.style.display = 'none';
    } else {
        if (grid) grid.classList.add('locked-grid');
        if (overlay) overlay.style.display = 'flex';
    }

    // Store slot info globally
    window._consoleSlotsTotal = d.total;
}

// Render list of all running consoles into the grid
function renderConsoleList() {
    const grid = document.getElementById('consoleListGrid');
    if (!grid) return;
    const jobs = [];
    for (const [jid, job] of Object.entries(window._consoleJobs || {})) {
        jobs.push({ jid, ...job });
    }
    
    const activeCount = jobs.filter(j => j.running).length;
    const limitDisplay = (currentUser && currentUser.role === 'owner') ? '∞' : (window._consoleSlotsTotal || 1);
    const useEl = document.getElementById('consoleSlotUsage');
    if (useEl) useEl.textContent = `${activeCount}/${limitDisplay}`;

    if (!jobs.length) {
        grid.innerHTML = '<div class="log-empty" style="padding:1rem">Belum ada console aktif. Tekan Start di form bawah untuk menjalankan.</div>';
        return;
    }
    grid.innerHTML = jobs.map(j => `
        <div class="console-list-card glass" style="${j.running ? 'border: 1px solid rgba(63,185,80,0.3); background: rgba(63,185,80,0.05);' : ''}">
            <div class="clc-header">
                <span class="clc-title">📽 Console #${j.jid.substring(j.jid.length-5)}</span>
                <span class="clc-status ">${j.running ? '<span class="running-dot"></span> Running' : 'Stopped'}</span>
            </div>
            <div class="clc-body">Channels: ${j.channelCount || '?'}</div>
            ${j.running ? `<button class="btn-danger" style="width:100%;margin-top:.5rem" onclick="stopJob('${j.jid}')">Stop</button>` : ''}
        </div>
    `).join('');
}

// Track multi-console jobs map
if (!window._consoleJobs) window._consoleJobs = {};

// Override DOMContentLoaded to also init console list
const _existingInit = init;
window.addEventListener('DOMContentLoaded', () => {
    // console list init is triggered after login
});

// Called after login/init to set up console slots
async function postInit() {
    await initConsoleList();
}
// Patch init to call postInit
const __origInit = window._initDone;
