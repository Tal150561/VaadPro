/**
 * VaadPro – SaaS Server v1.9.0
 * Multi-tenant ועד הבית management
 */

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode    = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── קבצי Bridge מוטמעים ─────────────────────────────────────────
const BRIDGE_JS_CONTENT = "/**\n * VaadPro Bridge \u2013 \u05d2\u05e8\u05e1\u05ea \u05dc\u05e7\u05d5\u05d7\n * \u05d0\u05dc \u05ea\u05e2\u05e8\u05d5\u05da \u05e7\u05d5\u05d1\u05e5 \u05d6\u05d4\n */\n\nconst { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');\nconst { Boom } = require('@hapi/boom');\nconst qrcode = require('qrcode');\nconst https  = require('https');\nconst http   = require('http');\nconst fs     = require('fs');\nconst path   = require('path');\n\n// \u2500\u2500 \u05e7\u05e8\u05d0 \u05d4\u05d2\u05d3\u05e8\u05d5\u05ea \u05de\u05e7\u05d5\u05d1\u05e5 config.json \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst CONFIG_FILE = path.join(__dirname, 'config.json');\nif (!fs.existsSync(CONFIG_FILE)) {\n  console.error('\u274c \u05e7\u05d5\u05d1\u05e5 config.json \u05dc\u05d0 \u05e0\u05de\u05e6\u05d0!');\n  console.error('   \u05e6\u05d5\u05e8 \u05e7\u05d5\u05d1\u05e5 config.json \u05e2\u05dd \u05d4\u05e4\u05e8\u05d8\u05d9\u05dd \u05e9\u05e7\u05d9\u05d1\u05dc\u05ea \u05d1-\u05d0\u05d9\u05de\u05d9\u05d9\u05dc.');\n  process.exit(1);\n}\nconst config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));\nconst { cloudUrl, bridgeSecret, tenantId } = config;\nif (!cloudUrl || !bridgeSecret || !tenantId) {\n  console.error('\u274c config.json \u05d7\u05e1\u05e8\u05d9\u05dd \u05e4\u05e8\u05d8\u05d9\u05dd. \u05d5\u05d3\u05d0 \u05e9\u05d9\u05e9 cloudUrl, bridgeSecret, tenantId.');\n  process.exit(1);\n}\n\n// Suppress internal crypto noise from Baileys\nconst _stderrWrite = process.stderr.write.bind(process.stderr);\nprocess.stderr.write = (chunk, ...args) => {\n  const m = chunk.toString();\n  if (m.includes('Bad MAC') || m.includes('Failed to decrypt') || m.includes('Session error')) return true;\n  return _stderrWrite(chunk, ...args);\n};\n\nconst AUTH_DIR      = './wa-auth';\nconst POLL_INTERVAL = 5000;\nconst HEALTH_INTERVAL = 60000;\n\n// \u2500\u2500 HTTP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction apiCall(method, urlPath, body) {\n  return new Promise((resolve, reject) => {\n    const url = new URL(cloudUrl + urlPath);\n    const isHttps = url.protocol === 'https:';\n    const lib  = isHttps ? https : http;\n    const data = body ? JSON.stringify(body) : null;\n    const opts = {\n      hostname: url.hostname,\n      port: url.port || (isHttps ? 443 : 80),\n      path: url.pathname + (url.search || ''),\n      method,\n      headers: {\n        'Content-Type': 'application/json',\n        'x-bridge-secret': bridgeSecret,\n        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})\n      },\n      timeout: 10000\n    };\n    const req = lib.request(opts, (res) => {\n      let raw = '';\n      res.on('data', d => raw += d);\n      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok: false }); } });\n    });\n    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });\n    req.on('error', reject);\n    if (data) req.write(data);\n    req.end();\n  });\n}\n\nasync function pushStatus(status, qrDataUrl, phone) {\n  try {\n    await apiCall('POST', '/api/bridge/status', { tenantId, status, qrDataUrl, phone });\n    if (status === 'ready') console.log(`\u2705 WhatsApp connected! (${phone})`);\n    else if (status === 'qr') console.log('\ud83d\udcf1 Waiting for QR scan in the app...');\n    else console.log(`\u2139\ufe0f  Status: ${status}`);\n  } catch(e) { /* \u05d1\u05e9\u05e7\u05d8 */ }\n}\n\n// \u2500\u2500 Polling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nlet isPolling = false, pollTimer = null, sock = null, waReady = false;\n\nfunction startPolling() {\n  if (pollTimer) return;\n  pollTimer = setInterval(pollAndSend, POLL_INTERVAL);\n}\n\nfunction stopPolling() {\n  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }\n}\n\nasync function pollAndSend() {\n  if (isPolling || !waReady || !sock) return;\n  isPolling = true;\n  try {\n    const res = await apiCall('GET', `/api/bridge/queue/${tenantId}`, null);\n    if (!res.pending || !res.pending.length) return;\n    for (const msg of res.pending) {\n      let ok = false, error = '';\n      try {\n        const jid = msg.phone.replace(/\\D/g, '') + '@s.whatsapp.net';\n        await sock.sendMessage(jid, { text: msg.message });\n        ok = true;\n        console.log(`\ud83d\udce4 Message sent to ${msg.phone}`);\n      } catch(e) { error = e.message; console.error(`\u274c Send error:`, error); }\n      await apiCall('POST', '/api/bridge/ack', { tenantId, msgId: msg.msgId, ok, error });\n    }\n  } catch(e) { /* \u05d1\u05e9\u05e7\u05d8 */ }\n  finally { isPolling = false; }\n}\n\nsetInterval(async () => {\n  if (!waReady) return;\n  try { await pushStatus('ready', null, sock?.user?.id?.split(':')[0] || null); } catch(e) {}\n}, HEALTH_INTERVAL);\n\n// \u2500\u2500 Baileys \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nasync function initWA() {\n  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);\n  const { version } = await fetchLatestBaileysVersion();\n\n  sock = makeWASocket({\n    version,\n    auth: state,\n    printQRInTerminal: false,\n    logger: {\n      level: 'silent',\n      trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this; }\n    },\n    browser: ['VaadPro', 'Chrome', '1.0'],\n    connectTimeoutMs: 30000,\n    keepAliveIntervalMs: 30000,\n  });\n\n  sock.ev.on('connection.update', async (update) => {\n    const { connection, lastDisconnect, qr } = update;\n\n    if (qr) {\n      waReady = false; stopPolling();\n      const qrDataUrl = await qrcode.toDataURL(qr);\n      await pushStatus('qr', qrDataUrl, null);\n      console.log('');\n      console.log('\ud83d\udc46 Open VaadPro in browser -> Click Connect WhatsApp -> Scan QR');\n      console.log('');\n    }\n\n    if (connection === 'open') {\n      waReady = true;\n      const phone = sock.user?.id?.split(':')[0] || null;\n      await pushStatus('ready', null, phone);\n      startPolling();\n    }\n\n    if (connection === 'close') {\n      waReady = false; stopPolling();\n      const statusCode = (lastDisconnect?.error instanceof Boom)\n        ? lastDisconnect.error.output.statusCode : 0;\n\n      await pushStatus('disconnected', null, null);\n\n      if (statusCode === DisconnectReason.loggedOut) {\n        console.log('\u26a0\ufe0f  Logged out - clearing auth and restarting...');\n        fs.rmSync(AUTH_DIR, { recursive: true, force: true });\n        setTimeout(initWA, 3000);\n      } else {\n        console.log('\ud83d\udd04 Reconnecting...');\n        setTimeout(initWA, 5000);\n      }\n    }\n  });\n\n  sock.ev.on('creds.update', saveCreds);\n}\n\n// \u2500\u2500 Start \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconsole.log('');\nconsole.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');\nconsole.log('\u2551   VaadPro Bridge                     \u2551');\nconsole.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');\nconsole.log('');\nconsole.log('Connecting to VaadPro server...');\ninitWA().catch(console.error);\n";
const BRIDGE_PKG_CONTENT = "{\n  \"name\": \"vaadpro-bridge\",\n  \"version\": \"1.0.0\",\n  \"description\": \"VaadPro Bridge \u2013 \u05d7\u05d9\u05d1\u05d5\u05e8 \u05d5\u05d5\u05d8\u05e1\u05d0\u05e4\",\n  \"main\": \"bridge.js\",\n  \"type\": \"commonjs\",\n  \"scripts\": {\n    \"start\": \"node bridge.js\"\n  },\n  \"dependencies\": {\n    \"@whiskeysockets/baileys\": \"6.5.0\",\n    \"@hapi/boom\": \"^10.0.1\",\n    \"qrcode\": \"^1.5.3\"\n  }\n}\n";
const BRIDGE_INSTALL_BAT = '@echo off\ntitle VaadPro Bridge - Install\necho.\necho  VaadPro Bridge - Installation\necho  ==============================\necho.\necho  Installing... please wait (~2 min)\necho.\nnpm install\nif %errorlevel% neq 0 (\n    echo  ERROR: Installation failed.\n    pause\n    exit /b 1\n)\necho.\necho  Done! Now double-click start.bat to run.\necho.\npause\n';
const BRIDGE_START_BAT = '@echo off\ntitle VaadPro Bridge\ncolor 0A\necho.\necho  VaadPro Bridge - Running\necho  Do NOT close this window!\necho.\nnode bridge.js\necho.\necho  Bridge stopped.\npause\ngoto :eof\n';
const BRIDGE_INSTALL_SH = '#!/bin/bash\necho \necho VaadPro Bridge - Installation\necho ==============================\necho \necho Installing... please wait\necho \nnpm install\necho \necho Done! Run: ./start.sh\necho \n';
const BRIDGE_START_SH = '#!/bin/bash\nBRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"\n\necho ""\necho " ========================================"\necho "   VaadPro Bridge Launcher"\necho " ========================================"\necho ""\n\n# Check Node.js\nif ! command -v node &>/dev/null; then\n    echo " ERROR: Node.js is not installed."\n    echo " Go to https://nodejs.org and install the LTS version."\n    echo ""\n    exit 1\nfi\n\n# Check bridge.js\nif [ ! -f "$BRIDGE_DIR/bridge.js" ]; then\n    echo " ERROR: bridge.js not found in $BRIDGE_DIR"\n    exit 1\nfi\n\n# Install if needed\nif [ ! -d "$BRIDGE_DIR/node_modules" ]; then\n    echo " Installing dependencies (one-time, ~2 min)..."\n    cd "$BRIDGE_DIR" && npm install\n    echo " Done!"\n    echo ""\nfi\n\n# Create Desktop shortcut (Mac only, one-time)\nSHORTCUT="$HOME/Desktop/VaadPro Bridge.command"\nif [ ! -f "$SHORTCUT" ]; then\n    echo "#!/bin/bash" > "$SHORTCUT"\n    echo "cd \\"$BRIDGE_DIR\\" && ./VaadPro-Start.sh" >> "$SHORTCUT"\n    chmod +x "$SHORTCUT"\n    echo " Shortcut created on Desktop: VaadPro Bridge"\n    echo ""\nfi\n\n# Start Bridge\necho " Starting VaadPro Bridge..."\necho " Do NOT close this window!"\necho ""\n\ncd "$BRIDGE_DIR"\nnode bridge.js\n\necho ""\necho " Bridge stopped. Press Enter to restart or Ctrl+C to exit."\nread\nexec "$0"\n';const BRIDGE_README = '# VaadPro Bridge\n\n## Installation (one-time)\n1. Double-click install.bat\n2. Wait ~2 minutes\n\n## Daily use\n1. Double-click start.bat\n2. Do NOT close the window!\n3. Scan QR in the app (first time only)\n\n## Support: vaadpro15@gmail.com\n';

const VAADPRO_START_BAT = '@echo off\nsetlocal enabledelayedexpansion\ntitle VaadPro Bridge Launcher\n\nset BRIDGE_DIR=%~dp0\nset BRIDGE_DIR=%BRIDGE_DIR:~0,-1%\n\nif not exist "%BRIDGE_DIR%\\bridge.js" (\n    echo  ERROR: bridge.js not found.\n    pause & exit /b 1\n)\n\n:: Check Node.js — try PATH first, then known locations\nset NODE_EXE=\nwhere node >nul 2>&1 && set NODE_EXE=node\nif not defined NODE_EXE if exist "C:\\Program Files\\nodejs\\node.exe" set "NODE_EXE=C:\\Program Files\\nodejs\\node.exe"\nif not defined NODE_EXE if exist "C:\\Program Files (x86)\\nodejs\\node.exe" set "NODE_EXE=C:\\Program Files (x86)\\nodejs\\node.exe"\nif not defined NODE_EXE (\n    for /f "tokens=*" %%i in (\'dir /b /s "C:\\Program Files\\node.exe" 2^>nul\') do set NODE_EXE=%%i\n)\n\n:: Install Node.js if still not found\nif not defined NODE_EXE (\n    echo.\n    echo  Node.js not found. Downloading and installing automatically...\n    echo  This may take 2-3 minutes. Please wait.\n    echo.\n    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest \'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi\' -OutFile \'%TEMP%\\node_setup.msi\' -UseBasicParsing; Start-Process msiexec -ArgumentList \'/i %TEMP%\\node_setup.msi /quiet /norestart\' -Wait; Remove-Item \'%TEMP%\\node_setup.msi\' -Force"\n    set "NODE_EXE=C:\\Program Files\\nodejs\\node.exe"\n    echo.\n    echo  Node.js installed! Please restart your computer and run VaadPro Bridge again.\n    pause\n    exit /b 0\n)\n\n:: Install Bridge dependencies if needed\\nif not exist "%BRIDGE_DIR%\\\\node_modules" (\\n    echo.\\n    echo  ========================================\\n    echo   Installing Bridge dependencies...\\n    echo   This may take 2-3 minutes. Please wait.\\n    echo  ========================================\\n    echo.\\n    pushd "%BRIDGE_DIR%"\\n    set NPM_OK=0\\n    where npm >nul 2>&1\\n    if %errorlevel%==0 (\\n        npm install\\n        if not errorlevel 1 set NPM_OK=1\\n    )\\n    if "%NPM_OK%"=="0" if exist "C:\\\\Program Files\\\\nodejs\\\\npm.cmd" (\\n        "C:\\\\Program Files\\\\nodejs\\\\npm.cmd" install\\n        if not errorlevel 1 set NPM_OK=1\\n    )\\n    if "%NPM_OK%"=="0" if exist "C:\\\\Program Files\\\\nodejs\\\\node_modules\\\\npm\\\\bin\\\\npm-cli.js" (\\n        "%NODE_EXE%" "C:\\\\Program Files\\\\nodejs\\\\node_modules\\\\npm\\\\bin\\\\npm-cli.js" install\\n        if not errorlevel 1 set NPM_OK=1\\n    )\\n    popd\\n    if "%NPM_OK%"=="0" (\\n        echo.\\n        echo  ERROR: npm install failed!\\n        echo  Open a new CMD window and run:\\n        echo    cd /d "%BRIDGE_DIR%" ^&^& npm install\\n        pause\\n        exit /b 1\\n    )\\n    if not exist "%BRIDGE_DIR%\\\\node_modules" (\\n        echo.\\n        echo  ERROR: node_modules missing after install!\\n        echo  Open a new CMD window and run:\\n        echo    cd /d "%BRIDGE_DIR%" ^&^& npm install\\n        pause\\n        exit /b 1\\n    )\\n    echo  Done! Dependencies installed.\\n    echo.\\n)\\n\n:: Create Desktop shortcut (first time)\nset "SHORTCUT=%USERPROFILE%\\Desktop\\VaadPro Bridge.lnk"\nif not exist "%SHORTCUT%" (\n    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut(\'%SHORTCUT%\');$s.TargetPath=\'%BRIDGE_DIR%\\VaadPro-Start.bat\';$s.WorkingDirectory=\'%BRIDGE_DIR%\';$s.Description=\'VaadPro Bridge\';$s.Save()"\n)\n\n:: Check if already running\ntasklist /FI "WINDOWTITLE eq VaadPro Bridge*" 2>nul | find /I "cmd.exe" >nul\nif %errorlevel%==0 (\n    echo  VaadPro Bridge is already running. Check your taskbar.\n    pause & exit /b 0\n)\n\n:: Start Bridge\nstart "VaadPro Bridge" cmd /k "cd /d "%BRIDGE_DIR%" && echo. && echo  ======================================== && echo   VaadPro Bridge - Running && echo   Do NOT close this window! && echo  ======================================== && echo. && "%NODE_EXE%" bridge.js"\nexit /b 0\n';
const VAADPRO_START_SH = '#!/bin/bash\nBRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"\n\necho ""\necho " ========================================"\necho "   VaadPro Bridge Launcher"\necho " ========================================"\necho ""\n\n# Check Node.js\nif ! command -v node &>/dev/null; then\n    echo " ERROR: Node.js is not installed."\n    echo " Go to https://nodejs.org and install the LTS version."\n    echo ""\n    exit 1\nfi\n\n# Check bridge.js\nif [ ! -f "$BRIDGE_DIR/bridge.js" ]; then\n    echo " ERROR: bridge.js not found in $BRIDGE_DIR"\n    exit 1\nfi\n\n# Install if needed\nif [ ! -d "$BRIDGE_DIR/node_modules" ]; then\n    echo " Installing dependencies (one-time, ~2 min)..."\n    cd "$BRIDGE_DIR" && npm install\n    echo " Done!"\n    echo ""\nfi\n\n# Create Desktop shortcut (Mac only, one-time)\nSHORTCUT="$HOME/Desktop/VaadPro Bridge.command"\nif [ ! -f "$SHORTCUT" ]; then\n    echo "#!/bin/bash" > "$SHORTCUT"\n    echo "cd \\"$BRIDGE_DIR\\" && ./VaadPro-Start.sh" >> "$SHORTCUT"\n    chmod +x "$SHORTCUT"\n    echo " Shortcut created on Desktop: VaadPro Bridge"\n    echo ""\nfi\n\n# Start Bridge\necho " Starting VaadPro Bridge..."\necho " Do NOT close this window!"\necho ""\n\ncd "$BRIDGE_DIR"\nnode bridge.js\n\necho ""\necho " Bridge stopped. Press Enter to restart or Ctrl+C to exit."\nread\nexec "$0"\n';
const JWT_SECRET = process.env.JWT_SECRET || 'vaadpro-secret-change-in-production';

