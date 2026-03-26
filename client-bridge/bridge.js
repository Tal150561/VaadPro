/**
 * VaadPro Bridge – גרסת לקוח
 * אל תערוך קובץ זה
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ── קרא הגדרות מקובץ config.json ────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  console.error('❌ קובץ config.json לא נמצא!');
  console.error('   צור קובץ config.json עם הפרטים שקיבלת ב-אימייל.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const { cloudUrl, bridgeSecret, tenantId } = config;
if (!cloudUrl || !bridgeSecret || !tenantId) {
  console.error('❌ config.json חסרים פרטים. ודא שיש cloudUrl, bridgeSecret, tenantId.');
  process.exit(1);
}

const AUTH_DIR      = './wa-auth';
const POLL_INTERVAL = 5000;
const HEALTH_INTERVAL = 60000;

// ── HTTP ─────────────────────────────────────────────────────────
function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(cloudUrl + urlPath);
    const isHttps = url.protocol === 'https:';
    const lib  = isHttps ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': bridgeSecret,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      },
      timeout: 10000
    };
    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok: false }); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function pushStatus(status, qrDataUrl, phone) {
  try {
    await apiCall('POST', '/api/bridge/status', { tenantId, status, qrDataUrl, phone });
    if (status === 'ready') console.log(`✅ ווטסאפ מחובר! (${phone})`);
    else if (status === 'qr') console.log('📱 ממתין לסריקת QR באפליקציה...');
    else console.log(`ℹ️  סטטוס: ${status}`);
  } catch(e) { /* בשקט */ }
}

// ── Polling ──────────────────────────────────────────────────────
let isPolling = false, pollTimer = null, sock = null, waReady = false;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAndSend, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollAndSend() {
  if (isPolling || !waReady || !sock) return;
  isPolling = true;
  try {
    const res = await apiCall('GET', `/api/bridge/queue/${tenantId}`, null);
    if (!res.pending || !res.pending.length) return;
    for (const msg of res.pending) {
      let ok = false, error = '';
      try {
        const jid = msg.phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: msg.message });
        ok = true;
        console.log(`📤 הודעה נשלחה ל-${msg.phone}`);
      } catch(e) { error = e.message; console.error(`❌ שגיאה בשליחה:`, error); }
      await apiCall('POST', '/api/bridge/ack', { tenantId, msgId: msg.msgId, ok, error });
    }
  } catch(e) { /* בשקט */ }
  finally { isPolling = false; }
}

setInterval(async () => {
  if (!waReady) return;
  try { await pushStatus('ready', null, sock?.user?.id?.split(':')[0] || null); } catch(e) {}
}, HEALTH_INTERVAL);

// ── Baileys ──────────────────────────────────────────────────────
async function initWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: {
      level: 'silent',
      trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this; }
    },
    browser: ['VaadPro', 'Chrome', '1.0'],
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waReady = false; stopPolling();
      const qrDataUrl = await qrcode.toDataURL(qr);
      await pushStatus('qr', qrDataUrl, null);
      console.log('');
      console.log('👆 פתח את VaadPro בדפדפן ← לחץ "חיבור ווטסאפ" ← סרוק QR');
      console.log('');
    }

    if (connection === 'open') {
      waReady = true;
      const phone = sock.user?.id?.split(':')[0] || null;
      await pushStatus('ready', null, phone);
      startPolling();
    }

    if (connection === 'close') {
      waReady = false; stopPolling();
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode : 0;

      await pushStatus('disconnected', null, null);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('⚠️  נותקת — מחיקת אימות ואתחול מחדש...');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(initWA, 3000);
      } else {
        console.log('🔄 מנסה להתחבר מחדש...');
        setTimeout(initWA, 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Start ────────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║   VaadPro Bridge                     ║');
console.log('╚══════════════════════════════════════╝');
console.log('');
console.log('מתחבר לשרת VaadPro...');
initWA().catch(console.error);
