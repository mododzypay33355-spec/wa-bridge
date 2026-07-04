/**
 * WhatsApp Web Bridge — Multi-Session Baileys Server
 * Sessions are persisted in the Laravel database (NOT local disk).
 * Survives Render restarts — no QR re-scan needed!
 */

const express      = require('express');
const QRCode       = require('qrcode');
const axios        = require('axios');
const fs           = require('fs');
const path         = require('path');
const pino         = require('pino');

const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode,
    proto,
    getContentType,
    downloadContentFromMessage,
    initAuthCreds,
    BufferJSON,
    proto: baileyProto,
} = require('@whiskeysockets/baileys');

const app         = express();
const PORT        = process.env.PORT || process.env.WA_BRIDGE_PORT || 3001;
const LARAVEL_URL = process.env.LARAVEL_URL || 'http://localhost:8000';
const API_SECRET  = process.env.WA_BRIDGE_SECRET || 'wa_bridge_secret_2024';

app.use(express.json({ limit: '50mb' }));

const logger = pino({ level: 'info' }, pino.destination('./bridge.log'));

/** Map of userId → { sock, qr, status, phone } */
const sessions  = new Map();
const botSentIds = new Set();
function markBotSent(msgId) {
    if (!msgId) return;
    botSentIds.add(msgId);
    setTimeout(() => botSentIds.delete(msgId), 60_000);
}

// ── Auth middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─────────────────────────────────────────────────────────────────────────
// REMOTE SESSION STORAGE — reads/writes to Laravel DB instead of local files
// ─────────────────────────────────────────────────────────────────────────
async function useRemoteAuthState(userId) {
    const headers = { 'X-Bridge-Secret': API_SECRET, 'Content-Type': 'application/json' };
    const base    = `${LARAVEL_URL}/api/wa-session/${userId}`;

    async function readData(filename) {
        try {
            const res = await axios.get(`${base}/${filename}`, { headers, timeout: 8000 });
            return JSON.parse(res.data, BufferJSON.reviver);
        } catch (e) {
            return null;
        }
    }

    async function writeData(filename, data) {
        try {
            await axios.post(
                `${base}/${filename}`,
                JSON.stringify(data, BufferJSON.replacer),
                { headers, timeout: 8000 }
            );
        } catch (e) {
            logger.error({ event: 'session_write_error', filename, err: e.message });
        }
    }

    async function removeData(filename) {
        try {
            await axios.delete(`${base}/${filename}`, { headers, timeout: 5000 });
        } catch (_) {}
    }

    // Load or init credentials
    let creds = await readData('creds.json');
    if (!creds) {
        creds = initAuthCreds();
        logger.info({ userId, event: 'new_creds_created' });
    } else {
        logger.info({ userId, event: 'creds_loaded_from_db' });
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const raw = await readData(`${type}-${id}.json`);
                        if (raw !== null) data[id] = raw;
                    }
                    return data;
                },
                set: async (data) => {
                    for (const [type, typeData] of Object.entries(data)) {
                        for (const [id, value] of Object.entries(typeData)) {
                            if (value) {
                                await writeData(`${type}-${id}.json`, value);
                            } else {
                                await removeData(`${type}-${id}.json`);
                            }
                        }
                    }
                },
            },
        },
        saveCreds: () => writeData('creds.json', creds),
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Create / reconnect a session
// ─────────────────────────────────────────────────────────────────────────
async function createSession(userId, pairingPhone = null) {
    logger.info({ userId, event: 'creating_session', pairingPhone });

    // Load remote auth state (from Laravel DB)
    let authState;
    try {
        authState = await useRemoteAuthState(userId);
    } catch (e) {
        logger.error({ userId, event: 'auth_state_error', err: e.message });
        return;
    }

    const { state, saveCreds } = authState;
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['WA Marketing SaaS', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        // Required for pairing code method
        mobile: false,
    });


    const sessionData = {
        sock,
        qr: null,
        qrBase64: null,
        status: 'connecting',
        phone: null,
        userId,
    };
    sessions.set(String(userId), sessionData);

    // ── QR / connection events ─────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            if (pairingPhone) {
                // ── PAIRING CODE MODE: generate 8-digit code ──────────────
                try {
                    const code = await sock.requestPairingCode(pairingPhone.replace(/\D/g, ''));
                    sessionData.pairingCode = code;
                    sessionData.status      = 'pairing';
                    logger.info({ userId, event: 'pairing_code_generated', code });
                    notifyLaravel(userId, 'pairing_code', { pairing_code: code, phone: pairingPhone });
                } catch (e) {
                    logger.error({ userId, event: 'pairing_code_error', err: e.message });
                }
            } else {
                // ── QR CODE MODE ──────────────────────────────────────────
                sessionData.qr       = qr;
                sessionData.status   = 'qr';
                sessionData.qrBase64 = await QRCode.toDataURL(qr);
                logger.info({ userId, event: 'qr_generated' });
                notifyLaravel(userId, 'qr', { qr_base64: sessionData.qrBase64 });
            }
        }

        if (connection === 'open') {
            sessionData.status   = 'connected';
            sessionData.qr       = null;
            sessionData.qrBase64 = null;
            const phone = sock.user?.id?.split(':')[0] || null;
            sessionData.phone    = phone;
            logger.info({ userId, phone, event: 'connected' });
            notifyLaravel(userId, 'connected', { phone });
        }

        if (connection === 'close') {
            const code   = lastDisconnect?.error?.output?.statusCode;
            const logout = code === DisconnectReason.loggedOut;
            logger.warn({ userId, code, logout, event: 'disconnected' });

            // Don't auto-reconnect if we are intentionally re-pairing
            if (sessionData._preventReconnect) {
                logger.info({ userId, event: 'reconnect_suppressed_for_repairing' });
                return;
            }

            sessionData.status = logout ? 'disconnected' : 'reconnecting';
            notifyLaravel(userId, logout ? 'disconnected' : 'reconnecting', {});

            if (!logout) {
                logger.info({ userId, event: 'auto_reconnecting_in_3s' });
                setTimeout(() => createSession(userId), 3000);
            } else {
                sessions.delete(String(userId));
                const headers = { 'X-Bridge-Secret': API_SECRET };
                axios.delete(`${LARAVEL_URL}/api/wa-session/${userId}`, { headers }).catch(() => {});
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Incoming messages → forward to Laravel ───────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.fromMe && botSentIds.has(msg.key.id)) continue;

            const from    = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const msgType = getContentType(msg.message) || 'text';
            let   body    = '';

            if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            } else if (msgType === 'buttonsResponseMessage') {
                body = msg.message.buttonsResponseMessage?.selectedDisplayText || '';
            } else if (msgType === 'listResponseMessage') {
                body = msg.message.listResponseMessage?.title || '';
            } else {
                body = `[${msgType.replace('Message', '')}]`;
            }

            const senderName = msg.pushName || null;

            try {
                await axios.post(`${LARAVEL_URL}/api/wa-bridge/incoming`, {
                    userId,
                    from,
                    body,
                    type: msgType.replace('Message', ''),
                    name: senderName,
                    msgId: msg.key.id,
                    timestamp: msg.messageTimestamp,
                }, {
                    headers: { 'X-Bridge-Secret': API_SECRET },
                    timeout: 8000,
                });
            } catch (e) {
                logger.warn({ userId, event: 'forward_error', err: e.message });
            }
        }
    });

    return sock;
}

