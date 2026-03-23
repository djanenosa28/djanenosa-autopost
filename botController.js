const { userStmts, logStmts } = require('./database');

const activeJobs = new Map();

// credits === -1 means unlimited
function isUnlimited(credits) { return credits === -1; }

function broadcastLog(jobId, type, message, extra = {}) {
    if (!activeJobs.has(jobId)) return;
    const job = activeJobs.get(jobId);
    const dataStr = JSON.stringify({ type, message, ...extra });
    job.clients.forEach(client => {
        try { client.write(`data: ${dataStr}\n\n`); } catch (e) {}
    });
}

async function sendWithRetry(jobId, token, isBot, channelId, message, fileData, maxRetries = 3) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const headers = { 'Authorization': isBot ? `Bot ${token}` : token };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (!activeJobs.has(jobId)) return { success: false, error: 'Job stopped' };

        const fd = new FormData();
        if (message) fd.append('payload_json', JSON.stringify({ content: message }));
        if (fileData) {
            const blob = new Blob([fileData.buffer], { type: fileData.mimetype });
            fd.append('files[0]', blob, fileData.originalname);
        }

        try {
            const resp = await fetch(url, { method: 'POST', headers, body: fd });

            if (resp.ok) return { success: true };

            if (resp.status === 429) {
                let retryAfter = 5;
                try {
                    const body = await resp.json();
                    retryAfter = body.retry_after || parseFloat(resp.headers.get('Retry-After')) || 5;
                    if (body.global) {
                        broadcastLog(jobId, 'warning', `🌐 GLOBAL Rate Limit! Menunggu ${retryAfter.toFixed(1)}s...`);
                    } else {
                        broadcastLog(jobId, 'warning', `⏳ Rate Limit ch:${channelId} — menunggu ${retryAfter.toFixed(1)}s (attempt ${attempt}/${maxRetries})`);
                    }
                } catch (_) {}
                await new Promise(r => setTimeout(r, Math.ceil(retryAfter * 1000) + 200));
                continue;
            }

            const body = await resp.json().catch(() => ({}));
            return { success: false, error: body.message || `HTTP ${resp.status}`, status: resp.status };
        } catch (fetchErr) {
            if (attempt < maxRetries) {
                broadcastLog(jobId, 'warning', `🔌 Network error (attempt ${attempt}/${maxRetries}), retrying in 3s...`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                return { success: false, error: fetchErr.message };
            }
        }
    }
    return { success: false, error: `Max retries reached for channel ${channelId}` };
}

async function executeWaveConcurrent(jobId, channels, token, isBot, message, fileData, batchDelayMs) {
    const BATCH_SIZE = 10;
    let sent = 0;

    for (let batchStart = 0; batchStart < channels.length; batchStart += BATCH_SIZE) {
        if (!activeJobs.has(jobId)) return { sent, error: 'Stopped' };

        const batch = channels.slice(batchStart, batchStart + BATCH_SIZE);
        broadcastLog(jobId, 'info', `📦 Batch ${Math.floor(batchStart / BATCH_SIZE) + 1} — ${batch.length} channels in parallel...`);

        const results = await Promise.all(
            batch.map(channelId => sendWithRetry(jobId, token, isBot, channelId, message, fileData))
        );

        for (let i = 0; i < results.length; i++) {
            const r = results[i], ch = batch[i];
            if (r.success) {
                sent++;
                broadcastLog(jobId, 'success', `✔️ Terkirim → ${ch}`, { incrementOk: true });
            } else {
                broadcastLog(jobId, 'error', `❌ Gagal → ${ch}: ${r.error}`);
                if (r.status === 401 || r.status === 403) {
                    broadcastLog(jobId, 'stop', `⭕ Token tidak valid / tidak ada izin. Program dihentikan.`);
                    return { sent, error: r.error };
                }
            }
        }

        if (batchStart + BATCH_SIZE < channels.length && batchDelayMs > 0) {
            broadcastLog(jobId, 'info', `⏸️ Jeda ${batchDelayMs / 1000}s sebelum batch berikutnya...`);
            await new Promise(r => setTimeout(r, batchDelayMs));
        }
    }
    return { sent, error: null };
}

function handleStream(req, res) {
    const { jobId } = req.query;
    if (!jobId || !activeJobs.has(jobId)) return res.status(404).end();
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const job = activeJobs.get(jobId);
    job.clients.add(res);
    req.on('close', () => {
        if (activeJobs.has(jobId)) activeJobs.get(jobId).clients.delete(res);
    });
}