// ── Directories ──────────────────────────────────────────────────
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, '_users.json');
const WA_AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
[DATA_DIR, WA_AUTH_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Plans ────────────────────────────────────────────────────────
const PLANS = {
  trial:    { maxTenants: 20,  features: 'all' },
  basic:    { maxTenants: 20,  features: ['tenants','payments','whatsapp','maintenance','bulletin'] },
  advanced: { maxTenants: 50,  features: ['tenants','payments','whatsapp','maintenance','bulletin','email','reports','trends'] },
  premium:  { maxTenants: 999, features: 'all' },
  unlimited:{ maxTenants: 999, features: 'all' },
  suspended:{ maxTenants: 0,   features: [] }
};

function getPlan(planName) {
  return PLANS[planName] || PLANS['trial'];
}

function planHasFeature(planName, feature) {
  const p = getPlan(planName);
  return p.features === 'all' || (Array.isArray(p.features) && p.features.includes(feature));
}

function getPlanMaxTenants(user) {
  if (user.maxTenantsOverride) return user.maxTenantsOverride;
  return getPlan(user.plan).maxTenants;
}

// ── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Users store ──────────────────────────────────────────────────
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ── Tenant data store ────────────────────────────────────────────
function tenantFile(tenantId) {
  return path.join(DATA_DIR, tenantId + '.json');
}

function loadTenantData(tenantId) {
  const f = tenantFile(tenantId);
  if (!fs.existsSync(f)) return { tenants: [], sentLog: {}, config: {}, reports: [], rptLayouts: {} };
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return { tenants: [], sentLog: {}, config: {}, reports: [], rptLayouts: {} }; }
}

function saveTenantData(tenantId, patch) {
  const current = loadTenantData(tenantId);
  const merged  = Object.assign(current, patch);
  fs.writeFileSync(tenantFile(tenantId), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ── JWT Auth middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // בדיקת trial בכל request — חוסם גם token קיים
    const users = loadUsers();
    const user  = users.find(u => u.id === decoded.userId);
    if (user && user.plan === 'trial' && user.plan !== 'unlimited' && new Date(user.trialEnd) < new Date()) {
      return res.status(402).json({ error: 'תקופת הניסיון הסתיימה – צור קשר לחידוש המנוי', expired: true });
    }
    if (user && user.suspended) {
      return res.status(403).json({ error: 'החשבון מושהה – צור קשר עם התמיכה', suspended: true });
    }
    req.user = decoded;
    next();
  } catch(e) {
    res.status(401).json({ error: 'פג תוקף החיבור – התחבר מחדש' });
  }
}

const WA_MODE = process.env.WA_MODE || 'local'; // 'local' | 'cloud'
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'vaadpro-bridge-secret';

// ── WhatsApp state (used in both modes) ─────────────────────────
const waClients = {}; // tenantId → { client?, status, qrData, phone, restarting, healthTimer }

function getWa(tenantId) {
  if (!waClients[tenantId]) {
    waClients[tenantId] = { client: null, status: 'disconnected', qrData: null, phone: null, restarting: false, healthTimer: null };
  }
  return waClients[tenantId];
}

const DETACH_ERRORS = ['detached frame','target closed','session closed','protocol error','execution context','page crashed','browser has disconnected'];
function isDetachError(msg) { const l=(msg||'').toLowerCase(); return DETACH_ERRORS.some(e=>l.includes(e)); }

async function destroyWaClient(tenantId) {
  const wa = getWa(tenantId);
  if (wa.client) { try { await wa.client.destroy(); } catch(e) {} wa.client = null; }
}

async function restartWa(tenantId, reason) {
  const wa = getWa(tenantId);
  if (wa.restarting) return;
  wa.restarting = true;
  wa.status = 'disconnected';
  wa.phone  = null;
  console.log(`[WA:${tenantId}] restart: ${reason}`);
  await destroyWaClient(tenantId);
  if (wa.healthTimer) { clearInterval(wa.healthTimer); wa.healthTimer = null; }
  await new Promise(r => setTimeout(r, 3000));
  wa.restarting = false;
  initWa(tenantId);
}

function startHealthCheck(tenantId) {
  const wa = getWa(tenantId);
  if (wa.healthTimer) clearInterval(wa.healthTimer);
  wa.healthTimer = setInterval(async () => {
    if (wa.status !== 'ready' || wa.restarting) return;
    try { await wa.client.pupPage.evaluate(() => document.title); }
    catch(e) { if (isDetachError(e.message)) restartWa(tenantId, 'health: '+e.message); }
  }, 30000);
}

function initWa(tenantId) {
  const wa = getWa(tenantId);
  wa.client = new Client({
    authStrategy: new LocalAuth({ clientId: tenantId, dataPath: WA_AUTH_DIR }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-background-timer-throttling','--disable-renderer-backgrounding']
    }
  });

  wa.client.on('qr', async (qr) => {
    wa.status = 'qr';
    wa.qrData = await qrcode.toDataURL(qr);
    console.log(`[WA:${tenantId}] QR ready`);
  });

  wa.client.on('ready', () => {
    wa.status = 'ready';
    wa.qrData = null;
    wa.phone  = wa.client.info ? wa.client.info.wid.user : null;
    console.log(`[WA:${tenantId}] connected`, wa.phone || '');
    startHealthCheck(tenantId);
  });

  wa.client.on('disconnected', (reason) => {
    wa.status = 'disconnected';
    wa.phone  = null;
    if (wa.healthTimer) { clearInterval(wa.healthTimer); wa.healthTimer = null; }
    console.log(`[WA:${tenantId}] disconnected: ${reason}`);
    setTimeout(() => restartWa(tenantId, 'disconnected: '+reason), 5000);
  });

  wa.client.on('auth_failure', () => { wa.status = 'disconnected'; });

  wa.client.initialize().catch(e => {
    console.error(`[WA:${tenantId}] init error:`, e.message);
    setTimeout(() => restartWa(tenantId, 'init: '+e.message), 5000);
  });
}

async function sendWaMsg(tenantId, phone, message) {
  // אם לא סופק tenantId — מצא Bridge פעיל אוטומטית
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId || !waClients[resolvedTenantId] || waClients[resolvedTenantId].status !== 'ready') {
    resolvedTenantId = Object.keys(waClients).find(id => waClients[id] && waClients[id].status === 'ready');
  }
  if (!resolvedTenantId) throw new Error('אין Bridge מחובר. הפעל את תוכנת ה-Bridge תחילה.');
  const wa = getWa(resolvedTenantId);
  if (wa.status !== 'ready') throw new Error('WhatsApp לא מחובר');
  let normalized = phone.replace(/\D/g, '');
  if (normalized.startsWith('0')) normalized = '972' + normalized.slice(1);

  if (WA_MODE === 'cloud') {
    // במצב ענן — הבקשה נשמרת בתור, ה-bridge שולח אותה
    const queue = sendQueue[tenantId] = sendQueue[tenantId] || [];
    return new Promise((resolve, reject) => {
      const msgId = Date.now() + '_' + Math.random().toString(36).slice(2);
      queue.push({ msgId, phone: normalized, message, resolve, reject, ts: Date.now() });
      // timeout אחרי 30 שניות אם ה-bridge לא מגיב
      setTimeout(() => reject(new Error('Bridge timeout – וודא שה-WA Bridge מחובר')), 30000);
    });
  }

  // מצב local — שלח ישירות
  try {
    await wa.client.sendMessage(normalized + '@c.us', message);
  } catch(e) {
    if (isDetachError(e.message)) {
      restartWa(tenantId, 'send: '+e.message);
      throw new Error('WhatsApp התנתק – מתחבר מחדש, נסה שוב בעוד 15 שניות');
    }
    throw e;
  }
}

// ── Send Queue (cloud mode) ──────────────────────────────────────
const sendQueue = {}; // tenantId → [{msgId, phone, message, resolve, reject}]

// ── Bridge API routes (נקראים מה-WA Bridge על המחשב המקומי) ────

// Bridge: עדכון סטטוס WA
app.post('/api/bridge/status', (req, res) => {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) return res.status(403).json({ error: 'אסור' });
  const { tenantId, status, qrDataUrl, phone } = req.body;
  if (!tenantId) return res.json({ ok: false });
  const wa = getWa(tenantId);
  wa.status = status || 'disconnected';
  wa.qrData = qrDataUrl || null;
  wa.phone  = phone || null;
  wa.lastSeen = Date.now(); // heartbeat timestamp
  // שמור lastConnectedAt בקובץ המשתמש בכל חיבור
  if (status === 'ready' && phone) {
    const users = loadUsers();
    const user = users.find(u => u.tenantId === tenantId);
    if (user) {
      if (!user.firstConnectedAt) user.firstConnectedAt = new Date().toISOString();
      user.lastConnectedAt = new Date().toISOString();
      saveUsers(users);
    }
  }
  console.log(`[Bridge:${tenantId}] status=${status} phone=${phone||'-'}`);
  res.json({ ok: true });
});

// Bridge: משוך הודעות לשליחה (polling)
app.get('/api/bridge/queue/:tenantId', (req, res) => {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) return res.status(403).json({ error: 'אסור' });
  const { tenantId } = req.params;
  const queue = sendQueue[tenantId] || [];
  const pending = queue.map(m => ({ msgId: m.msgId, phone: m.phone, message: m.message }));
  res.json({ pending });
});

// Bridge: דווח על תוצאת שליחה
app.post('/api/bridge/ack', (req, res) => {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) return res.status(403).json({ error: 'אסור' });
  const { tenantId, msgId, ok, error } = req.body;
  const queue = sendQueue[tenantId];
  if (!queue) return res.json({ ok: true });
  const idx = queue.findIndex(m => m.msgId === msgId);
  if (idx === -1) return res.json({ ok: true });
  const [msg] = queue.splice(idx, 1);
  if (ok) msg.resolve();
  else msg.reject(new Error(error || 'שגיאה בשליחה'));
  res.json({ ok: true });
});

// ── Helpers ──────────────────────────────────────────────────────
function getEffectiveMonth(config) {
  const now = new Date();
  const names = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  if (config && config.manualMonth) return config.manualMonth;
  return names[now.getMonth()];
}

// Returns YYYY-MM key for paymentHistory (independent of display month name)
const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
function getMonthKey(config) {
  // If manual month is set, map Hebrew name back to YYYY-MM
  if (config && config.manualMonth) {
    const idx = HEBREW_MONTHS.indexOf(config.manualMonth);
    const now = new Date();
    const year = now.getFullYear();
    const month = idx >= 0 ? idx + 1 : now.getMonth() + 1;
    return year + '-' + String(month).padStart(2,'0');
  }
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
}

// Write a payment record to paymentHistory (permanent archive, never reset)
function recordPayment(tenantData, tenantId, monthKey, type, amount, tenantName, payerName) {
  if (!tenantData.paymentHistory) tenantData.paymentHistory = {};
  if (!tenantData.paymentHistory[tenantId]) tenantData.paymentHistory[tenantId] = [];
  // Avoid duplicate for same month
  const existing = tenantData.paymentHistory[tenantId].findIndex(r => r.month === monthKey);
  const record = {
    month:     monthKey,
    paid:      true,
    amount:    amount || 0,
    date:      new Date().toISOString().split('T')[0],
    type:      type, // 'wa_sent' | 'manual' | 'bank'
    name:      tenantName || '',
    payerName: payerName || ''  // actual payer name from bank file
  };
  if (existing >= 0) {
    tenantData.paymentHistory[tenantId][existing] = record;
  } else {
    tenantData.paymentHistory[tenantId].push(record);
  }
}

// ════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════

// ── Email helper (אימייל ברוכה) ─────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'VaadPro <noreply@vaadpro.co.il>';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