// ─────────────────────────────────────────────────────────────────────────
// Notify Laravel of events
// ─────────────────────────────────────────────────────────────────────────
async function notifyLaravel(userId, event, data) {
    try {
        await axios.post(`${LARAVEL_URL}/api/wa-bridge/status`, { userId, event, ...data }, {
            headers: { 'X-Bridge-Secret': API_SECRET },
            timeout: 8000,
        });
    } catch (e) {
        logger.warn({ event: 'notify_laravel_error', err: e.message });
    }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP Routes
// ─────────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
    const sessionList = [];
    sessions.forEach((s, uid) => sessionList.push({ userId: uid, status: s.status, phone: s.phone }));
    res.json({ status: 'ok', sessions: sessions.size, sessionList });
});

// Start session for user (QR mode)
app.post('/session/start', auth, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const existing = sessions.get(String(userId));
    if (existing?.status === 'connected') {
        return res.json({ status: 'already_connected', phone: existing.phone });
    }

    createSession(userId).catch(e => logger.error({ event: 'session_start_error', err: e.message }));
    res.json({ status: 'starting', message: 'Session starting. Poll /session/status for QR.' });
});

// Start session with PAIRING CODE (phone number method — more reliable)
app.post('/session/pair', auth, async (req, res) => {
    const { userId, phone } = req.body;
    if (!userId || !phone) return res.status(400).json({ error: 'userId and phone required' });

    const cleanPhone = String(phone).replace(/\D/g, '');
    const existing   = sessions.get(String(userId));

    // Already connected
    if (existing?.status === 'connected') {
        return res.json({ status: 'already_connected', phone: existing.phone });
    }

    // ── Strategy 1: existing socket in QR/connecting state → request code directly ──
    if (existing?.sock && ['qr', 'connecting', 'pairing'].includes(existing.status)) {
        try {
            logger.info({ userId, event: 'requesting_pairing_code_from_existing_sock', phone: cleanPhone });
            const code = await existing.sock.requestPairingCode(cleanPhone);
            existing.pairingCode = code;
            existing.status      = 'pairing';
            logger.info({ userId, code, event: 'pairing_code_ok' });
            return res.json({ status: 'pairing', pairing_code: code, phone: cleanPhone });
        } catch (e) {
            logger.warn({ userId, event: 'pairing_code_failed_on_existing', err: e.message });
            // Fall through to create fresh session
        }
    }

    // ── Strategy 2: kill old session (suppressing auto-reconnect) and start fresh ──
    if (existing) {
        existing._preventReconnect = true;   // stop auto-reconnect on close
        try { existing.sock?.end(); } catch (_) {}
        sessions.delete(String(userId));
        await new Promise(r => setTimeout(r, 1500));  // let close event fire
    }

    // Start fresh session in pairing mode
    createSession(userId, cleanPhone).catch(e => logger.error({ event: 'pair_error', err: e.message }));

    // Wait up to 12 s for pairing code
    for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s = sessions.get(String(userId));
        if (s?.pairingCode) {
            return res.json({ status: 'pairing', pairing_code: s.pairingCode, phone: cleanPhone });
        }
        if (s?.status === 'connected') {
            return res.json({ status: 'already_connected', phone: s.phone });
        }
    }

    // Code not ready yet — tell client to poll
    res.json({ status: 'starting', message: 'Pairing code is generating, poll /session/:userId/status' });
});

