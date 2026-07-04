/**
 * WhatsApp Web Bridge — Multi-Session Baileys Server
 * Each platform user connects their OWN WhatsApp via QR scan.
 * Laravel calls this service to send messages from each user's number.
 */

const express      = require('express');
const QRCode       = require('qrcode');
const axios        = require('axios');
const fs           = require('fs');
const path         = require('path');
const pino         = require('pino');

// ── Baileys ────────────────────────────────────────────────────────────────
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    jidDecode,
    proto,
    getContentType,
    downloadContentFromMessage,
} = require('@whiskeysockets/baileys');

const app    = express();
const PORT   = process.env.PORT || process.env.WA_BRIDGE_PORT || 3001;  // Render uses PORT
const LARAVEL_URL = process.env.LARAVEL_URL || 'http://localhost:8000';
const API_SECRET  = process.env.WA_BRIDGE_SECRET || 'wa_bridge_secret_2024';

app.use(express.json({ limit: '50mb' }));

// ── Logger ─────────────────────────────────────────────────────────────────
const logger = pino({ level: 'info' }, pino.destination('./bridge.log'));

// ── Session storage ────────────────────────────────────────────────────────
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/** Map of userId → { sock, qr, status, phone } */
const sessions = new Map();

/**
 * Track message IDs that the BOT itself sent.
 * When a fromMe message arrives, if its ID is in this set → bot sent it → skip.
 * If the ID is NOT in the set → user typed it (e.g. in self-chat) → forward to Laravel.
 */
const botSentIds = new Set();
function markBotSent(msgId) {
    if (!msgId) return;
    botSentIds.add(msgId);
    setTimeout(() => botSentIds.delete(msgId), 60_000); // auto-clean after 60s
}

// ── Auth middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─────────────────────────────────────────────────────────────────────────
// Core: Create / reconnect a session for a user
// ─────────────────────────────────────────────────────────────────────────
async function createSession(userId) {
    const sessionDir = path.join(SESSIONS_DIR, `user_${userId}`);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['WA Marketing SaaS', 'Chrome', '1.0.0'],
        syncFullHistory: false,
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

    // ── QR code event ──────────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionData.qr      = qr;
            sessionData.status  = 'qr';
            sessionData.qrBase64 = await QRCode.toDataURL(qr);
            logger.info({ userId, event: 'qr_generated' });
            notifyLaravel(userId, 'qr', { qr_base64: sessionData.qrBase64 });
        }

        if (connection === 'open') {
            sessionData.status  = 'connected';
            sessionData.qr      = null;
            sessionData.qrBase64 = null;
            const phone = sock.user?.id?.split(':')[0] || null;
            sessionData.phone   = phone;
            logger.info({ userId, phone, event: 'connected' });
            notifyLaravel(userId, 'connected', { phone });
        }

        if (connection === 'close') {
            const code   = lastDisconnect?.error?.output?.statusCode;
            const logout = code === DisconnectReason.loggedOut;
            logger.warn({ userId, code, logout, event: 'disconnected' });

            sessionData.status = logout ? 'disconnected' : 'reconnecting';
            notifyLaravel(userId, logout ? 'disconnected' : 'reconnecting', {});

            if (!logout) {
                setTimeout(() => createSession(userId), 3000);
            } else {
                sessions.delete(String(userId));
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Incoming messages → forward to Laravel ────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            // If the bot sent this message, its ID will be in botSentIds → skip it.
            // If it's fromMe but NOT in botSentIds → user typed it themselves (self-chat) → forward.
            if (msg.key.fromMe && botSentIds.has(msg.key.id)) continue;

            const from    = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const msgType = getContentType(msg.message) || 'text';
            let   body    = '';
            let   mediaUrl = null;

            if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            } else if (msgType === 'buttonsResponseMessage') {
                // Handle button reply
                body = msg.message.buttonsResponseMessage?.selectedDisplayText
                    || msg.message.buttonsResponseMessage?.selectedButtonId
                    || '';
            } else if (msgType === 'listResponseMessage') {
                body = msg.message.listResponseMessage?.title || '';
            } else if (['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(msgType)) {
                const mediaMsg = msg.message[msgType];
                body = mediaMsg?.caption || `[${msgType.replace('Message','')}]`;
                try {
                    const stream  = await downloadContentFromMessage(mediaMsg, msgType.replace('Message',''));
                    const chunks  = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer  = Buffer.concat(chunks);
                    const ext     = mediaMsg.mimetype?.split('/')[1]?.split(';')[0] || 'bin';
                    const fname   = `${Date.now()}_${from}.${ext}`;
                    const savePath = path.join(__dirname, '../storage/app/public/media/incoming', fname);
                    fs.mkdirSync(path.dirname(savePath), { recursive: true });
                    fs.writeFileSync(savePath, buffer);
                    mediaUrl = `/storage/media/incoming/${fname}`;
                } catch(e) { /* media download optional */ }
            }

            // Forward to Laravel
            try {
                await axios.post(`${LARAVEL_URL}/api/wa-bridge/incoming`, {
                    userId,
                    from,
                    body,
                    type: msgType.replace('Message',''),
                    media_url: mediaUrl,
                    timestamp: msg.messageTimestamp,
                    message_id: msg.key.id,
                }, {
                    headers: { 'X-Bridge-Secret': API_SECRET },
                    timeout: 5000,
                });
            } catch(e) {
                logger.error({ event: 'forward_failed', error: e.message });
            }
        }
    });

    return sessionData;
}