async function sendEmailResend(to, subject, body) {
  const fromAddr = SMTP_FROM || 'VaadPro <onboarding@resend.dev>';
  const adminEmail = process.env.ADMIN_EMAIL || '';
  const isHtml = /<(html|body|img|div|p|br|h[1-6]|table|span|ul|ol|li|a )[^>]*>/i.test(body);
  const payload = { from: fromAddr, to, subject };
  if (isHtml) { payload.html = body; } else { payload.text = body; }
  if (adminEmail) payload.reply_to = adminEmail;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function sendWelcomeEmail(email, buildingName, tenantId) {
  if (!RESEND_API_KEY && (!SMTP_HOST || !SMTP_USER)) {
    console.log('[Email] Email not configured — skipping welcome email');
    return;
  }
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';
  const subject = 'ברוכים הבאים ל-VaadPro! 🏢';
  const body = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.8;color:#222;max-width:560px;">
<img src="${appUrl}/VaadPro-Logo.png" width="220" style="display:block;margin-bottom:24px;">

שלום,

תודה שנרשמת ל-VaadPro! 🎉
החשבון עבור <strong>${buildingName}</strong> נוצר בהצלחה.
יש לך <strong>30 יום ניסיון חינם</strong> עם כל הפיצ'רים פתוחים.

<hr style="margin:16px 0;border:none;border-top:1px solid #eee;">
<strong>כדי להתחבר לוואטסאפ:</strong>
<hr style="margin:8px 0;border:none;border-top:1px solid #eee;">

<strong>1. קבל קוד התקנה</strong>
כנס לאפליקציה ← הגדרות ← לחץ "קבל קוד התקנה"

<strong>2. הורד את המתקין</strong>
הגדרות ← הורד VaadPro-Setup.bat ← לחץ ימני ← Unblock ← OK

<strong>3. הפעל והתקן</strong>
לחץ פעמיים על VaadPro-Setup.bat ← הכנס קוד ← Install

<strong>4. חבר ווטסאפ</strong>
סרוק QR עם הטלפון ← מחובר ✅

<a href="${appUrl}" style="display:inline-block;background:#25D366;color:#000;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px;">כנס לאפליקציה ←</a>

<br><br>
לשאלות: <a href="mailto:vaadpro15@gmail.com" style="color:#25D366;">vaadpro15@gmail.com</a>

<hr style="margin:24px 0;border:none;border-top:1px solid #eee;">
<p style="font-size:12px;color:#999;">VaadPro — ניהול ועד הבית החכם | <a href="${appUrl}" style="color:#999;">vaadpro.org</a></p>
</div>`;

  try {
    await sendEmailResend(email, subject, body);
    console.log('[Email] welcome sent to ' + email);
  } catch(e) {
    console.error('[Email] welcome failed:', e.message);
  }
}

// הרשמה
app.post('/api/auth/register', async (req, res) => {
  const { email, password, buildingName, address, phone, fullName } = req.body;
  if (!email || !password || !buildingName) return res.json({ ok: false, error: 'יש למלא את כל השדות' });
  if (password.length < 6) return res.json({ ok: false, error: 'סיסמה חייבת להכיל לפחות 6 תווים' });

  const users = loadUsers();
  if (users.find(u => u.email === email.toLowerCase())) return res.json({ ok: false, error: 'אימייל זה כבר רשום' });

  const tenantId  = uuidv4();
  const passHash  = await bcrypt.hash(password, 10);
  const trialEnd  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 יום

  const user = { id: uuidv4(), email: email.toLowerCase(), passHash, tenantId, buildingName, address: address||'', phone: phone||'', fullName: fullName||'', plan: 'trial', trialEnd, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);

  // צור קובץ נתונים ראשוני לבניין
  saveTenantData(tenantId, { tenants: [], sentLog: {}, config: { amount: 300, sendDay: 1, sendHour: 9, sendMinute: 0, monthMode: 'auto', manualMonth: '', template: 'שלום {שם}! 👋\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה! 🙏' }, reports: [], rptLayouts: {} });

  const token = jwt.sign({ userId: user.id, tenantId, email: user.email, buildingName, fullName: fullName||'' }, JWT_SECRET, { expiresIn: '30d' });
  // שלח אימייל ברוכה (לא חוסם את התשובה)
  sendWelcomeEmail(user.email, buildingName, tenantId).catch(() => {});
  res.json({ ok: true, token, buildingName, plan: 'trial', trialEnd });
});

// התחברות
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ ok: false, error: 'יש למלא אימייל וסיסמה' });

  const users = loadUsers();
  const user  = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });

  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });

  // בדוק תוקף מנוי
  const now = new Date();
  if (user.plan === 'trial' && new Date(user.trialEnd) < now) {
    return res.json({ ok: false, error: 'תקופת הניסיון הסתיימה – צור קשר לחידוש המנוי', expired: true });
  }

  const token = jwt.sign({ userId: user.id, tenantId: user.tenantId, email: user.email, buildingName: user.buildingName, fullName: user.fullName||'' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, buildingName: user.buildingName, plan: user.plan, trialEnd: user.trialEnd });
});

// פרטי משתמש מחובר
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const users = loadUsers();
  const user  = users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
  res.json({ email: user.email, buildingName: user.buildingName, address: user.address, plan: user.plan, trialEnd: user.trialEnd });
});

// Plan info — מחזיר plan + features + מגבלות ל-client
app.get('/api/plan', authMiddleware, (req, res) => {
  const users = loadUsers();
  const user  = users.find(u => u.tenantId === req.user.tenantId);
  if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
  const plan = getPlan(user.plan);
  const d    = loadTenantData(req.user.tenantId);
  res.json({
    plan:       user.plan,
    features:   plan.features,
    maxTenants: getPlanMaxTenants(user),
    currentTenants: (d.tenants || []).length,
    trialEnd:   user.trialEnd || null
  });
});

// ════════════════════════════════════════════════════════════════
// TENANT API ROUTES (כל route מוגן ב-auth)
// ════════════════════════════════════════════════════════════════

// Status WhatsApp
app.get('/api/status', authMiddleware, (req, res) => {
  const { tenantId } = req.user;
  const wa = getWa(tenantId);
  const d  = loadTenantData(tenantId);
  console.log(`[status] tenantId=${tenantId} waStatus=${wa.status} phone=${wa.phone}`);
  res.json({
    status:          wa.restarting ? 'reconnecting' : wa.status,
    qrDataUrl:       wa.qrData,
    phoneConnected:  wa.phone,
    effectiveMonth:  getEffectiveMonth(d.config),
    currentAutoMonth: getEffectiveMonth(d.config)
  });
});

// Data CRUD
app.get('/api/data', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  d.effectiveMonth    = getEffectiveMonth(d.config);
  d.currentAutoMonth  = getEffectiveMonth(d.config);
  res.json(d);
});

app.post('/api/data', authMiddleware, (req, res) => {
  // בדוק מגבלת דיירים אם יש עדכון של רשימת דיירים
  if (req.body.tenants) {
    const users = loadUsers();
    const user  = users.find(u => u.tenantId === req.user.tenantId);
    if (user) {
      const maxT = getPlanMaxTenants(user);
      const planName = user.plan.charAt(0).toUpperCase() + user.plan.slice(1);
      if (req.body.tenants.length > maxT) {
        return res.json({ ok: false, limitError: true, error: `הגעת למגבלת ${maxT} דיירים בתוכנית ${planName} — צור קשר לשדרוג`, max: maxT });
      }
    }
  }
  // If sentLog is being updated, sync manual/bank payments to paymentHistory
  if (req.body.sentLog) {
    const current = loadTenantData(req.user.tenantId);
    const config  = current.config || {};
    // Use bankMonthOverride if provided (from bank import month selector), else current month
    const mk = req.body.bankMonthOverride || getMonthKey(config);
    const tenants = current.tenants || [];
    if (!current.paymentHistory) current.paymentHistory = {};
    Object.entries(req.body.sentLog).forEach(([key, val]) => {
      if (!val) return;
      const [tenantId] = key.split('_');
      const tenant = tenants.find(t => String(t.id) === tenantId);
      if (!tenant) return;
      const amount = tenant.customAmount || (config.amount || 300);
      let type = null;
      let payerName = '';
      if (String(val).startsWith('manual_paid')) type = 'manual';
      else if (String(val).startsWith('bank_import')) {
        type = 'bank';
        // Extract payer name stored as: bank_import_..._amount_payer_NAME
        const payerMatch = String(val).match(/_payer_(.+)$/);
        if (payerMatch) payerName = payerMatch[1];
      }
      if (type) recordPayment(current, tenantId, mk, type, amount, tenant.name, payerName);
    });
    req.body.paymentHistory = current.paymentHistory;
    delete req.body.bankMonthOverride; // don't save this field to tenant data
  }
  const merged = saveTenantData(req.user.tenantId, req.body);
  res.json({ ok: true, effectiveMonth: getEffectiveMonth(merged.config), data: merged });
});

// Init WhatsApp — במצב ענן מחזיר סטטוס מה-Bridge, במצב local מפעיל WA
app.post('/api/wa/init', authMiddleware, (req, res) => {
  const { tenantId } = req.user;
  const wa = getWa(tenantId);
  console.log(`[wa/init] mode=${WA_MODE} tenantId=${tenantId} status=${wa.status}`);

  if (WA_MODE === 'cloud') {
    // במצב ענן — ה-Bridge הוא שמנהל את WA, רק מחזיר סטטוס נוכחי
    return res.json({ ok: true, status: wa.status, qrDataUrl: wa.qrData });
  }

  // מצב local — הפעל WA ישירות
  if (!wa.client) {
    console.log(`[wa/init] starting local WA for ${tenantId}`);
    initWa(tenantId);
  }
  res.json({ ok: true, status: wa.restarting ? 'reconnecting' : wa.status, qrDataUrl: wa.qrData });
});

// Reconnect WhatsApp
app.post('/api/reconnect', authMiddleware, async (req, res) => {
  await restartWa(req.user.tenantId, 'manual');
  res.json({ ok: true });
});

// Send to single tenant
app.post('/api/send/:id', authMiddleware, async (req, res) => {
  const d      = loadTenantData(req.user.tenantId);
  const tenant = d.tenants.find(t => String(t.id) === req.params.id);
  if (!tenant) return res.json({ ok: false, error: 'דייר לא נמצא' });
  const month  = getEffectiveMonth(d.config);
  const globalAmount = (d.config||{}).amount || 300;
  const amount = tenant.customAmount || globalAmount;
  const tmpl   = (d.config||{}).template || 'שלום {שם}!\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה!';
  const msg    = tmpl.replace(/{שם}/g,tenant.name).replace(/{חודש}/g,month).replace(/{סכום}/g,amount);
  try {
    await sendWaMsg(req.user.tenantId, tenant.phone, msg);
    const key = tenant.id+'_'+month; d.sentLog[key]='sent_'+new Date().toISOString();
    // Record to permanent history
    const mk = getMonthKey(d.config);
    recordPayment(d, String(tenant.id), mk, 'wa_sent', amount, tenant.name);
    saveTenantData(req.user.tenantId, { sentLog: d.sentLog, paymentHistory: d.paymentHistory });
    res.json({ ok: true, month });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Send all
app.post('/api/send-all', authMiddleware, async (req, res) => {
  const d      = loadTenantData(req.user.tenantId);
  const month  = getEffectiveMonth(d.config);
  const globalAmount = (d.config||{}).amount || 300;
  const tmpl   = (d.config||{}).template || 'שלום {שם}!\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה!';
  const mk = getMonthKey(d.config);
  let sent = 0;
  for (const tenant of d.tenants) {
    const amount = tenant.customAmount || globalAmount;
    const msg = tmpl.replace(/{שם}/g,tenant.name).replace(/{חודש}/g,month).replace(/{סכום}/g,amount);
    try {
      await sendWaMsg(req.user.tenantId, tenant.phone, msg);
      d.sentLog[tenant.id+'_'+month]='sent_'+new Date().toISOString();
      recordPayment(d, String(tenant.id), mk, 'wa_sent', amount, tenant.name);
      sent++;
      await new Promise(r=>setTimeout(r,1200));
    }
    catch(e) { console.error(`[send-all:${req.user.tenantId}]`, tenant.name, e.message); }
  }
  saveTenantData(req.user.tenantId, { sentLog: d.sentLog, paymentHistory: d.paymentHistory });
  res.json({ ok: true, sent });
});

// Generic send message
app.post('/api/send-message', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.json({ ok: false, error: 'חסר מידע' });
  try { await sendWaMsg(req.user.tenantId, phone, message); res.json({ ok: true }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

// הורדת config.json מותאם אישית ללקוח
app.get('/api/bridge/config', authMiddleware, (req, res) => {
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const config = {
    cloudUrl:     appUrl,
    bridgeSecret: BRIDGE_SECRET,
    tenantId:     req.user.tenantId
  };
  res.setHeader('Content-Disposition', 'attachment; filename="config.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(config, null, 2));
});

// ── הורדת חבילת Bridge מלאה (ZIP עם config מובנה) ──────────────
app.get('/api/bridge/download', authMiddleware, (req, res) => {
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const config = {
    cloudUrl:     appUrl,
    bridgeSecret: BRIDGE_SECRET,
    tenantId:     req.user.tenantId
  };
  const configJson = JSON.stringify(config, null, 2);

  // קבצי ה-Bridge מוטמעים בקוד
  const BRIDGE_FILES = {
    'config.json':        configJson,
    'bridge.js':          BRIDGE_JS_CONTENT,
    'package.json':       BRIDGE_PKG_CONTENT,
    'install.bat':        BRIDGE_INSTALL_BAT,
    'start.bat':          BRIDGE_START_BAT,
    'install.sh':         BRIDGE_INSTALL_SH,
    'start.sh':           BRIDGE_START_SH,
    'VaadPro-Start.bat':  VAADPRO_START_BAT,
    'VaadPro-Start.sh':   VAADPRO_START_SH,
    'README.md':          BRIDGE_README
  };

  // בנה ZIP ידנית (פורמט ZIP פשוט ללא דחיסה - Stored)
  const buildZip = (files) => {
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
      const nameBuf  = Buffer.from(name, 'utf8');
      const dataBuf  = Buffer.from(content, 'utf8');
      const crc      = crc32(dataBuf);
      const now      = new Date();
      const dosDate  = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
      const dosTime  = (now.getHours()<<11)|(now.getMinutes()<<5)|(Math.floor(now.getSeconds()/2));

      // Local file header
      const lh = Buffer.alloc(30 + nameBuf.length);
      lh.writeUInt32LE(0x04034b50,0);  // signature
      lh.writeUInt16LE(20,4);           // version needed
      lh.writeUInt16LE(0,6);            // flags
      lh.writeUInt16LE(0,8);            // compression (stored)
      lh.writeUInt16LE(dosTime,10);
      lh.writeUInt16LE(dosDate,12);
      lh.writeUInt32LE(crc,14);
      lh.writeUInt32LE(dataBuf.length,18);
      lh.writeUInt32LE(dataBuf.length,22);
      lh.writeUInt16LE(nameBuf.length,26);
      lh.writeUInt16LE(0,28);
      nameBuf.copy(lh,30);

      parts.push(lh, dataBuf);

      // Central directory entry
      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50,0);
      cd.writeUInt16LE(20,4);
      cd.writeUInt16LE(20,6);
      cd.writeUInt16LE(0,8);
      cd.writeUInt16LE(0,10);
      cd.writeUInt16LE(dosTime,12);
      cd.writeUInt16LE(dosDate,14);
      cd.writeUInt32LE(crc,16);
      cd.writeUInt32LE(dataBuf.length,20);
      cd.writeUInt32LE(dataBuf.length,24);
      cd.writeUInt16LE(nameBuf.length,28);
      cd.writeUInt16LE(0,30);
      cd.writeUInt16LE(0,32);
      cd.writeUInt16LE(0,34);
      cd.writeUInt16LE(0,36);
      cd.writeUInt32LE(0,38);
      cd.writeUInt32LE(offset,42);
      nameBuf.copy(cd,46);
      centralDir.push(cd);

      offset += lh.length + dataBuf.length;
    }

    const cdBuf   = Buffer.concat(centralDir);
    const eocd    = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,0);
    eocd.writeUInt16LE(0,4);
    eocd.writeUInt16LE(0,6);
    eocd.writeUInt16LE(centralDir.length,8);
    eocd.writeUInt16LE(centralDir.length,10);
    eocd.writeUInt32LE(cdBuf.length,12);
    eocd.writeUInt32LE(offset,16);
    eocd.writeUInt16LE(0,20);

    return Buffer.concat([...parts, cdBuf, eocd]);
  };

  // CRC-32
  const crc32 = (() => {
    const table = new Uint32Array(256);
    for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xEDB88320^(c>>>1):c>>>1;table[i]=c;}
    return (buf) => {
      let crc=0xFFFFFFFF;
      for(let i=0;i<buf.length;i++)crc=table[(crc^buf[i])&0xFF]^(crc>>>8);
      return (crc^0xFFFFFFFF)>>>0;
    };
  })();

  try {
    const zipBuf = buildZip(BRIDGE_FILES);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="VaadPro-Bridge.zip"');
    res.setHeader('Content-Length', zipBuf.length);
    res.send(zipBuf);
  } catch(e) {
    console.error('[bridge/download]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// ADMIN SYSTEM v1.4
// ════════════════════════════════════════════════════════════════
const ADMIN_USERS_FILE = path.join(DATA_DIR, '_admins.json');
const TEMPLATES_FILE = path.join(DATA_DIR, '_templates.json');
const LEADS_FILE = path.join(DATA_DIR, '_leads.json');
const INSTALL_STATUS_FILE = path.join(DATA_DIR, '_install_status.json');

function loadInstallStatus() {
  if (!fs.existsSync(INSTALL_STATUS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(INSTALL_STATUS_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveInstallStatus(s) { fs.writeFileSync(INSTALL_STATUS_FILE, JSON.stringify(s, null, 2)); }

function loadLeads() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch(e) { return []; }
}
function saveLeads(leads) { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); }
const CRM_FILE = path.join(DATA_DIR, '_crm.json');

function loadCRM() {
  if (!fs.existsSync(CRM_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CRM_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveCRM(data) { fs.writeFileSync(CRM_FILE, JSON.stringify(data, null, 2)); }
function getCRMCard(id) { const c = loadCRM(); return c[id] || { notes: [], tasks: [], status: '', calls: [] }; }
function saveCRMCard(id, card) { const c = loadCRM(); c[id] = card; saveCRM(c); }
const MSG_LOG_FILE = path.join(DATA_DIR, '_msglog.json');

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); } catch(e) { return []; }
}
function saveTemplates(t) { fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(t, null, 2)); }

function loadMsgLog() {
  if (!fs.existsSync(MSG_LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(MSG_LOG_FILE, 'utf8')); } catch(e) { return []; }
}
function addMsgLog(entry) {
  const log = loadMsgLog();
  log.unshift({ ...entry, ts: new Date().toISOString() });
  // מחיקה אוטומטית: שמור רק 90 ימים אחרונים (מקסימום 1000 רשומות)
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const cleaned = log.filter(e => new Date(e.ts) > cutoff).slice(0, 1000);
  fs.writeFileSync(MSG_LOG_FILE, JSON.stringify(cleaned, null, 2));
}
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET + '-admin';

function loadAdmins() {
  if (!fs.existsSync(ADMIN_USERS_FILE)) {
    const defaultAdmin = [{
      id: 'super-1',
      email: process.env.ADMIN_EMAIL || 'admin@vaadpro.co.il',
      name: 'Super Admin',
      role: 'super',
      passHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'VaadPro2025!', 10)
    }];
    fs.writeFileSync(ADMIN_USERS_FILE, JSON.stringify(defaultAdmin, null, 2));
    return defaultAdmin;
  }
  try {
    const admins = JSON.parse(fs.readFileSync(ADMIN_USERS_FILE, 'utf8'));
    // מיגרציה — הוסף role=super לadmins ישנים
    let changed = false;
    admins.forEach(a => {
      if (!a.role) { a.role = 'super'; changed = true; }
      if (!a.id) { a.id = require('uuid').v4(); changed = true; }
      if (!a.name) { a.name = a.email.split('@')[0]; changed = true; }
    });
    if (changed) fs.writeFileSync(ADMIN_USERS_FILE, JSON.stringify(admins, null, 2));
    return admins;
  } catch(e) { return []; }
}
function saveAdmins(admins) { fs.writeFileSync(ADMIN_USERS_FILE, JSON.stringify(admins, null, 2)); }

// חסום צופים מפעולות כתיבה
function viewerBlockMiddleware(req, res, next) {
  const token = (req.headers['x-admin-token'] || '').replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (decoded.role === 'viewer') return res.status(403).json({ ok: false, error: 'אין הרשאה — צופה בלבד' });
    next();
  } catch(e) { next(); }
}

function adminAuthMiddleware(req, res, next) {
  const token = (req.headers['x-admin-token'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'אסור' });
    req.adminUser = decoded;
    next();
  } catch(e) {
    res.status(401).json({ error: 'פג תוקף החיבור' });
  }
}

// Super Admin בלבד
function superAdminMiddleware(req, res, next) {
  const token = (req.headers['x-admin-token'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'אסור' });
    if (decoded.role !== 'super') return res.status(403).json({ error: 'נדרשות הרשאות Super Admin' });
    req.adminUser = decoded;
    next();
  } catch(e) {
    res.status(401).json({ error: 'פג תוקף החיבור' });
  }
}

// ── Admin Login ──────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ ok: false, error: 'יש למלא אימייל וסיסמה' });
  const admins = loadAdmins();
  const admin = admins.find(a => a.email === email.toLowerCase());
  if (!admin) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });
  const ok = await bcrypt.compare(password, admin.passHash);
  if (!ok) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });
  const token = jwt.sign({ email: admin.email, isAdmin: true, role: admin.role || 'admin', name: admin.name || '' }, ADMIN_JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token, email: admin.email, role: admin.role || 'admin', name: admin.name || '' });
});

// ── Admin: ניהול משתמשי Admin ──────────────────────────────────
app.get('/api/admin/admins', superAdminMiddleware, (req, res) => {
  const admins = loadAdmins().map(a => ({ id: a.id, email: a.email, name: a.name, role: a.role }));
  res.json({ admins });
});

app.post('/api/admin/admins', superAdminMiddleware, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return res.json({ ok: false, error: 'חסרים שדות חובה' });
  if (!['admin', 'super', 'viewer'].includes(role)) return res.json({ ok: false, error: 'תפקיד לא תקין' });
  const admins = loadAdmins();
  if (admins.find(a => a.email === email.toLowerCase())) return res.json({ ok: false, error: 'אימייל כבר קיים' });
  const passHash = await bcrypt.hash(password, 10);
  admins.push({ id: require('uuid').v4(), email: email.toLowerCase(), name, role, passHash });
  saveAdmins(admins);
  res.json({ ok: true });
});

app.delete('/api/admin/admins/:id', superAdminMiddleware, (req, res) => {
  const admins = loadAdmins();
  const target = admins.find(a => a.id === req.params.id);
  if (!target) return res.json({ ok: false, error: 'לא נמצא' });
  if (target.role === 'super' && admins.filter(a => a.role === 'super').length === 1)
    return res.json({ ok: false, error: 'חייב להישאר לפחות Super Admin אחד' });
  saveAdmins(admins.filter(a => a.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/admins/:id/password', superAdminMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.json({ ok: false, error: 'סיסמה קצרה מדי' });
  const admins = loadAdmins();
  const idx = admins.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.json({ ok: false, error: 'לא נמצא' });
  admins[idx].passHash = await bcrypt.hash(password, 10);
  saveAdmins(admins);
  res.json({ ok: true });
});

// ── Admin: רשימת לקוחות ─────────────────────────────────────────
app.get('/api/admin/tenants', adminAuthMiddleware, (req, res) => {
  const users = loadUsers().map(u => ({
    email: u.email, buildingName: u.buildingName, address: u.address,
    fullName: u.fullName||'', phone: u.phone||'',
    plan: u.plan, trialEnd: u.trialEnd, createdAt: u.createdAt,
    tenantId: u.tenantId
  }));
  res.json({ count: users.length, users });
});

// ── Admin: שינוי plan ───────────────────────────────────────────
app.post('/api/admin/set-plan', superAdminMiddleware, (req, res) => {
  const { email, plan, maxTenantsOverride } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'משתמש לא נמצא' });
  if (!['trial','basic','advanced','premium','unlimited','suspended'].includes(plan)) {
    return res.json({ ok: false, error: 'plan לא תקין' });
  }
  user.plan = plan;
  if (maxTenantsOverride && maxTenantsOverride > 0) {
    user.maxTenantsOverride = maxTenantsOverride;
  } else {
    delete user.maxTenantsOverride;
  }
  if (plan === 'trial') {
    user.trialEnd = new Date(Date.now() + 30*24*60*60*1000).toISOString();
    delete user.suspended;
  } else if (plan === 'unlimited') {
    delete user.trialEnd;
    delete user.suspended;
  } else if (plan === 'suspended') {
    user.suspended = true;
    delete user.trialEnd;
  } else {
    delete user.trialEnd;
    delete user.suspended;
  }
  // Reset trial email flags when plan changes
  delete user._trialEmailSent;
  saveUsers(users);
  res.json({ ok: true, email, plan });
});

// ── Admin: הארכת מנוי ───────────────────────────────────────────
app.post('/api/admin/extend-trial', adminAuthMiddleware, (req, res) => {
  const { email, days } = req.body;
  if (!email || !days || days < 1) return res.json({ ok: false, error: 'פרמטרים חסרים' });
  const users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'משתמש לא נמצא' });
  // אם אין trialEnd — קבע מהיום
  const base = user.trialEnd && new Date(user.trialEnd) > new Date()
    ? new Date(user.trialEnd)
    : new Date();
  user.trialEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  if (user.plan !== 'trial') user.plan = 'trial';
  delete user.suspended;
  delete user._trialEmailSent;
  saveUsers(users);
  res.json({ ok: true, email, trialEnd: user.trialEnd, days });
});

// ── Admin: ניקוי לוג שליחות ─────────────────────────────────────
app.post('/api/admin/msglog/clean', adminAuthMiddleware, (req, res) => {
  const { days } = req.body;
  const d = parseInt(days) || 90;
  const log = loadMsgLog();
  const cutoff = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
  const before = log.length;
  const cleaned = log.filter(e => new Date(e.ts) > cutoff);
  fs.writeFileSync(MSG_LOG_FILE, JSON.stringify(cleaned, null, 2));
  res.json({ ok: true, removed: before - cleaned.length, remaining: cleaned.length });
});

// ── Tenant: שליחת מייל עם קובץ מצורף ───────────────────────────
app.post('/api/send-email-tenant', authMiddleware, async (req, res) => {
  const { to, subject, body, attachment } = req.body;
  if (!to || !subject || !body) return res.json({ ok: false, error: 'חסרים פרטים' });
  try {
    const fromAddr = SMTP_FROM || 'VaadPro <onboarding@resend.dev>';
    const adminEmail = process.env.ADMIN_EMAIL || '';
    const isHtml = /<(html|body|img|div|p|br|h[1-6]|table|span)[^>]*>/i.test(body);
    const payload = { from: fromAddr, to, subject };
    if (isHtml) { payload.html = body.replace(/\n/g, '<br>'); } else { payload.text = body; }
    if (adminEmail) payload.reply_to = adminEmail;
    if (attachment && attachment.content && attachment.filename) {
      payload.attachments = [{
        filename: attachment.filename,
        content:  attachment.content,
        type:     attachment.type || 'application/octet-stream'
      }];
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || JSON.stringify(data));
    addMsgLog({ channel: 'email', to, subject, message: body.slice(0,100), status: 'sent' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[send-email-tenant]', e.message);
    addMsgLog({ channel: 'email', to, subject, message: body.slice(0,100), status: 'failed', error: e.message });
    res.json({ ok: false, error: e.message });
  }
});

// ── Admin: שליחת מייל (Resend / SMTP fallback) ─────────────────
app.post('/api/admin/send-email', adminAuthMiddleware, viewerBlockMiddleware, async (req, res) => {
  const { to, subject, body, attachment } = req.body;
  if (!to || !subject || !body) return res.json({ ok: false, error: 'חסרים שדות' });
  try {
    if (RESEND_API_KEY) {
      // שלח דרך Resend עם קובץ מצורף אם יש
      const fromAddr = SMTP_FROM || 'VaadPro <onboarding@resend.dev>';
      const adminEmail = process.env.ADMIN_EMAIL || '';
      const isHtml = /<(html|body|img|div|p|br|h[1-6]|table|span)[^>]*>/i.test(body);
      const payload = { from: fromAddr, to, subject };
      if (isHtml) { payload.html = body.replace(/\n/g, '<br>'); } else { payload.text = body; }
      if (adminEmail) payload.reply_to = adminEmail;
      if (attachment && attachment.content && attachment.filename) {
        payload.attachments = [{ filename: attachment.filename, content: attachment.content, type: attachment.type||'application/octet-stream' }];
      }
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || JSON.stringify(data));
    } else if (SMTP_USER) {
      const nodemailer = require('nodemailer');
      let transportConfig;
      if (!SMTP_HOST || SMTP_HOST.includes('gmail') || SMTP_USER.includes('gmail.com')) {
        transportConfig = { service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } };
      } else {
        transportConfig = { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } };
      }
      const transporter = require('nodemailer').createTransport(transportConfig);
      await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text: body });
    } else {
      return res.json({ ok: false, error: 'לא מוגדר שירות מייל (RESEND_API_KEY או SMTP_USER)' });
    }
    addMsgLog({ channel: 'email', to, subject, message: body, status: 'sent' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Admin:send-email]', e.message);
    addMsgLog({ channel: 'email', to, subject, message: body, status: 'failed', error: e.message });
    res.json({ ok: false, error: e.message });
  }
});

// ── Admin: שליחת WA ─────────────────────────────────────────────
app.post('/api/admin/send-wa', adminAuthMiddleware, viewerBlockMiddleware, async (req, res) => {
  const { phone, message, tenantId, sendToOwner } = req.body;
  if (!message) return res.json({ ok: false, error: 'חסרה הודעה' });

  // בחר bridge לשליחה — כל bridge פעיל
  const bridgeTenantId = Object.keys(waClients).find(id => {
    const wa = waClients[id];
    return wa && (wa.status === 'connected' || wa.status === 'ready');
  });
  if (!bridgeTenantId) return res.json({ ok: false, error: 'אין Bridge מחובר. חבר WA תחילה.' });

  // אם sendToOwner — שלח לטלפון של בעל ה-tenantId
  let targetPhone = phone;
  if (sendToOwner && tenantId) {
    const users = loadUsers();
    const user = users.find(u => u.tenantId === tenantId);
    if (!user) return res.json({ ok: false, error: 'לקוח לא נמצא' });
    if (!user.phone) return res.json({ ok: false, error: `ללקוח ${user.email} אין מספר טלפון בפרופיל` });
    targetPhone = user.phone;
  }

  if (!targetPhone) return res.json({ ok: false, error: 'חסר מספר טלפון' });

  try {
    await sendWaMsg(bridgeTenantId, targetPhone, message);
    addMsgLog({ channel: 'wa', to: targetPhone, message, status: 'sent', contactId: tenantId||'' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Admin:send-wa]', e.message);
    addMsgLog({ channel: 'wa', to: targetPhone, message, status: 'failed', error: e.message });
    res.json({ ok: false, error: e.message });
  }
});

// ── Admin: עדכון טלפון לקוח ────────────────────────────────────
app.post('/api/admin/set-phone', adminAuthMiddleware, (req, res) => {
  const { email, phone } = req.body;
  if (!email || !phone) return res.json({ ok: false, error: 'חסרים שדות' });
  const users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'משתמש לא נמצא' });
  user.phone = phone;
  saveUsers(users);
  res.json({ ok: true });
});

// ── Admin: רשימת Bridges פעילים ────────────────────────────────
app.get('/api/admin/bridges', adminAuthMiddleware, (req, res) => {
  const bridges = Object.entries(waClients).map(([tenantId, wa]) => {
    const users = loadUsers();
    const user = users.find(u => u.tenantId === tenantId);
    return { tenantId, status: wa.status, phone: wa.phone, email: user ? user.email : tenantId, buildingName: user ? user.buildingName : '' };
  }).filter(b => b.status === 'connected' || b.status === 'ready');
  res.json({ bridges });
});

// ── Admin: CRM ──────────────────────────────────────────────────

// קבל כרטיית לקוח/ליד
app.get('/api/admin/crm/:id', adminAuthMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  // הוסף היסטוריית הודעות מהלוג
  const log = loadMsgLog().filter(l => l.contactId === req.params.id);
  res.json({ ok: true, card, msgHistory: log });
});

// שמור כרטיית לקוח/ליד
app.post('/api/admin/crm/:id', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  const updated = Object.assign(card, req.body);
  saveCRMCard(req.params.id, updated);
  // If status changed, sync it to _leads.json as well
  if (req.body.status !== undefined) {
    const leads = loadLeads();
    const lead = leads.find(l => l.id === req.params.id);
    if (lead) {
      lead.status = req.body.status;
      saveLeads(leads);
    }
  }
  res.json({ ok: true });
});

// הוסף סיכום שיחה
app.post('/api/admin/crm/:id/call', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const { summary } = req.body;
  if (!summary) return res.json({ ok: false, error: 'חסר סיכום' });
  const card = getCRMCard(req.params.id);
  if (!card.calls) card.calls = [];
  card.calls.unshift({ id: uuidv4(), summary, ts: new Date().toISOString() });
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// הוסף משימה
app.post('/api/admin/crm/:id/task', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const { text, dueDate } = req.body;
  if (!text) return res.json({ ok: false, error: 'חסר טקסט' });
  const card = getCRMCard(req.params.id);
  if (!card.tasks) card.tasks = [];
  card.tasks.unshift({ id: uuidv4(), text, dueDate: dueDate||'', done: false, ts: new Date().toISOString() });
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// עדכן סטטוס משימה
app.patch('/api/admin/crm/:id/task/:taskId', adminAuthMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  const task = (card.tasks||[]).find(t => t.id === req.params.taskId);
  if (!task) return res.json({ ok: false, error: 'משימה לא נמצאה' });
  task.done = req.body.done;
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// מחק פריט (שיחה/משימה)
app.delete('/api/admin/crm/:id/:type/:itemId', adminAuthMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  const key = req.params.type === 'call' ? 'calls' : 'tasks';
  card[key] = (card[key]||[]).filter(x => x.id !== req.params.itemId);
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// ── Admin: לידים ────────────────────────────────────────────────
app.get('/api/admin/leads', adminAuthMiddleware, (req, res) => {
  res.json({ leads: loadLeads() });
});

app.post('/api/admin/leads', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const { id, name, phone, email, source, status, notes } = req.body;
  if (!name) return res.json({ ok: false, error: 'שם חובה' });
  const leads = loadLeads();
  const existing = leads.findIndex(l => l.id === id);
  const lead = { id: id || require('uuid').v4(), name, phone: phone||'', email: email||'', source: source||'', status: status||'חדש', notes: notes||'', createdAt: existing>=0 ? leads[existing].createdAt : new Date().toISOString() };
  if (existing >= 0) leads[existing] = lead;
  else leads.unshift(lead);
  saveLeads(leads);
  res.json({ ok: true, lead });
});

app.delete('/api/admin/leads/:id', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const leads = loadLeads().filter(l => l.id !== req.params.id);
  saveLeads(leads);
  res.json({ ok: true });
});

app.post('/api/admin/leads/import', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const { leads: newLeads } = req.body;
  if (!Array.isArray(newLeads)) return res.json({ ok: false, error: 'פורמט שגוי' });
  const leads = loadLeads();
  let added = 0;
  newLeads.forEach(l => {
    if (!l.name) return;
    leads.unshift({ id: require('uuid').v4(), name: l.name||'', phone: l.phone||'', email: l.email||'', source: l.source||'CSV', status: l.status||'חדש', notes: l.notes||'', createdAt: new Date().toISOString() });
    added++;
  });
  saveLeads(leads);
  res.json({ ok: true, added });
});

// ── Admin: תבניות הודעות ────────────────────────────────────────
app.get('/api/admin/templates', adminAuthMiddleware, (req, res) => {
  res.json({ templates: loadTemplates() });
});

app.post('/api/admin/templates', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const { name, channel, subject, body } = req.body;
  if (!name || !body) return res.json({ ok: false, error: 'חסרים שדות' });
  const templates = loadTemplates();
  const existing = templates.findIndex(t => t.id === req.body.id);
  const template = { id: req.body.id || uuidv4(), name, channel: channel||'wa', subject: subject||'', body, updatedAt: new Date().toISOString() };
  if (existing >= 0) templates[existing] = template;
  else templates.unshift(template);
  saveTemplates(templates);
  res.json({ ok: true, template });
});

app.delete('/api/admin/templates/:id', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const templates = loadTemplates().filter(t => t.id !== req.params.id);
  saveTemplates(templates);
  res.json({ ok: true });
});

// ── Admin: לוג שליחות ───────────────────────────────────────────
app.get('/api/admin/msglog', adminAuthMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const log = loadMsgLog().slice(0, limit);
  res.json({ log });
});

// ── Admin: שרת קובץ admin.html ──────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ════════════════════════════════════════════════════════════════
// TRIAL MANAGEMENT
// ════════════════════════════════════════════════════════════════

async function sendTrialEmail(user, type) {
  if (!RESEND_API_KEY && !SMTP_USER) return;
  const daysLeft = type === 'warning' ? 3 : 0;
  const subject = type === 'warning'
    ? 'VaadPro — נותרו 3 ימים לתקופת הניסיון שלך ⏰'
    : 'VaadPro — תקופת הניסיון שלך הסתיימה 🔔';
  const body = type === 'warning'
    ? `שלום ${user.fullName||user.buildingName||''},

תקופת הניסיון שלך ב-VaadPro תסתיים בעוד 3 ימים.

כדי להמשיך ליהנות מהשירות ולא לאבד גישה — צור איתנו קשר לחידוש המנוי.

אימייל: support@vaadpro.co.il

תודה שאתה משתמש ב-VaadPro!
צוות VaadPro`
    : `שלום ${user.fullName||user.buildingName||''},

תקופת הניסיון החינמית שלך ב-VaadPro הסתיימה היום.

כדי להמשיך לשלוח תזכורות תשלום לדיירים — צור איתנו קשר לחידוש המנוי.

אימייל: support@vaadpro.co.il
טלפון: צור קשר דרך הווטסאפ

צוות VaadPro`;
  try {
    if (RESEND_API_KEY) {
      await sendEmailResend(user.email, subject, body);
    } else {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({ service:'gmail', auth:{ user:SMTP_USER, pass:SMTP_PASS } });
      await t.sendMail({ from: SMTP_FROM||SMTP_USER, to: user.email, subject, text: body });
    }
    console.log(`[Trial] ${type} email sent to ${user.email}`);
    return true;
  } catch(e) {
    console.error(`[Trial] email failed for ${user.email}:`, e.message);
    return false;
  }
}

async function runTrialCheck() {
  const users = loadUsers();
  const now   = new Date();
  let warned = 0, expired = 0;

  for (const user of users) {
    if (user.plan !== 'trial' || !user.trialEnd || user.plan === 'unlimited') continue;
    const end      = new Date(user.trialEnd);
    const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
    const lastSent = user._trialEmailSent || {};

    if (daysLeft <= 0 && !lastSent.expired) {
      await sendTrialEmail(user, 'expired');
      user._trialEmailSent = { ...lastSent, expired: now.toISOString() };
      expired++;
    } else if (daysLeft <= 3 && daysLeft > 0 && !lastSent.warning) {
      await sendTrialEmail(user, 'warning');
      user._trialEmailSent = { ...lastSent, warning: now.toISOString() };
      warned++;
    }
  }

  if (warned > 0 || expired > 0) {
    saveUsers(users);
    console.log(`[Trial] check done: ${warned} warnings, ${expired} expired emails sent`);
  }
  return { warned, expired };
}

// הרץ בדיקה כל 24 שעות
setInterval(runTrialCheck, 24 * 60 * 60 * 1000);
// הרץ גם בהפעלה (אחרי 30 שניות)
setTimeout(runTrialCheck, 30 * 1000);

// ── Admin: עריכת לקוח ───────────────────────────────────────────
app.post('/api/admin/edit-customer', superAdminMiddleware, async (req, res) => {
  const { oldEmail, newEmail, fullName, phone, buildingName, address, password } = req.body;
  if (!oldEmail || !newEmail) return res.json({ ok: false, error: 'חסר אימייל' });
  const users = loadUsers();
  const idx = users.findIndex(u => u.email === oldEmail.toLowerCase());
  if (idx < 0) return res.json({ ok: false, error: 'לקוח לא נמצא' });
  // בדוק שהאימייל החדש לא תפוס (אם שונה)
  const newEmailLower = newEmail.toLowerCase();
  if (newEmailLower !== oldEmail.toLowerCase()) {
    if (users.find(u => u.email === newEmailLower)) {
      return res.json({ ok: false, error: 'אימייל זה כבר קיים במערכת' });
    }
    users[idx].email = newEmailLower;
  }
  if (fullName !== undefined) users[idx].fullName = fullName;
  if (phone !== undefined) users[idx].phone = phone;
  if (buildingName) users[idx].buildingName = buildingName;
  if (address !== undefined) users[idx].address = address;
  if (password && password.length >= 6) {
    users[idx].passHash = await bcrypt.hash(password, 10);
  }
  saveUsers(users);
  res.json({ ok: true });
});

// ── Admin: מחיקת לקוח ───────────────────────────────────────────
app.post('/api/admin/delete-customer', superAdminMiddleware, (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ ok: false, error: 'חסר אימייל' });
  let users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'לקוח לא נמצא' });
  // מחק קובץ נתוני הבניין
  const tf = tenantFile(user.tenantId);
  if (fs.existsSync(tf)) fs.unlinkSync(tf);
  // הסר מרשימת המשתמשים
  users = users.filter(u => u.email !== email.toLowerCase());
  saveUsers(users);
  res.json({ ok: true });
});

// ── Admin: ממתינים להתקנה ───────────────────────────────────────
// ── Admin: עדכון סטטוס התקנה ידני ─────────────────────────────
app.post('/api/admin/install-status', adminAuthMiddleware, viewerBlockMiddleware, (req, res) => {
  const { email, status } = req.body;
  if (!email || !status) return res.json({ ok: false, error: 'חסרים פרטים' });
  const statuses = loadInstallStatus();
  statuses[email] = { status, updatedAt: new Date().toISOString() };
  saveInstallStatus(statuses);
  res.json({ ok: true });
});

app.get('/api/admin/waiting-install', adminAuthMiddleware, (req, res) => {
  const users = loadUsers();
  const now = new Date();
  const minDays = parseInt(req.query.days) || 0;
  const statuses = loadInstallStatus();
  const waiting = users
    .filter(u => {
      if (u.plan === 'suspended') return false;
      const daysSince = (now - new Date(u.createdAt)) / (1000*60*60*24);
      if (daysSince < minDays) return false;
      // הוסתר ידנית (הותקן / לא מעוניין)
      const st = statuses[u.email];
      if (st && (st.status === 'installed' || st.status === 'not_interested')) return false;
      // בדוק אם חיבר Bridge לאחרונה (30 ימים)
      const wa = waClients[u.tenantId];
      const activeInMemory = wa && wa.phone;
      const lastConn = u.lastConnectedAt ? new Date(u.lastConnectedAt) : null;
      const daysSinceConn = lastConn ? (now - lastConn) / (1000*60*60*24) : Infinity;
      const recentlyConnected = activeInMemory || daysSinceConn < 30;
      return !recentlyConnected;
    })
    .map(u => ({
      email: u.email,
      fullName: u.fullName||'',
      buildingName: u.buildingName||'',
      phone: u.phone||'',
      createdAt: u.createdAt,
      daysSince: Math.floor((now - new Date(u.createdAt)) / (1000*60*60*24)),
      plan: u.plan,
      trialEnd: u.trialEnd||null,
      maxTenantsOverride: u.maxTenantsOverride||null,
      lastConnectedAt: u.lastConnectedAt||null,
      installStatus: (statuses[u.email] && statuses[u.email].status) || 'pending'
    }))
    .sort((a,b) => b.daysSince - a.daysSince);
  res.json({ waiting });
});

// ── Admin: הרצת בדיקת Trial ידנית ──────────────────────────────
app.post('/api/admin/trial-check', adminAuthMiddleware, async (req, res) => {
  const result = await runTrialCheck();
  res.json({ ok: true, ...result });
});

// ── Admin: לקוחות שפג/עומד לפוג ─────────────────────────────────
app.get('/api/admin/trials', adminAuthMiddleware, (req, res) => {
  const now   = new Date();
  const users = loadUsers();
  const trials = users
    .filter(u => u.plan === 'trial' && u.trialEnd)
    .map(u => {
      const end      = new Date(u.trialEnd);
      const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
      return { email: u.email, fullName: u.fullName||'', buildingName: u.buildingName, phone: u.phone||'', trialEnd: u.trialEnd, daysLeft, expired: daysLeft <= 0 };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);
  res.json({ trials });
});

// ═══════════════════════════════════════════════════════════════
// ── תחזוקת בניין (Maintenance Module) ──────────────────────────
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MAINTENANCE_TASKS = [
  { name: 'בדיקת מעלית',            frequencyMonths: 12, alertDaysBefore: 30, icon: '🛗' },
  { name: 'בדיקת מטפי כיבוי',       frequencyMonths: 12, alertDaysBefore: 30, icon: '🧯' },
  { name: 'בדיקת גלאי עשן',          frequencyMonths: 12, alertDaysBefore: 30, icon: '🔔' },
  { name: 'חידוש ביטוח בניין',       frequencyMonths: 12, alertDaysBefore: 45, icon: '📋' },
  { name: 'בדיקת גנרטור',            frequencyMonths: 6,  alertDaysBefore: 14, icon: '⚡' },
  { name: 'ניקוי מאגר / מיכל מים',  frequencyMonths: 6,  alertDaysBefore: 14, icon: '💧' },
  { name: 'בדיקת דוד שמש',           frequencyMonths: 6,  alertDaysBefore: 14, icon: '☀️' },
  { name: 'בדיקת תאורת חירום',       frequencyMonths: 3,  alertDaysBefore: 14, icon: '💡' },
  { name: 'ניקוי גג וביוב',          frequencyMonths: 6,  alertDaysBefore: 14, icon: '🏠' },
  { name: 'טיפול גינה',              frequencyMonths: 1,  alertDaysBefore: 3,  icon: '🌿' },
];

function loadMaintenance(tenantId) {
  const d = loadTenantData(tenantId);
  return d.maintenance || [];
}

function saveMaintenance(tenantId, tasks) {
  saveTenantData(tenantId, { maintenance: tasks });
}

function calcNextDue(lastDone, frequencyMonths) {
  if (!lastDone) return null;
  const d = new Date(lastDone);
  d.setMonth(d.getMonth() + frequencyMonths);
  return d.toISOString().split('T')[0];
}

// GET — רשימת משימות תחזוקה
app.get('/api/maintenance', authMiddleware, (req, res) => {
  const tasks = loadMaintenance(req.user.tenantId);
  res.json({ tasks });
});

// GET — ברירת מחדל מוצעת
app.get('/api/maintenance/defaults', authMiddleware, (req, res) => {
  res.json({ defaults: DEFAULT_MAINTENANCE_TASKS });
});

// POST — הוסף משימה
app.post('/api/maintenance', authMiddleware, (req, res) => {
  const tasks = loadMaintenance(req.user.tenantId);
  const { name, frequencyMonths, alertDaysBefore, alertTo, alertMethod, notes, icon, lastDone } = req.body;
  if (!name || !frequencyMonths) return res.json({ ok: false, error: 'שם ותדירות הם שדות חובה' });
  const task = {
    id: uuidv4(),
    name, icon: icon || '🔧',
    frequencyMonths: Number(frequencyMonths),
    alertDaysBefore: Number(alertDaysBefore) || 14,
    alertTo: alertTo || [],
    alertMethod: alertMethod || ['whatsapp'],
    notes: notes || '',
    lastDone: lastDone || null,
    nextDue: lastDone ? calcNextDue(lastDone, Number(frequencyMonths)) : null,
    createdAt: new Date().toISOString()
  };
  tasks.push(task);
  saveMaintenance(req.user.tenantId, tasks);
  res.json({ ok: true, task });
});

// PUT — עדכון משימה
app.put('/api/maintenance/:id', authMiddleware, (req, res) => {
  const tasks = loadMaintenance(req.user.tenantId);
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.json({ ok: false, error: 'משימה לא נמצאה' });
  const updated = Object.assign(tasks[idx], req.body);
  updated.nextDue = updated.lastDone ? calcNextDue(updated.lastDone, updated.frequencyMonths) : null;
  tasks[idx] = updated;
  saveMaintenance(req.user.tenantId, tasks);
  res.json({ ok: true, task: updated });
});

// POST — סמן "בוצע" → מחשב תאריך הבא
app.post('/api/maintenance/:id/done', authMiddleware, (req, res) => {
  const tasks = loadMaintenance(req.user.tenantId);
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.json({ ok: false, error: 'משימה לא נמצאה' });
  const doneDate = req.body.date || new Date().toISOString().split('T')[0];
  task.lastDone = doneDate;
  task.nextDue  = calcNextDue(doneDate, task.frequencyMonths);
  saveMaintenance(req.user.tenantId, tasks);
  res.json({ ok: true, task });
});

// DELETE — מחק משימה
app.delete('/api/maintenance/:id', authMiddleware, (req, res) => {
  let tasks = loadMaintenance(req.user.tenantId);
  tasks = tasks.filter(t => t.id !== req.params.id);
  saveMaintenance(req.user.tenantId, tasks);
  res.json({ ok: true });
});

// POST — שלח תזכורת ידנית
app.post('/api/maintenance/:id/alert', authMiddleware, async (req, res) => {
  const tasks = loadMaintenance(req.user.tenantId);
  const task  = tasks.find(t => t.id === req.params.id);
  if (!task) return res.json({ ok: false, error: 'משימה לא נמצאה' });

  const d = loadTenantData(req.user.tenantId);
  const nextDueStr = task.nextDue || '(לא נקבע)';
  const msg = `🔧 תזכורת תחזוקה — VaadPro\n\n${task.icon || '🔧'} *${task.name}*\nתאריך יעד: ${nextDueStr}\n\n${task.notes ? 'הערות: ' + task.notes : ''}`.trim();

  let sentWa = 0, sentEmail = 0, errors = [];

  for (const recipient of (task.alertTo || [])) {
    // recipient יכול להיות tenant id או אובייקט {phone, email, name}
    let phone = null, email = null, name = '';
    if (typeof recipient !== 'object') {
      // חפש בדיירים — השווה כstring כי id יכול להיות number או string
      const tenant = (d.tenants || []).find(t => String(t.id) === String(recipient));
      if (tenant) { phone = tenant.phone; email = tenant.email; name = tenant.name; }
    } else {
      phone = recipient.phone; email = recipient.email; name = recipient.name || '';
    }

    if ((task.alertMethod || []).includes('whatsapp') && phone) {
      try { await sendWaMsg(req.user.tenantId, phone, msg); sentWa++; }
      catch(e) { errors.push(`WA ${name}: ${e.message}`); }
    }
    if ((task.alertMethod || []).includes('email') && email) {
      try {
        await sendEmailResend(email, `תזכורת תחזוקה: ${task.name}`, msg.replace(/\n/g, '<br>'));
        sentEmail++;
      } catch(e) { errors.push(`Email ${name}: ${e.message}`); }
    }
  }

  // לוג התראה
  task.lastAlertSent = new Date().toISOString();
  saveMaintenance(req.user.tenantId, tasks);

  res.json({ ok: true, sentWa, sentEmail, errors });
});

// ── Cron יומי — בדיקת תחזוקה ───────────────────────────────────
async function runMaintenanceCron() {
  const users = loadUsers();
  const today = new Date();
  today.setHours(0,0,0,0);
  let alertsSent = 0;

  for (const user of users) {
    if (!user.tenantId) continue;
    try {
      const tasks = loadMaintenance(user.tenantId);
      const d = loadTenantData(user.tenantId);

      for (const task of tasks) {
        if (!task.nextDue || !task.alertTo || task.alertTo.length === 0) continue;

        const due = new Date(task.nextDue);
        due.setHours(0,0,0,0);
        const daysUntil = Math.ceil((due - today) / (1000*60*60*24));

        // שלח התראה אם הגיע יום ההתראה ועוד לא נשלחה היום
        if (daysUntil <= task.alertDaysBefore && daysUntil >= 0) {
          const lastAlertDate = task.lastAlertSent ? new Date(task.lastAlertSent).toDateString() : null;
          if (lastAlertDate === today.toDateString()) continue; // כבר נשלח היום

          const msg = `🔧 תזכורת תחזוקה — VaadPro\n\n${task.icon || '🔧'} *${task.name}*\nתאריך יעד: ${task.nextDue}\nנותרו: ${daysUntil} ימים\n\n${task.notes ? 'הערות: ' + task.notes : ''}`.trim();

          for (const recipient of task.alertTo) {
            let phone = null, email = null;
            if (typeof recipient !== 'object') {
              const tenant = (d.tenants || []).find(t => String(t.id) === String(recipient));
              if (tenant) { phone = tenant.phone; email = tenant.email; }
            } else { phone = recipient.phone; email = recipient.email; }

            if ((task.alertMethod || []).includes('whatsapp') && phone) {
              try { await sendWaMsg(user.tenantId, phone, msg); alertsSent++; } catch(e) {}
            }
            if ((task.alertMethod || []).includes('email') && email) {
              try { await sendEmailResend(email, `תזכורת תחזוקה: ${task.name}`, msg.replace(/\n/g, '<br>')); alertsSent++; } catch(e) {}
            }
          }
          task.lastAlertSent = new Date().toISOString();
        }
      }
      saveMaintenance(user.tenantId, tasks);
    } catch(e) { console.error(`[MaintenanceCron:${user.tenantId}]`, e.message); }
  }
  if (alertsSent > 0) console.log(`[MaintenanceCron] נשלחו ${alertsSent} התראות תחזוקה`);
}

// ── Auto-send cron — runs every minute, checks each tenant's schedule ──
async function runAutoSendCron() {
  const now = new Date();
  const currentDay  = now.getDate();
  const currentHour = now.getHours();
  const currentMin  = now.getMinutes();
  const users = loadUsers();

  for (const user of users) {
    if (!user.tenantId) continue;
    if (user.plan === 'suspended') continue;

    try {
      const d = loadTenantData(user.tenantId);
      const config = d.config || {};
      const sendDay    = parseInt(config.sendDay)    || 1;
      const sendHour   = parseInt(config.sendHour)   || 9;
      const sendMinute = parseInt(config.sendMinute) || 0;

      // Check if now matches the configured day + hour + minute (within same minute)
      if (currentDay !== sendDay)   continue;
      if (currentHour !== sendHour) continue;
      if (currentMin  !== sendMinute) continue;

      // Check if there are any unpaid tenants who haven't been reminded yet this month
      const month  = getEffectiveMonth(config);
      const mk     = getMonthKey(config);
      const hasUnsentUnpaid = (d.tenants || []).some(t => !d.sentLog[t.id + '_' + month]);
      if (!hasUnsentUnpaid) {
        console.log(`[AutoSend] ${user.email} — all tenants already paid or reminded for ${month}, skipping`);
        continue;
      }

      // Send only to unpaid tenants
      const globalAmount = config.amount || 300;
      const tmpl = config.template || 'שלום {שם}!\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה!';
      let sent = 0;

      for (const tenant of (d.tenants || [])) {
        const key = tenant.id + '_' + month;
        if (d.sentLog[key]) continue; // already paid or reminded — skip
        const amount = tenant.customAmount || globalAmount;
        const msg = tmpl.replace(/{שם}/g, tenant.name).replace(/{חודש}/g, month).replace(/{סכום}/g, amount);
        try {
          await sendWaMsg(user.tenantId, tenant.phone, msg);
          d.sentLog[key] = 'sent_' + new Date().toISOString();
          recordPayment(d, String(tenant.id), mk, 'wa_sent', amount, tenant.name);
          sent++;
          await new Promise(r => setTimeout(r, 1200));
        } catch(e) {
          console.error(`[AutoSend] ${user.email} → ${tenant.name}: ${e.message}`);
        }
      }

      if (sent > 0) {
        saveTenantData(user.tenantId, { sentLog: d.sentLog, paymentHistory: d.paymentHistory });
        console.log(`[AutoSend] ✅ ${user.email} — sent to ${sent} unpaid tenants for ${month}`);
      } else {
        console.log(`[AutoSend] ${user.email} — no unpaid tenants for ${month}`);
      }
    } catch(e) {
      console.error(`[AutoSend] error for ${user.email}:`, e.message);
    }
  }
}

// הרץ cron כל יום ב-08:00 (maintenance) + כל דקה (auto-send scheduler)
function scheduleDailyCron() {
  const now  = new Date();
  const next = new Date();
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    runMaintenanceCron();
    setInterval(runMaintenanceCron, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`[MaintenanceCron] יופעל ב-${next.toLocaleTimeString('he-IL')}`);
}
scheduleDailyCron();

// Auto-send: check every minute
setInterval(runAutoSendCron, 60 * 1000);
// Also run once at startup (after 10s) to catch any missed sends
setTimeout(runAutoSendCron, 10 * 1000);
console.log('[AutoSend] scheduler active — checking every minute');


// ── שכחתי סיסמה ─────────────────────────────────────────────────
const resetTokens = {}; // token → { email, expires }

app.post('/api/auth/forgot', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ ok: false, error: 'יש להזין אימייל' });
  const users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  // Always return ok to prevent email enumeration
  if (!user) return res.json({ ok: true });

  const token   = uuidv4();
  const expires = Date.now() + 60 * 60 * 1000; // 1 hour
  resetTokens[token] = { email: email.toLowerCase(), expires };

  const appUrl  = process.env.APP_URL || 'https://vaadpro.org';
  const resetUrl = `${appUrl}/reset-password.html?token=${token}`;

  try {
    await sendEmailResend(email, 'איפוס סיסמה — VaadPro', `שלום,

קיבלנו בקשה לאיפוס הסיסמה שלך ב-VaadPro.

לחץ על הלינק הבא לאיפוס הסיסמה:
${resetUrl}

הלינק תקף לשעה אחת.

אם לא ביקשת איפוס סיסמה — התעלם ממייל זה.

צוות VaadPro`);
    console.log(`[Reset] sent to ${email}`);
  } catch(e) {
    console.error('[Reset] email failed:', e.message);
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.json({ ok: false, error: 'פרמטרים חסרים' });
  if (password.length < 6) return res.json({ ok: false, error: 'סיסמה חייבת להכיל לפחות 6 תווים' });

  const entry = resetTokens[token];
  if (!entry) return res.json({ ok: false, error: 'הלינק אינו תקין' });
  if (Date.now() > entry.expires) {
    delete resetTokens[token];
    return res.json({ ok: false, error: 'הלינק פג תוקף — בקש לינק חדש' });
  }

  const users = loadUsers();
  const user  = users.find(u => u.email === entry.email);
  if (!user) return res.json({ ok: false, error: 'משתמש לא נמצא' });

  user.passHash = await bcrypt.hash(password, 10);
  saveUsers(users);
  delete resetTokens[token];
  console.log(`[Reset] password reset for ${entry.email}`);
  res.json({ ok: true });
});

// ── Admin: איפוס סיסמה ידני ──────────────────────────────────────
app.post('/api/admin/reset-password', superAdminMiddleware, async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.json({ ok: false, error: 'פרמטרים חסרים' });
  if (newPassword.length < 6) return res.json({ ok: false, error: 'סיסמה חייבת להכיל לפחות 6 תווים' });
  const users = loadUsers();
  const user  = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'משתמש לא נמצא' });
  user.passHash = await bcrypt.hash(newPassword, 10);
  saveUsers(users);
  res.json({ ok: true });
});


// ── Bridge heartbeat timeout ─────────────────────────────────────
// אם ה-Bridge לא שלח heartbeat תוך 3 דקות → סמן כמנותק
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 3 * 60 * 1000; // 3 minutes
  for (const [tid, wa] of Object.entries(waClients)) {
    if (wa.status === 'ready' && wa.lastSeen && (now - wa.lastSeen) > TIMEOUT) {
      console.log(`[Bridge:${tid}] heartbeat timeout — marking disconnected`);
      wa.status = 'disconnected';
    }
  }
}, 60 * 1000); // check every minute


// ── Installer Token System ───────────────────────────────────────
const installTokens = {}; // token → { tenantId, expires }

// Generate install token (called from app - requires auth)
app.post('/api/installer/token', authMiddleware, (req, res) => {
  const token = Math.random().toString(36).substring(2, 8).toUpperCase(); // 6-char code e.g. "X7K2M9"
  installTokens[token] = {
    tenantId: req.user.tenantId,
    expires:  Date.now() + 30 * 60 * 1000 // 30 minutes
  };
  console.log(`[Installer] token generated for ${req.user.tenantId}: ${token}`);
  res.json({ ok: true, token });
});

// Redeem install token → return config.json (public, no auth)
app.post('/api/installer/redeem', (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ ok: false, error: 'Missing token' });
  const entry = installTokens[token.toUpperCase()];
  if (!entry) return res.json({ ok: false, error: 'Invalid code' });
  if (Date.now() > entry.expires) {
    delete installTokens[token.toUpperCase()];
    return res.json({ ok: false, error: 'Code expired — generate a new one' });
  }
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';
  const config = {
    cloudUrl:     appUrl,
    bridgeSecret: BRIDGE_SECRET,
    tenantId:     entry.tenantId
  };
  delete installTokens[token.toUpperCase()]; // one-time use
  console.log(`[Installer] token redeemed for ${entry.tenantId}`);
  res.json({ ok: true, config });
});

// Serve VaadPro-Setup.bat (public)
app.get('/vaadpro-setup.bat', (req, res) => {
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';
  const bat = generateSetupBat(appUrl);
  res.setHeader('Content-Disposition', 'attachment; filename="VaadPro-Setup.bat"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(bat);
});

function generateSetupPs1(appUrl) {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$appUrl = '` + appUrl + `'
$logFile = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), 'VaadPro-Setup-Log.txt')
function Log($msg) { Add-Content -Path $logFile -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $msg) }
'VaadPro Setup Log - ' + (Get-Date) | Out-File $logFile

$form = New-Object System.Windows.Forms.Form
$form.Text = 'VaadPro Setup'
$form.Size = New-Object System.Drawing.Size(440, 260)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.TopMost = $true

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'Enter your installation code from VaadPro Settings:'
$lbl.Location = New-Object System.Drawing.Point(20, 20)
$lbl.Size = New-Object System.Drawing.Size(400, 30)
$form.Controls.Add($lbl)

$lbl2 = New-Object System.Windows.Forms.Label
$lbl2.Text = 'Settings page -> Get Installation Code'
$lbl2.Location = New-Object System.Drawing.Point(20, 48)
$lbl2.Size = New-Object System.Drawing.Size(400, 20)
$lbl2.ForeColor = [System.Drawing.Color]::Gray
$form.Controls.Add($lbl2)

$txt = New-Object System.Windows.Forms.TextBox
$txt.Location = New-Object System.Drawing.Point(20, 80)
$txt.Size = New-Object System.Drawing.Size(220, 28)
$txt.Font = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Bold)
$txt.CharacterCasing = 'Upper'
$txt.MaxLength = 6
$form.Controls.Add($txt)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'Install'
$btn.Location = New-Object System.Drawing.Point(250, 78)
$btn.Size = New-Object System.Drawing.Size(90, 32)
$btn.BackColor = [System.Drawing.Color]::FromArgb(37, 211, 102)
$btn.FlatStyle = 'Flat'
$form.AcceptButton = $btn
$form.Controls.Add($btn)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(20, 125)
$status.Size = New-Object System.Drawing.Size(400, 90)
$status.Text = ''
$status.Font = New-Object System.Drawing.Font('Arial', 9)
$form.Controls.Add($status)

$btn.Add_Click({
  $code = $txt.Text.Trim().ToUpper()
  if ($code.Length -lt 4) { $status.Text = 'Please enter your 6-digit code'; return }
  $btn.Enabled = $false
  $status.ForeColor = [System.Drawing.Color]::Black
  try {
    Log 'Starting installation...'
    $status.Text = 'Step 1/5: Connecting to VaadPro...'; $form.Refresh()
    $body = '{"token":"' + $code + '"}'
    $resp = Invoke-RestMethod -Uri ($appUrl + '/api/installer/redeem') -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing
    if (-not $resp.ok) { $status.ForeColor = [System.Drawing.Color]::Red; $status.Text = 'Error: ' + $resp.error; $btn.Enabled = $true; Log ('Error: ' + $resp.error); return }
    Log 'Step 1: Connected OK'

    $installDir = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('MyDocuments'), 'VaadPro-Bridge')
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null

    $status.Text = 'Step 2/5: Saving configuration...'; $form.Refresh()
    $resp.config | ConvertTo-Json -Depth 5 | Set-Content -Path ([System.IO.Path]::Combine($installDir, 'config.json')) -Encoding UTF8 -NoNewline:$false; [System.IO.File]::WriteAllText([System.IO.Path]::Combine($installDir, 'config.json'), ($resp.config | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
    Log 'Step 2: Config saved'

    $status.Text = 'Step 3/5: Downloading Bridge files...'; $form.Refresh()
    $zipPath = [System.IO.Path]::Combine($installDir, 'VaadPro-Bridge.zip')
    Invoke-WebRequest -Uri ($appUrl + '/api/bridge/download-files') -OutFile $zipPath -UseBasicParsing
    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
    Remove-Item $zipPath -Force
    Log 'Step 3: Bridge downloaded'

    $batPath = [System.IO.Path]::Combine($installDir, 'VaadPro-Start.bat')
    $status.Text = 'Step 4/5: Checking Node.js...'; $form.Refresh()
    $nodePath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('ProgramFiles'), 'nodejs', 'node.exe')
    if (-not (Test-Path $nodePath)) {
      $status.Text = 'Step 4/5: Installing Node.js (2-3 min)...'; $form.Refresh()
      Log 'Step 4: Installing Node.js...'
      $msiPath = [System.IO.Path]::Combine($env:TEMP, 'node_setup.msi')
      Invoke-WebRequest 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile $msiPath -UseBasicParsing
      Start-Process msiexec.exe -ArgumentList ('/i "' + $msiPath + '" /quiet /norestart') -Wait -Verb RunAs
      Remove-Item $msiPath -Force
      # Add shortcut to Windows Startup with correct WorkingDirectory
      $startupDir = [System.Environment]::GetFolderPath('Startup')
      $startupShortcut = [System.IO.Path]::Combine($startupDir, 'VaadPro Bridge.lnk')
      $ws2 = New-Object -ComObject WScript.Shell
      $s2 = $ws2.CreateShortcut($startupShortcut)
      $s2.TargetPath = $batPath
      $s2.WorkingDirectory = $installDir
      $s2.Description = 'VaadPro Bridge'
      $s2.Save()
      Log 'Step 4: Node.js installed - restart required'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(0, 100, 200)
      $status.Text = 'Node.js installed successfully!' + [char]13 + [char]10 + [char]13 + [char]10 + 'IMPORTANT: Please restart your computer.' + [char]13 + [char]10 + 'VaadPro Bridge will start automatically after restart.'
      $form.Refresh()
      [System.Windows.Forms.MessageBox]::Show('Node.js has been installed.' + [char]13 + [char]10 + [char]13 + [char]10 + 'Please restart your computer now.' + [char]13 + [char]10 + 'VaadPro Bridge will start automatically after restart.', 'Restart Required', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
      $form.Close()
      return
    }
    $env:PATH = $env:PATH + ';' + [System.IO.Path]::Combine([System.Environment]::GetFolderPath('ProgramFiles'), 'nodejs')
    Log 'Step 4: Node.js OK'

    $status.Text = 'Step 5/5: Installing Bridge dependencies...'; $form.Refresh()
    Log 'Downloading pre-built node_modules...'
    $nmZipPath = [System.IO.Path]::Combine($installDir, 'node_modules.zip')
    try {
      Invoke-WebRequest -Uri ($appUrl + '/api/bridge/node-modules') -OutFile $nmZipPath -UseBasicParsing
      if (Test-Path -LiteralPath $nmZipPath) {
        Expand-Archive -Path $nmZipPath -DestinationPath $installDir -Force
        Remove-Item $nmZipPath -Force
        Log 'node_modules downloaded and extracted OK'
      } else {
        Log 'node_modules zip not found - falling back to npm install'
        throw 'Download failed'
      }
    } catch {
      Log ('node_modules download failed: ' + $_.Exception.Message + ' - trying npm install')
      $pf = [System.Environment]::GetFolderPath('ProgramFiles')
      $npmCmd2 = [System.IO.Path]::Combine($pf, 'nodejs', 'npm.cmd')
      if (Test-Path -LiteralPath $npmCmd2) {
        $proc = Start-Process $npmCmd2 -ArgumentList 'install' -WorkingDirectory $installDir -Wait -WindowStyle Hidden -PassThru
        Log ('npm exit code: ' + $proc.ExitCode)
      } else {
        Log 'ERROR: npm not found - please run npm install manually in VaadPro-Bridge folder'
      }
    }
    Log 'Step 5: npm install done'

    $batPath = [System.IO.Path]::Combine($installDir, 'VaadPro-Start.bat')
    $shortcutPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), 'VaadPro Bridge.lnk')
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($shortcutPath)
    $s.TargetPath = $batPath
    $s.WorkingDirectory = $installDir
    $s.Description = 'VaadPro Bridge'
    $s.Save()
    Log 'Shortcut created'

    $status.ForeColor = [System.Drawing.Color]::FromArgb(0, 150, 50)
    $status.Text = 'Installation complete! Starting VaadPro Bridge...'
    $form.Refresh()
    Log 'Installation complete!'
    Start-Sleep -Seconds 2
    $form.Close()
    # Open new CMD with refreshed PATH so Node.js is found
    Start-Process 'cmd' -ArgumentList ('/c "' + $batPath + '"')
  } catch {
    $errMsg = $_.Exception.Message
    $errLine = $_.InvocationInfo.ScriptLineNumber
    $errScript = $_.InvocationInfo.Line.Trim()
    Log ('ERROR: ' + $errMsg)
    Log ('  at line ' + $errLine + ': ' + $errScript)
    Log ('  StackTrace: ' + $_.ScriptStackTrace)
    $status.ForeColor = [System.Drawing.Color]::Red
    $status.Text = 'Error: ' + $errMsg + [char]13 + [char]10 + 'Check VaadPro-Setup-Log.txt on Desktop'
    $btn.Enabled = $true
  }
})

$form.ShowDialog() | Out-Null
`;
}

function generateSetupBat(appUrl) {
  return `@echo off
title VaadPro Setup
echo.
echo  ========================================
echo   VaadPro Setup
echo  ========================================
echo.

:: Download and run PS1 from server
set PS1=%TEMP%\\vaadpro_setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '` + appUrl + `/vaadpro-setup.ps1' -OutFile '%PS1%' -UseBasicParsing"
if not exist "%PS1%" (
    echo  ERROR: Could not download setup script.
    echo  Please check your internet connection.
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
del "%PS1%" 2>nul
`;
}


// Serve Mac setup script (public)
app.get('/vaadpro-setup.sh', (req, res) => {
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';
  const sh = `#!/bin/bash
LOG="$HOME/Desktop/VaadPro-Setup-Log.txt"
echo "VaadPro Setup Log - $(date)" > "$LOG"
INSTALL_DIR="$HOME/Documents/VaadPro-Bridge"

echo ""
echo " ========================================"
echo "   VaadPro Setup for Mac"
echo " ========================================"
echo ""

# Get install code
echo -n "Enter your installation code from VaadPro Settings: "
read CODE
CODE=$(echo "$CODE" | tr '[:lower:]' '[:upper:]')

echo "$(date +%H:%M:%S) Connecting to VaadPro..." >> "$LOG"
echo "Step 1/5: Connecting to VaadPro..."

# Redeem token
RESP=$(curl -s -X POST "${appUrl}/api/installer/redeem" \\
  -H "Content-Type: application/json" \\
  -d "{\"token\":\"$CODE\"}")

OK=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok','false'))" 2>/dev/null)
if [ "$OK" != "True" ] && [ "$OK" != "true" ]; then
  ERR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error','Unknown error'))" 2>/dev/null)
  echo ""
  echo " ERROR: $ERR"
  echo "$(date +%H:%M:%S) ERROR: $ERR" >> "$LOG"
  exit 1
fi

echo "$(date +%H:%M:%S) Step 1: Connected OK" >> "$LOG"
echo "Step 1/5: Connected OK"

# Save config
mkdir -p "$INSTALL_DIR"
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['config'], indent=2))" > "$INSTALL_DIR/config.json"
echo "$(date +%H:%M:%S) Step 2: Config saved" >> "$LOG"
echo "Step 2/5: Config saved"

# Download bridge files
echo "Step 3/5: Downloading Bridge files..."
curl -s "${appUrl}/api/bridge/download-files" -o "$INSTALL_DIR/bridge.zip"
if [ ! -f "$INSTALL_DIR/bridge.zip" ]; then
  echo " ERROR: Failed to download Bridge files."
  echo "$(date +%H:%M:%S) ERROR: bridge.zip download failed" >> "$LOG"
  exit 1
fi
cd "$INSTALL_DIR" && unzip -o bridge.zip && rm bridge.zip
echo "$(date +%H:%M:%S) Step 3: Bridge downloaded" >> "$LOG"
echo "Step 3/5: Bridge files downloaded"

# Check / install Node.js
echo "Step 4/5: Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo " Node.js not found. Installing... (this may take 2-3 minutes)"
  echo "$(date +%H:%M:%S) Step 4: Installing Node.js..." >> "$LOG"
  if command -v brew &>/dev/null; then
    brew install node
  else
    curl -s "https://nodejs.org/dist/v20.11.1/node-v20.11.1.pkg" -o /tmp/node.pkg
    sudo installer -pkg /tmp/node.pkg -target /
    rm /tmp/node.pkg
  fi
  # Reload PATH so node/npm are available immediately
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
fi
if ! command -v node &>/dev/null; then
  echo " ERROR: Node.js installation failed."
  echo " Please install manually from https://nodejs.org and run this script again."
  echo "$(date +%H:%M:%S) ERROR: Node.js not found after install" >> "$LOG"
  exit 1
fi
echo "$(date +%H:%M:%S) Step 4: Node.js OK ($(node -v))" >> "$LOG"
echo "Step 4/5: Node.js OK ($(node -v))"

# Install dependencies
echo "Step 5/5: Installing Bridge dependencies..."
echo " This may take 2-3 minutes. Please wait."
echo "$(date +%H:%M:%S) Running npm install..." >> "$LOG"
cd "$INSTALL_DIR"

# Try downloading pre-built node_modules first (faster)
NM_ZIP="$INSTALL_DIR/node_modules.zip"
curl -s --fail "${appUrl}/api/bridge/node-modules" -o "$NM_ZIP" 2>/dev/null
if [ -f "$NM_ZIP" ] && [ -s "$NM_ZIP" ]; then
  echo " Extracting pre-built dependencies..."
  unzip -o "$NM_ZIP" -d "$INSTALL_DIR" >> "$LOG" 2>&1 && rm "$NM_ZIP"
  echo "$(date +%H:%M:%S) node_modules extracted from zip" >> "$LOG"
else
  rm -f "$NM_ZIP"
  echo " Running npm install..."
  npm install 2>&1 | tee -a "$LOG"
fi

# Verify node_modules
if [ ! -d "$INSTALL_DIR/node_modules" ]; then
  echo ""
  echo " ERROR: node_modules missing after install!"
  echo " Please open Terminal and run:"
  echo "   cd \"$INSTALL_DIR\" && npm install"
  echo "$(date +%H:%M:%S) ERROR: node_modules missing" >> "$LOG"
  exit 1
fi
echo "$(date +%H:%M:%S) Step 5: dependencies installed OK" >> "$LOG"
echo "Step 5/5: Dependencies installed"

# Create Desktop shortcut
SHORTCUT="$HOME/Desktop/VaadPro Bridge.command"
echo "#!/bin/bash" > "$SHORTCUT"
echo "cd \"$INSTALL_DIR\" && ./VaadPro-Start.sh" >> "$SHORTCUT"
chmod +x "$SHORTCUT"
echo "$(date +%H:%M:%S) Shortcut created" >> "$LOG"

echo ""
echo " ========================================"
echo "   Installation complete!"
echo "   Starting VaadPro Bridge..."
echo " ========================================"
echo ""
echo "$(date +%H:%M:%S) Installation complete!" >> "$LOG"

# Start bridge
"$INSTALL_DIR/VaadPro-Start.sh"
`;
  res.setHeader('Content-Disposition', 'attachment; filename="VaadPro-Setup.sh"');
  res.setHeader('Content-Type', 'application/x-sh');
  res.send(sh);
});

// Serve setup PS1 (public)
app.get('/vaadpro-setup.ps1', (req, res) => {
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';
  res.setHeader('Content-Type', 'text/plain');
  res.send(generateSetupPs1(appUrl));
});

// Serve bridge files without config (for installer)
// Auto-download node_modules on first start
const MODULES_ZIP_URL = 'https://github.com/Tal150561/VaadPro/releases/download/v1.0-modules/node_modules.zip';
const MODULES_ZIP_PATH = path.join(DATA_DIR, 'bridge-node-modules.zip');

async function ensureNodeModulesZip() {
  if (fs.existsSync(MODULES_ZIP_PATH)) {
    console.log('[modules] bridge-node-modules.zip already exists');
    return;
  }
  console.log('[modules] Downloading bridge-node-modules.zip from GitHub...');
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(MODULES_ZIP_PATH);
      const follow = (url) => {
        const lib = url.startsWith('https') ? require('https') : require('http');
        lib.get(url, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return follow(res.headers.location);
          }
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (e) => { fs.unlink(MODULES_ZIP_PATH, () => {}); reject(e); });
      };
      follow(MODULES_ZIP_URL);
    });
    console.log('[modules] Downloaded successfully');
  } catch(e) {
    console.error('[modules] Download failed:', e.message);
  }
}
ensureNodeModulesZip();