function handleStartJob(req, res) {
    const { token, tokenType, message, channelIds, durationMin, loopIntervalSec } = req.body;
    const fileData = req.file;
    const userId = req.session.userId;

    if (!token || !channelIds) return res.status(400).json({ error: 'Token and Channel IDs required.' });
    if (!message && !fileData) return res.status(400).json({ error: 'Message or attachment required.' });

    const creditRow = userStmts.getCredits.get(userId);
    if (!creditRow || (!isUnlimited(creditRow.credits) && creditRow.credits <= 0)) {
        return res.status(402).json({ error: 'Insufficient credits. Please top up in the Shop.' });
    }

    const userRole = userStmts.findById.get(userId)?.role;
    let userActiveJobsCount = 0;
    for (const [id, job] of activeJobs) {
        if (job.userId === userId) userActiveJobsCount++;
    }
    const maxJobs = userRole === 'owner' ? 999 : (creditRow.extra_consoles || 0) + 1;
    if (userActiveJobsCount >= maxJobs) {
        return res.status(403).json({ error: 'Maksimal console berjalan telah tercapai. Beli More Console di Shop untuk menambah slot.' });
    }

    const duration = Math.max(1, parseInt(durationMin) || 10);
    const endTime = Date.now() + duration * 60 * 1000;
    const batchDelayMs = 1500; 
    const loopWaitSec = Math.max(5, parseInt(loopIntervalSec) || 60);
    const isBot = tokenType === 'bot';
    const channels = channelIds.split(/[\n,]+/).map(id => id.trim()).filter(id => id);

    if (channels.length === 0) return res.status(400).json({ error: 'No valid Channel IDs.' });

    const jobId = Date.now().toString();
    activeJobs.set(jobId, { status: 'running', clients: new Set(), userId });
    console.log(`[Job ${jobId}] User ${userId}. Channels: ${channels.length}`);

    (async () => {
        await new Promise(r => setTimeout(r, 800));

        let waveNum = 0;
        while (activeJobs.has(jobId)) {
            waveNum++;

            const creditRow = userStmts.getCredits.get(userId);
            if (!isUnlimited(creditRow?.credits)) {
                const deducted = userStmts.deductCredits.run(userId);
                if (deducted.changes === 0) {
                    broadcastLog(jobId, 'stop', `⭕ Kredit habis! Auto-poster dihentikan otomatis.`);
                    activeJobs.delete(jobId);
                    break;
                }
            }
            const remaining = userStmts.getCredits.get(userId);
            const creditDisplay = isUnlimited(remaining?.credits) ? '∞ Unlimited' : remaining?.credits ?? 0;
            broadcastLog(jobId, 'info', `\n═══ Putaran #${waveNum} | ${channels.length} Channels | Sisa Kredit: ${creditDisplay} ═══`);

            const result = await executeWaveConcurrent(jobId, channels, token, isBot, message, fileData, batchDelayMs);
            logStmts.insert.run(userId, result.sent);

            if (!activeJobs.has(jobId)) break;
            if (result.error) {
                broadcastLog(jobId, 'stop', `⭕ Dihentikan karena error kritis.`);
                activeJobs.delete(jobId);
                break;
            }

            if (Date.now() >= endTime) {
                broadcastLog(jobId, 'stop', `⏱️ Waktu berjalan (${duration} menit) telah habis. Console selesai.`);
                activeJobs.delete(jobId);
                break;
            }

            broadcastLog(jobId, 'warning', `⏳ Putaran #${waveNum} selesai (${result.sent} pesan). Rehat ${loopWaitSec}s...`);
            let elapsed = 0;
            while (elapsed < loopWaitSec * 1000 && activeJobs.has(jobId) && Date.now() < endTime) {
                await new Promise(r => setTimeout(r, 1000));
                elapsed += 1000;
            }
        }
        
        if (Date.now() >= endTime && activeJobs.has(jobId)) {
            broadcastLog(jobId, 'stop', `⏱️ Waktu berjalan (${duration} menit) telah habis. Console selesai.`);
            activeJobs.delete(jobId);
        }
    })();

    res.json({ success: true, jobId });
}

function handleStopJob(req, res) {
    const { jobId } = req.body;
    if (!activeJobs.has(jobId)) return res.status(404).json({ error: 'Job not found.' });

    broadcastLog(jobId, 'stop', `🛑 Dihentikan oleh pengguna.`);
    activeJobs.get(jobId).clients.forEach(c => { try { c.end(); } catch (e) {} });
    activeJobs.delete(jobId);
    res.json({ success: true });
}

module.exports = {
    activeJobs,
    broadcastLog,
    handleStream,
    handleStartJob,
    handleStopJob
};
