const { userStmts, logStmts } = require('./database');

// activeJobs is ephemeral on Vercel. We keep it for local/VPS, 
// but on Vercel we must accept it will be cleared or hit 404 on stream.
const activeJobs = new Map();

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
                    retryAfter = body.retry_after || 5;
                } catch (_) {}
                await new Promise(r => setTimeout(r, Math.ceil(retryAfter * 1000) + 200));
                continue;
            }

            const body = await resp.json().catch(() => ({}));
            return { success: false, error: body.message || `HTTP ${resp.status}`, status: resp.status };
        } catch (fetchErr) {
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2000));
            } else {
                return { success: false, error: fetchErr.message };
            }
        }
    }
    return { success: false, error: `Max retries reached` };
}

async function executeWaveConcurrent(jobId, channels, token, isBot, message, fileData, batchDelayMs) {
    const BATCH_SIZE = 5; // Reduced for Vercel duration limits
    let sent = 0;

    for (let batchStart = 0; batchStart < channels.length; batchStart += BATCH_SIZE) {
        if (!activeJobs.has(jobId)) return { sent, error: 'Stopped' };
        
        const batch = channels.slice(batchStart, batchStart + BATCH_SIZE);
        broadcastLog(jobId, 'info', `📦 Batch ${Math.floor(batchStart/BATCH_SIZE)+1} (${batch.length} ch)...`);

        const results = await Promise.all(
            batch.map(channelId => sendWithRetry(jobId, token, isBot, channelId, message, fileData))
        );

        for (let i = 0; i < results.length; i++) {
            const r = results[i], ch = batch[i];
            if (r.success) {
                sent++;
                broadcastLog(jobId, 'success', `✔️ OK -> ${ch}`, { incrementOk: true });
            } else {
                broadcastLog(jobId, 'error', `❌ FAIL -> ${ch}: ${r.error}`);
            }
        }
        if (batchStart + BATCH_SIZE < channels.length) {
            await new Promise(r => setTimeout(r, batchDelayMs));
        }
    }
    return { sent, error: null };
}

function handleStream(req, res) {
    const { jobId } = req.query;
    if (!jobId || !activeJobs.has(jobId)) {
        // Vercel Instance Mismatch: Job started on one instance, stream hits another.
        // We return a dummy stream to keep frontend happy if needed, or 404.
        return res.status(404).end();
    }
    
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

async function handleStartJob(req, res) {
    const { token, tokenType, message, channelIds, durationMin, loopIntervalSec } = req.body;
    const fileData = req.file;
    const userId = req.session.userId;

    if (!token || !channelIds) return res.status(400).json({ error: 'Token/Channels required.' });

    try {
        const creditRow = await userStmts.getCredits(userId);
        if (!creditRow || (!isUnlimited(creditRow.credits) && creditRow.credits <= 0)) {
            return res.status(402).json({ error: 'Kredit habis.' });
        }

        const user = await userStmts.findById(userId);
        const activeCount = Array.from(activeJobs.values()).filter(j => j.userId === userId).length;
        const maxJobs = user?.role === 'owner' ? 999 : (user?.extra_consoles || 0) + 1;
        if (activeCount >= maxJobs) return res.status(403).json({ error: 'Slot console penuh.' });

        const duration = Math.max(1, parseInt(durationMin) || 10);
        const endTime = Date.now() + duration * 60 * 1000;
        const loopWaitSec = Math.max(5, parseInt(loopIntervalSec) || 60);
        const channels = channelIds.split(/[\n,]+/).map(id => id.trim()).filter(id => id);
        const jobId = Date.now().toString();

        activeJobs.set(jobId, { status: 'running', clients: new Set(), userId, endTime });

        // Start background execution
        (async () => {
            try {
                let waveNum = 0;
                while (activeJobs.has(jobId)) {
                    waveNum++;
                    
                    const cNow = await userStmts.getCredits(userId);
                    if (!isUnlimited(cNow?.credits)) {
                        const result = await userStmts.deductCredits(userId);
                        if (result.rowsAffected === 0) {
                            broadcastLog(jobId, 'stop', `⭕ Kredit habis!`);
                            activeJobs.delete(jobId);
                            break;
                        }
                    }
                    
                    broadcastLog(jobId, 'info', `\n══ Putaran #${waveNum} ══`);
                    const waveResult = await executeWaveConcurrent(jobId, channels, token, tokenType === 'bot', message, fileData, 1000);
                    await logStmts.insert(userId, waveResult.sent);

                    if (!activeJobs.has(jobId) || waveResult.error || Date.now() >= endTime) {
                        activeJobs.delete(jobId);
                        break;
                    }
                    await new Promise(r => setTimeout(r, loopWaitSec * 1000));
                }
            } catch (e) {
                console.error(`[Job ${jobId}] Error:`, e);
                activeJobs.delete(jobId);
            }
        })();

        res.json({ success: true, jobId });
    } catch (err) {
        console.error('[Start Error]', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
}

async function handleStopJob(req, res) {
    const { jobId } = req.body;
    if (!activeJobs.has(jobId)) return res.status(404).json({ error: 'Job not found.' });
    activeJobs.delete(jobId);
    res.json({ success: true });
}

module.exports = {
    handleStream,
    handleStartJob,
    handleStopJob
};