// Admin endpoint to re-download manually
app.get('/api/admin/init-modules', async (req, res) => {
  if (req.query.secret !== process.env.BRIDGE_SECRET) return res.status(403).json({ error: 'forbidden' });
  if (fs.existsSync(MODULES_ZIP_PATH)) fs.unlinkSync(MODULES_ZIP_PATH);
  await ensureNodeModulesZip();
  res.json({ ok: fs.existsSync(MODULES_ZIP_PATH), path: MODULES_ZIP_PATH });
});

// Serve pre-built node_modules (uploaded to DATA_DIR)
app.get('/api/bridge/node-modules', (req, res) => {
  const nmZip = path.join(DATA_DIR, 'bridge-node-modules.zip');
  if (!fs.existsSync(nmZip)) {
    return res.status(404).json({ error: 'node_modules not available' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="node_modules.zip"');
  fs.createReadStream(nmZip).pipe(res);
});

app.get('/api/bridge/download-files', (req, res) => {
  const FILES = {
    'bridge.js':         BRIDGE_JS_CONTENT,
    'package.json':      BRIDGE_PKG_CONTENT,
    'VaadPro-Start.bat': VAADPRO_START_BAT,
    'VaadPro-Start.sh':  VAADPRO_START_SH,
  };
  const buildZipSimple = (files) => {
    const parts = [], centralDir = [];
    let offset = 0;
    const crc32 = (buf) => {
      let crc = 0xFFFFFFFF;
      const table = [];
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
      }
      for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    };
    for (const [name, content] of Object.entries(files)) {
      const nameBuf = Buffer.from(name, 'utf8');
      const dataBuf = Buffer.from(content, 'utf8');
      const crc = crc32(dataBuf);
      const now = new Date();
      const dosDate = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
      const dosTime = (now.getHours()<<11)|(now.getMinutes()<<5)|(Math.floor(now.getSeconds()/2));
      const lh = Buffer.alloc(30 + nameBuf.length);
      lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
      lh.writeUInt16LE(0,8); lh.writeUInt16LE(dosTime,10); lh.writeUInt16LE(dosDate,12);
      lh.writeUInt32LE(crc,14); lh.writeUInt32LE(dataBuf.length,18); lh.writeUInt32LE(dataBuf.length,22);
      lh.writeUInt16LE(nameBuf.length,26); lh.writeUInt16LE(0,28); nameBuf.copy(lh,30);
      parts.push(lh, dataBuf);
      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6);
      cd.writeUInt16LE(0,8); cd.writeUInt16LE(0,10); cd.writeUInt16LE(dosTime,12);
      cd.writeUInt16LE(dosDate,14); cd.writeUInt32LE(crc,16); cd.writeUInt32LE(dataBuf.length,20);
      cd.writeUInt32LE(dataBuf.length,24); cd.writeUInt16LE(nameBuf.length,28);
      cd.writeUInt16LE(0,30); cd.writeUInt16LE(0,32); cd.writeUInt16LE(0,34);
      cd.writeUInt16LE(0,36); cd.writeUInt32LE(0,38); cd.writeUInt32LE(offset,42);
      nameBuf.copy(cd,46);
      centralDir.push(cd);
      offset += lh.length + dataBuf.length;
    }
    const cdBuf = Buffer.concat(centralDir);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
    eocd.writeUInt16LE(centralDir.length,8); eocd.writeUInt16LE(centralDir.length,10);
    eocd.writeUInt32LE(cdBuf.length,12); eocd.writeUInt32LE(offset,16); eocd.writeUInt16LE(0,20);
    return Buffer.concat([...parts, cdBuf, eocd]);
  };
  const zipBuf = buildZipSimple(FILES);
  res.setHeader('Content-Type', 'application/zip');
  res.send(zipBuf);
});

// ── Tenant Portal ────────────────────────────────────────────────
const PORTAL_TOKENS_FILE = path.join(DATA_DIR, '_portal_tokens.json');

function loadPortalTokens() {
  if (!fs.existsSync(PORTAL_TOKENS_FILE)) return {};
  try {
    const raw = fs.readFileSync(PORTAL_TOKENS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[Portal] _portal_tokens.json has unexpected format — returning empty');
      return {};
    }
    return parsed;
  } catch(e) {
    console.error('[Portal] Failed to parse _portal_tokens.json:', e.message);
    // Try backup file before giving up
    const backup = PORTAL_TOKENS_FILE + '.bak';
    if (fs.existsSync(backup)) {
      try {
        const raw2 = fs.readFileSync(backup, 'utf8');
        const parsed2 = JSON.parse(raw2);
        console.log('[Portal] Recovered tokens from backup file');
        return parsed2;
      } catch(e2) { /* backup also bad */ }
    }
    return {};
  }
}

function savePortalTokens(tokens) {
  const tmp = PORTAL_TOKENS_FILE + '.tmp';
  const backup = PORTAL_TOKENS_FILE + '.bak';
  const data = JSON.stringify(tokens, null, 2);
  // Atomic write: write to .tmp, backup existing, rename
  fs.writeFileSync(tmp, data);
  if (fs.existsSync(PORTAL_TOKENS_FILE)) {
    try { fs.copyFileSync(PORTAL_TOKENS_FILE, backup); } catch(e) { /* non-fatal */ }
  }
  fs.renameSync(tmp, PORTAL_TOKENS_FILE);
}

// Generate portal token for a specific tenant (called from app)
app.post('/api/portal/token', authMiddleware, (req, res) => {
  const { tenantId, forceNew } = req.body;
  if (!tenantId) return res.json({ ok: false, error: 'Missing tenantId' });
  const d = loadTenantData(req.user.tenantId);
  const tenant = d.tenants.find(t => String(t.id) === String(tenantId));
  if (!tenant) return res.json({ ok: false, error: 'Tenant not found' });

  const tokens = loadPortalTokens();
  const now = Date.now();
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';

  // Clean expired tokens
  Object.keys(tokens).forEach(k => { if (tokens[k].expires < now) delete tokens[k]; });

  if (forceNew) {
    // Delete all existing tokens for this tenant before creating a new one
    Object.keys(tokens).forEach(k => {
      if (tokens[k].tenantDataId === req.user.tenantId && tokens[k].tenantId === String(tenantId)) {
        delete tokens[k];
      }
    });
    console.log('[Portal] forceNew — deleted old tokens for tenant', tenantId);
  } else {
    // Reuse existing valid token if present
    const existingEntry = Object.entries(tokens).find(([, v]) =>
      v.tenantDataId === req.user.tenantId &&
      v.tenantId === String(tenantId) &&
      v.expires > now
    );
    if (existingEntry) {
      console.log('[Portal] reusing existing token for tenant', tenantId);
      return res.json({ ok: true, token: existingEntry[0], url: appUrl + '/tenant-portal.html?token=' + existingEntry[0] });
    }
  }

  console.log('[Portal] creating new token for tenant', tenantId, '- file has', Object.keys(tokens).length, 'tokens');
  const token = require('uuid').v4().replace(/-/g,'').substring(0,20);
  tokens[token] = {
    tenantDataId: req.user.tenantId,
    tenantId:     String(tenantId),
    createdAt:    now,
    expires:      now + 365 * 24 * 60 * 60 * 1000 // 1 year
  };
  savePortalTokens(tokens);
  const url = appUrl + '/tenant-portal.html?token=' + token;
  res.json({ ok: true, token, url });
});

// Reset portal tokens for this account (force new token generation)
app.delete('/api/portal/tokens', authMiddleware, (req, res) => {
  const tokens = loadPortalTokens();
  let removed = 0;
  Object.keys(tokens).forEach(k => {
    if (tokens[k].tenantDataId === req.user.tenantId) {
      delete tokens[k];
      removed++;
    }
  });
  savePortalTokens(tokens);
  console.log('[Portal] Reset', removed, 'tokens for', req.user.tenantId);
  res.json({ ok: true, removed });
});

// Debug endpoint — check token status without exposing tenant data (admin-only via ADMIN_JWT_SECRET)
// ── IMPORTANT: All specific /api/portal/* routes must be declared BEFORE
//    the wildcard GET /api/portal/:token, otherwise Express will match
//    e.g. "tickets" as the :token param and return "לינק לא תקין".

app.get('/api/portal/debug/:token', (req, res) => {
  const adminToken = (req.headers['x-admin-token'] || '').replace('Bearer ', '');
  let isAdmin = false;
  try { jwt.verify(adminToken, ADMIN_JWT_SECRET); isAdmin = true; } catch(e) {}
  const tokens = loadPortalTokens();
  const entry = tokens[req.params.token];
  if (!entry) return res.json({ found: false, total: Object.keys(tokens).length });
  return res.json({
    found: true,
    expired: Date.now() > entry.expires,
    expiresAt: new Date(entry.expires).toISOString(),
    createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : 'unknown',
    tenantId: isAdmin ? entry.tenantId : '***',
    tenantDataId: isAdmin ? entry.tenantDataId : '***',
    total: Object.keys(tokens).length
  });
});

// POST /api/portal/ticket — tenant opens ticket via portal
app.post('/api/portal/ticket', (req, res) => {
  const { token, category, description, location, floor, entrance, priority } = req.body;
  if (!token || !category || !description) return res.json({ ok: false, error: 'חסרים פרטים' });
  const tokens = loadPortalTokens();
  const entry  = tokens[token];
  if (!entry || Date.now() > entry.expires) return res.status(401).json({ ok: false, error: 'לינק לא תקין' });
  const d      = loadTenantData(entry.tenantDataId);
  const tenant = d.tenants.find(t => String(t.id) === entry.tenantId);
  if (!tenant) return res.status(404).json({ ok: false, error: 'דייר לא נמצא' });
  const tickets = loadTickets(entry.tenantDataId);
  const ticket = {
    id:          nextTicketId(tickets),
    category,
    description,
    location:    location || 'כללי',
    floor:       floor || '',
    entrance:    entrance || '',
    priority:    priority || 'רגיל',
    status:      'פתוח',
    vendor:      '',
    cost:        null,
    tenantId:    entry.tenantId,
    tenantName:  tenant.name,
    tenantPhone: tenant.phone,
    openedByVaad: false,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    lastNote:    '',
    history:     [{ status: 'פתוח', note: '', ts: new Date().toISOString(), by: tenant.name }]
  };
  tickets.unshift(ticket);
  saveTickets(entry.tenantDataId, tickets);
  res.json({ ok: true, ticketId: ticket.id });
});

// GET /api/portal/tickets — tenant views own tickets via portal
app.get('/api/portal/tickets', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ ok: false, error: 'חסר token' });
  const tokens = loadPortalTokens();
  const entry  = tokens[token];
  if (!entry || Date.now() > entry.expires) return res.status(401).json({ ok: false, error: 'לינק לא תקין' });
  let tickets = loadTickets(entry.tenantDataId);
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
  tickets = tickets
    .filter(t => String(t.tenantId) === entry.tenantId && new Date(t.createdAt) > cutoff)
    .map(t => ({
      id: t.id, category: t.category, description: t.description,
      location: t.location, floor: t.floor, entrance: t.entrance,
      priority: t.priority, status: t.status, cost: t.cost,
      createdAt: t.createdAt, updatedAt: t.updatedAt, lastNote: t.lastNote
    }));
  res.json({ ok: true, tickets, categories: TICKET_CATEGORIES });
});