// ── Notify Laravel ────────────────────────────────────────────────────────
async function notifyLaravel(userId, event, data) {
    try {
        await axios.post(`${LARAVEL_URL}/api/wa-bridge/status`, {
            userId, event, ...data
        }, {
            headers: { 'X-Bridge-Secret': API_SECRET },
            timeout: 3000,
        });
    } catch (e) { /* non-critical */ }
}

// ─────────────────────────────────────────────────────────────────────────
// REST API Routes
// ─────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

app.post('/session/start', auth, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
        const existing = sessions.get(String(userId));
        if (existing?.status === 'connected') {
            return res.json({ status: 'connected', phone: existing.phone });
        }
        await createSession(userId);
        res.json({ status: 'starting' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/session/qr/:userId', auth, (req, res) => {
    const session = sessions.get(req.params.userId);
    if (!session)          return res.status(404).json({ error: 'Session not found.' });
    if (!session.qrBase64) return res.json({ status: session.status, qr: null });
    res.json({ status: 'qr', qr: session.qrBase64 });
});

app.get('/session/status/:userId', auth, (req, res) => {
    const session = sessions.get(req.params.userId);
    if (!session) return res.json({ status: 'not_started', phone: null });
    res.json({ status: session.status, phone: session.phone });
});

app.delete('/session/:userId', auth, async (req, res) => {
    const session = sessions.get(req.params.userId);
    if (!session) return res.status(404).json({ error: 'Not found' });
    try { await session.sock.logout(); } catch(e) { }
    sessions.delete(req.params.userId);
    res.json({ ok: true });
});

/** POST /send — send text, media, OR interactive buttons */
app.post('/send', auth, async (req, res) => {
    const { userId, to, type = 'text', body, mediaUrl, caption, filename, buttons, footer } = req.body;
    if (!userId || !to) return res.status(400).json({ error: 'userId and to are required' });

    const session = sessions.get(String(userId));
    if (!session || session.status !== 'connected') {
        return res.status(503).json({ error: 'User not connected. Scan QR first.' });
    }

    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';

    try {
        let sent;

        if (type === 'buttons' && buttons && buttons.length > 0) {
            // ── Interactive button message ─────────────────────────────────
            const btnList = buttons.slice(0, 3).map((btn, i) => ({
                buttonId: btn.id || String(i + 1),
                buttonText: { displayText: btn.text },
                type: 1,
            }));

            sent = await session.sock.sendMessage(jid, {
                text: body || '',
                footer: footer || '',
                buttons: btnList,
                headerType: 1,
            });

        } else if (type === 'list' && buttons && buttons.length > 0) {
            // ── List message (more than 3 options) ────────────────────────
            const rows = buttons.map((btn, i) => ({
                title: btn.text,
                rowId: btn.id || String(i + 1),
                description: btn.desc || '',
            }));

            sent = await session.sock.sendMessage(jid, {
                text: body || '',
                footer: footer || '',
                title: '',
                buttonText: 'اختر خياراً',
                sections: [{ title: 'الخيارات', rows }],
                listType: 1,
            });

        } else if (type === 'text') {
            sent = await session.sock.sendMessage(jid, { text: body });

        } else if (type === 'image' && mediaUrl) {
            const imgBuffer = (await axios.get(mediaUrl, { responseType: 'arraybuffer' })).data;
            sent = await session.sock.sendMessage(jid, { image: Buffer.from(imgBuffer), caption: caption || '' });

        } else if (type === 'video' && mediaUrl) {
            const vidBuffer = (await axios.get(mediaUrl, { responseType: 'arraybuffer' })).data;
            sent = await session.sock.sendMessage(jid, { video: Buffer.from(vidBuffer), caption: caption || '' });

        } else if (type === 'audio' && mediaUrl) {
            const audBuffer = (await axios.get(mediaUrl, { responseType: 'arraybuffer' })).data;
            sent = await session.sock.sendMessage(jid, { audio: Buffer.from(audBuffer), mimetype: 'audio/mp4', ptt: false });

        } else if (type === 'document' && mediaUrl) {
            const docBuffer = (await axios.get(mediaUrl, { responseType: 'arraybuffer' })).data;
            sent = await session.sock.sendMessage(jid, {
                document: Buffer.from(docBuffer),
                fileName: filename || 'file',
                mimetype: 'application/octet-stream',
                caption: caption || '',
            });
        } else {
            sent = await session.sock.sendMessage(jid, { text: body || '' });
        }

        // ✅ Register this message ID so incoming handler knows it's bot-sent
        markBotSent(sent?.key?.id);

        res.json({ ok: true, message_id: sent?.key?.id });
    } catch (e) {
        logger.error({ event: 'send_failed', error: e.message });
        res.status(500).json({ error: e.message });
    }
});

/** POST /send-bulk — send to multiple contacts */
app.post('/send-bulk', auth, async (req, res) => {
    const { userId, messages, delayMs = 2000 } = req.body;
    const session = sessions.get(String(userId));
    if (!session || session.status !== 'connected') {
        return res.status(503).json({ error: 'User not connected.' });
    }
    res.json({ ok: true, queued: messages.length });

    (async () => {
        for (const m of messages) {
            try {
                const jid = m.to.replace(/\D/g, '') + '@s.whatsapp.net';

                if (m.buttons && m.buttons.length > 0) {
                    const btnList = m.buttons.slice(0, 3).map((btn, i) => ({
                        buttonId: btn.id || String(i + 1),
                        buttonText: { displayText: btn.text },
                        type: 1,
                    }));
                    const sent = await session.sock.sendMessage(jid, {
                        text: m.body || '',
                        footer: m.footer || '',
                        buttons: btnList,
                        headerType: 1,
                    });
                    markBotSent(sent?.key?.id);
                } else {
                    const sent = await session.sock.sendMessage(jid, { text: m.body });
                    markBotSent(sent?.key?.id);
                }

                await new Promise(r => setTimeout(r, delayMs + Math.random() * 1000));
            } catch(e) {
                logger.error({ event: 'bulk_send_error', to: m.to, error: e.message });
            }
        }
    })();
});

// ── Restore sessions on startup ────────────────────────────────────────────
async function restoreSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR).filter(d => d.startsWith('user_'));
    for (const dir of dirs) {
        const userId = dir.replace('user_', '');
        logger.info({ event: 'restoring_session', userId });
        try { await createSession(userId); } catch(e) { }
    }
}

app.listen(PORT, async () => {
    console.log(`\n🟢 WA Bridge running on port ${PORT}`);
    console.log(`📡 Forwarding events to: ${LARAVEL_URL}`);
    console.log(`🔑 Secret: ${API_SECRET}\n`);
    await restoreSessions();
});