// Session status (includes QR or pairing code if pending)
app.get('/session/:userId/status', auth, (req, res) => {
    const s = sessions.get(String(req.params.userId));
    if (!s) return res.json({ status: 'not_found' });
    res.json({
        status:       s.status,
        phone:        s.phone,
        qr_base64:    s.qrBase64,
        pairing_code: s.pairingCode || null,
    });
});

// Get QR base64 image
app.get('/session/:userId/qr', auth, (req, res) => {
    const s = sessions.get(String(req.params.userId));
    if (!s || !s.qrBase64) return res.status(404).json({ error: 'No QR available' });
    res.json({ qr_base64: s.qrBase64 });
});

// Send text message
app.post('/send/text', auth, async (req, res) => {
    const { userId, to, message } = req.body;
    const s = sessions.get(String(userId));
    if (!s || s.status !== 'connected') return res.status(400).json({ error: 'Not connected' });

    try {
        const jid    = to.replace(/\D/g, '') + '@s.whatsapp.net';
        const result = await s.sock.sendMessage(jid, { text: message });
        markBotSent(result?.key?.id);
        res.json({ success: true, msgId: result?.key?.id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Send bulk messages
app.post('/send/bulk', auth, async (req, res) => {
    const { userId, messages, delayMs = 2000 } = req.body;
    const s = sessions.get(String(userId));
    if (!s || s.status !== 'connected') return res.status(400).json({ error: 'Not connected' });

    res.json({ accepted: true, count: messages.length });

    // Send in background with delay
    (async () => {
        for (const m of messages) {
            try {
                const jid    = m.to.replace(/\D/g, '') + '@s.whatsapp.net';
                const result = await s.sock.sendMessage(jid, { text: m.body });
                markBotSent(result?.key?.id);
                logger.info({ userId, to: m.to, event: 'message_sent' });
            } catch (e) {
                logger.error({ userId, to: m.to, event: 'send_error', err: e.message });
            }
            await new Promise(r => setTimeout(r, delayMs));
        }
        logger.info({ userId, event: 'bulk_complete', count: messages.length });
    })();
});

// Disconnect / logout session
app.post('/session/:userId/disconnect', auth, async (req, res) => {
    const s = sessions.get(String(req.params.userId));
    if (s?.sock) {
        try { await s.sock.logout(); } catch (_) {}
    }
    sessions.delete(String(req.params.userId));
    // Clear DB session
    const headers = { 'X-Bridge-Secret': API_SECRET };
    axios.delete(`${LARAVEL_URL}/api/wa-session/${req.params.userId}`, { headers }).catch(() => {});
    res.json({ ok: true });
});

// List active sessions
app.get('/sessions', auth, (req, res) => {
    const list = [];
    sessions.forEach((s, uid) => list.push({ userId: uid, status: s.status, phone: s.phone }));
    res.json({ sessions: list });
});

// ─────────────────────────────────────────────────────────────────────────
// Startup — restore all sessions from DB
// ─────────────────────────────────────────────────────────────────────────
async function restoreSessionsFromDB() {
    logger.info({ event: 'restoring_sessions_from_db' });
    try {
        // Get unique user IDs from wa_sessions table
        const res = await axios.get(`${LARAVEL_URL}/api/wa-session/active-users`, {
            headers: { 'X-Bridge-Secret': API_SECRET },
            timeout: 10000,
        });
        const userIds = res.data?.userIds || [];
        logger.info({ event: 'found_sessions', count: userIds.length, userIds });

        for (const uid of userIds) {
            await createSession(uid);
            await new Promise(r => setTimeout(r, 1000)); // stagger
        }
    } catch (e) {
        logger.warn({ event: 'restore_sessions_error', err: e.message });
    }
}

app.listen(PORT, async () => {
    logger.info({ event: 'bridge_started', port: PORT, laravel: LARAVEL_URL });
    console.log(`✅ WA Bridge running on port ${PORT}`);
    console.log(`🔗 Laravel: ${LARAVEL_URL}`);
    // Wait for connections to settle then restore sessions
    setTimeout(restoreSessionsFromDB, 4000);
});