// PATCH /api/portal/ticket/:id/close — tenant closes own ticket
app.patch('/api/portal/ticket/:id/close', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(401).json({ ok: false });
  const tokens = loadPortalTokens();
  const entry  = tokens[token];
  if (!entry || Date.now() > entry.expires) return res.status(401).json({ ok: false });
  const tickets = loadTickets(entry.tenantDataId);
  const ticket  = tickets.find(t => t.id === req.params.id && String(t.tenantId) === entry.tenantId);
  if (!ticket) return res.status(404).json({ ok: false, error: 'טיקט לא נמצא' });
  ticket.status    = 'נסגר';
  ticket.lastNote  = req.body.note || 'נסגר על ידי הדייר';
  ticket.updatedAt = new Date().toISOString();
  ticket.history.push({ status: 'נסגר', note: ticket.lastNote, ts: new Date().toISOString(), by: entry.tenantId });
  saveTickets(entry.tenantDataId, tickets);
  res.json({ ok: true });
});

// Get portal data (public - token only)
app.get('/api/portal/:token', (req, res) => {
  const tokens = loadPortalTokens();
  const entry = tokens[req.params.token];
  if (!entry) return res.status(404).json({ ok: false, error: 'לינק לא תקין' });
  if (Date.now() > entry.expires) {
    delete tokens[req.params.token];
    savePortalTokens(tokens);
    return res.status(410).json({ ok: false, error: 'לינק פג תוקף' });
  }
    const d = loadTenantData(entry.tenantDataId);
  const tenant = d.tenants.find(t => String(t.id) === entry.tenantId);
  if (!tenant) return res.status(404).json({ ok: false, error: 'דייר לא נמצא' });

  const config = d.config || {};
  const globalAmount = config.amount || 300;
  const amount = tenant.customAmount || globalAmount;
  const currentMonthKey = getMonthKey(config);
  const currentMonthName = getEffectiveMonth(config);

  // Get payment history for this tenant (last 12 months)
  const history = ((d.paymentHistory || {})[entry.tenantId] || [])
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, 12);

  // Current month status from sentLog
  const sentKey = entry.tenantId + '_' + currentMonthName;
  const sentVal = (d.sentLog || {})[sentKey] || null;
  let currentStatus = 'unpaid';
  let currentType = null;
  if (sentVal) {
    if (String(sentVal).startsWith('manual_paid')) { currentStatus = 'paid'; currentType = 'manual'; }
    else if (String(sentVal).startsWith('bank_import')) { currentStatus = 'paid'; currentType = 'bank'; }
    else if (String(sentVal).startsWith('sent_')) { currentStatus = 'reminded'; currentType = 'wa_sent'; }
  }

  // Build Hebrew month label for display
  const MONTH_NAMES = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const monthLabel = (mk) => {
    const [y, m] = mk.split('-');
    return MONTH_NAMES[parseInt(m)-1] + ' ' + y;
  };

  const typeLabel = (t) => {
    if (t === 'bank') return 'ייבוא בנק';
    if (t === 'manual') return 'סומן ידנית';
    if (t === 'wa_sent') return 'נשלחה תזכורת';
    return '';
  };

  // Get payerName for current month from paymentHistory if available
  const currentRecord = ((d.paymentHistory || {})[entry.tenantId] || [])
    .find(r => r.month === currentMonthKey);
  const currentPayerName = currentRecord ? (currentRecord.payerName || '') : '';

  res.json({
    ok: true,
    tenant: { name: tenant.name },
    building: { name: d.config?.buildingName || '' },
    current: {
      monthKey:   currentMonthKey,
      monthLabel: currentMonthName,
      amount,
      status:     currentStatus,
      type:       currentType,
      typeLabel:  typeLabel(currentType),
      payerName:  currentPayerName
    },
    history: history.map(r => ({
      monthKey:   r.month,
      monthLabel: monthLabel(r.month),
      paid:       r.paid,
      amount:     r.amount,
      date:       r.date,
      type:       r.type,
      typeLabel:  typeLabel(r.type),
      name:       r.name,
      payerName:  r.payerName || ''
    }))
  });
});


// ── Tickets (תיעוד תקלות) ─────────────────────────────────────────

const TICKET_CATEGORIES = ['אינסטלטור','חשמל','מעלית','גנרטור','שערים/דלתות','ניקיון','נזילה','תאורה','אינטרנט/תקשורת','אחר'];
const TICKET_STATUSES   = ['פתוח','בטיפול','ממתין לחומרים','נקבע תור','נסגר','לא רלוונטי'];

function ticketsFile(tenantDataId) {
  return path.join(DATA_DIR, tenantDataId + '_tickets.json');
}
function loadTickets(tenantDataId) {
  const f = ticketsFile(tenantDataId);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return []; }
}
function saveTickets(tenantDataId, tickets) {
  fs.writeFileSync(ticketsFile(tenantDataId), JSON.stringify(tickets, null, 2));
}
function nextTicketId(tickets) {
  const year = new Date().getFullYear();
  const existing = tickets
    .map(t => { const m = String(t.id||'').match(/^(\d{4})-(\d+)$/); return m ? parseInt(m[2]) : 0; })
    .filter(n => tickets.find(t => String(t.id||'').startsWith(year+'-')));
  const nums = tickets
    .map(t => { const m = String(t.id||'').match(/^\d{4}-(\d+)$/); return m && String(t.id).startsWith(year+'-') ? parseInt(m[1]) : 0; });
  const max = nums.length ? Math.max(...nums) : 0;
  return year + '-' + String(max + 1).padStart(3, '0');
}

const STATUS_MESSAGES = {
  'פתוח':               (t) => `קיבלנו את הדיווח שלך על ${t.category}. מספר טיקט: #${t.id}.\nנעדכן אותך בהתקדמות 🙏`,
  'בטיפול':             (t) => `הטיקט #${t.id} (${t.category}) נמצא בטיפול.${t.lastNote?' '+t.lastNote:''}`,
  'ממתין לחומרים':      (t) => `הטיקט #${t.id} (${t.category}) ממתין לחומרים/ספק.${t.lastNote?' '+t.lastNote:''}`,
  'נקבע תור':           (t) => `נקבע תור לטיפול בטיקט #${t.id} (${t.category}).${t.lastNote?' '+t.lastNote:''}`,
  'נסגר':               (t) => `הטיקט #${t.id} (${t.category}) נסגר. ✅${t.lastNote?' '+t.lastNote:''}\nאם הבעיה חזרה — פתח טיקט חדש.`,
  'לא רלוונטי':         (t) => `הטיקט #${t.id} (${t.category}) סומן כלא רלוונטי.${t.lastNote?' '+t.lastNote:''}`
};

// GET /api/tickets — list all tickets (ועד)
app.get('/api/tickets', authMiddleware, (req, res) => {
  let tickets = loadTickets(req.user.tenantId);
  // Clean tickets older than 12 months
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
  tickets = tickets.filter(t => new Date(t.createdAt) > cutoff);
  res.json({ ok: true, tickets, categories: TICKET_CATEGORIES, statuses: TICKET_STATUSES });
});

// POST /api/tickets — open new ticket (ועד)
app.post('/api/tickets', authMiddleware, (req, res) => {
  const { category, description, location, floor, entrance, priority, vendor, openedByVaad, tenantId: reportingTenantId } = req.body;
  if (!category || !description) return res.json({ ok: false, error: 'חסרים פרטים' });
  const tickets = loadTickets(req.user.tenantId);
  const d = loadTenantData(req.user.tenantId);
  const tenant = reportingTenantId ? d.tenants.find(t => String(t.id) === String(reportingTenantId)) : null;
  const ticket = {
    id:          nextTicketId(tickets),
    category:    category,
    description: description,
    location:    location || 'כללי', // 'דירה' | 'כללי'
    floor:       floor || '',
    entrance:    entrance || '',
    priority:    priority || 'רגיל', // 'דחוף' | 'רגיל'
    status:      'פתוח',
    vendor:      vendor || '',
    cost:        null,
    tenantId:    reportingTenantId || null,
    tenantName:  tenant ? tenant.name : (openedByVaad ? 'ועד הבית' : ''),
    tenantPhone: tenant ? tenant.phone : '',
    openedByVaad: !!openedByVaad,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    lastNote:    '',
    history:     [{ status: 'פתוח', note: '', ts: new Date().toISOString(), by: 'ועד' }]
  };
  tickets.unshift(ticket);
  saveTickets(req.user.tenantId, tickets);
  // Send WA to tenant if has phone
  if (ticket.tenantPhone) {
    const msg = STATUS_MESSAGES['פתוח'](ticket);
    sendWaMsg(req.user.tenantId, ticket.tenantPhone, msg).catch(() => {});
  }
  res.json({ ok: true, ticket });
});

// PATCH /api/tickets/:id — update status/note/cost (ועד)
app.patch('/api/tickets/:id', authMiddleware, async (req, res) => {
  const tickets = loadTickets(req.user.tenantId);
  const ticket  = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ ok: false, error: 'טיקט לא נמצא' });
  const { status, note, cost, vendor, sendWa } = req.body;
  const oldStatus = ticket.status;
  if (status)  ticket.status   = status;
  if (note !== undefined) ticket.lastNote = note;
  if (cost  !== undefined) ticket.cost    = cost;
  if (vendor !== undefined) ticket.vendor = vendor;
  ticket.updatedAt = new Date().toISOString();
  ticket.history.push({ status: ticket.status, note: note || '', ts: new Date().toISOString(), by: 'ועד' });
  saveTickets(req.user.tenantId, tickets);
  // Send WA if requested or status changed
  if (ticket.tenantPhone && (sendWa || status !== oldStatus)) {
    const msgFn = STATUS_MESSAGES[ticket.status];
    if (msgFn) {
      try { await sendWaMsg(req.user.tenantId, ticket.tenantPhone, msgFn(ticket)); }
      catch(e) { console.error('[Tickets] WA send failed:', e.message); }
    }
  }
  res.json({ ok: true, ticket });
});

// DELETE /api/tickets/:id — delete ticket (ועד)
app.delete('/api/tickets/:id', authMiddleware, (req, res) => {
  let tickets = loadTickets(req.user.tenantId);
  tickets = tickets.filter(t => t.id !== req.params.id);
  saveTickets(req.user.tenantId, tickets);
  res.json({ ok: true });
});


// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   VaadPro v2.7.1 – SaaS Server         ║');
  console.log('║   http://localhost:' + PORT + '             ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('Mode:      ', WA_MODE === 'cloud' ? '☁️  Cloud (WA Bridge)' : '💻 Local (direct WA)');
  console.log('Admin URL:  /admin');
  console.log('');
  if (WA_MODE === 'local') {
    console.log('WhatsApp: local mode – WA will init on first login');
  } else {
    console.log('WhatsApp: cloud mode – waiting for WA Bridge connections');
    console.log('Bridge secret:', BRIDGE_SECRET);
  }
  console.log('');
});
