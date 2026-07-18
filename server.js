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
const multer = require('multer');
const XLSX   = require('xlsx');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode    = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── קבצי Bridge מוטמעים ─────────────────────────────────────────
const BRIDGE_JS_CONTENT = "/**\n * VaadPro Bridge \u2013 \u05d2\u05e8\u05e1\u05ea \u05dc\u05e7\u05d5\u05d7\n * \u05d0\u05dc \u05ea\u05e2\u05e8\u05d5\u05da \u05e7\u05d5\u05d1\u05e5 \u05d6\u05d4\n */\n\nconst { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');\nconst { Boom } = require('@hapi/boom');\nconst qrcode = require('qrcode');\nconst https  = require('https');\nconst http   = require('http');\nconst fs     = require('fs');\nconst path   = require('path');\n\n// \u2500\u2500 \u05e7\u05e8\u05d0 \u05d4\u05d2\u05d3\u05e8\u05d5\u05ea \u05de\u05e7\u05d5\u05d1\u05e5 config.json \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst CONFIG_FILE = path.join(__dirname, 'config.json');\nif (!fs.existsSync(CONFIG_FILE)) {\n  console.error('\u274c \u05e7\u05d5\u05d1\u05e5 config.json \u05dc\u05d0 \u05e0\u05de\u05e6\u05d0!');\n  console.error('   \u05e6\u05d5\u05e8 \u05e7\u05d5\u05d1\u05e5 config.json \u05e2\u05dd \u05d4\u05e4\u05e8\u05d8\u05d9\u05dd \u05e9\u05e7\u05d9\u05d1\u05dc\u05ea \u05d1-\u05d0\u05d9\u05de\u05d9\u05d9\u05dc.');\n  process.exit(1);\n}\nconst config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));\nconst { cloudUrl, bridgeSecret, tenantId } = config;\nif (!cloudUrl || !bridgeSecret || !tenantId) {\n  console.error('\u274c config.json \u05d7\u05e1\u05e8\u05d9\u05dd \u05e4\u05e8\u05d8\u05d9\u05dd. \u05d5\u05d3\u05d0 \u05e9\u05d9\u05e9 cloudUrl, bridgeSecret, tenantId.');\n  process.exit(1);\n}\n\n// Suppress internal crypto noise from Baileys\nconst _stderrWrite = process.stderr.write.bind(process.stderr);\nprocess.stderr.write = (chunk, ...args) => {\n  const m = chunk.toString();\n  if (m.includes('Bad MAC') || m.includes('Failed to decrypt') || m.includes('Session error')) return true;\n  return _stderrWrite(chunk, ...args);\n};\n\nconst AUTH_DIR      = './wa-auth';\nconst POLL_INTERVAL = 5000;\nconst HEALTH_INTERVAL = 60000;\n\n// \u2500\u2500 HTTP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction apiCall(method, urlPath, body) {\n  return new Promise((resolve, reject) => {\n    const url = new URL(cloudUrl + urlPath);\n    const isHttps = url.protocol === 'https:';\n    const lib  = isHttps ? https : http;\n    const data = body ? JSON.stringify(body) : null;\n    const opts = {\n      hostname: url.hostname,\n      port: url.port || (isHttps ? 443 : 80),\n      path: url.pathname + (url.search || ''),\n      method,\n      headers: {\n        'Content-Type': 'application/json',\n        'x-bridge-secret': bridgeSecret,\n        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})\n      },\n      timeout: 10000\n    };\n    const req = lib.request(opts, (res) => {\n      let raw = '';\n      res.on('data', d => raw += d);\n      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok: false }); } });\n    });\n    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });\n    req.on('error', reject);\n    if (data) req.write(data);\n    req.end();\n  });\n}\n\nasync function pushStatus(status, qrDataUrl, phone) {\n  try {\n    await apiCall('POST', '/api/bridge/status', { tenantId, status, qrDataUrl, phone });\n    if (status === 'ready') console.log(`\u2705 WhatsApp connected! (${phone})`);\n    else if (status === 'qr') console.log('\ud83d\udcf1 Waiting for QR scan in the app...');\n    else console.log(`\u2139\ufe0f  Status: ${status}`);\n  } catch(e) { /* \u05d1\u05e9\u05e7\u05d8 */ }\n}\n\n// \u2500\u2500 Polling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nlet isPolling = false, pollTimer = null, sock = null, waReady = false;\n\nfunction startPolling() {\n  if (pollTimer) return;\n  pollTimer = setInterval(pollAndSend, POLL_INTERVAL);\n}\n\nfunction stopPolling() {\n  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }\n}\n\nasync function pollAndSend() {\n  if (isPolling || !waReady || !sock) return;\n  isPolling = true;\n  try {\n    const res = await apiCall('GET', `/api/bridge/queue/${tenantId}`, null);\n    if (res.cmds && res.cmds.includes(\"reset-auth\")) {\n      console.log(\"🔄 reset-auth received — clearing WA session...\");\n      waReady = false; stopPolling();\n      if (sock) { try { await sock.logout(); } catch(e) {} }\n      fs.rmSync(AUTH_DIR, { recursive: true, force: true });\n      console.log(\"✅ wa-auth cleared — restarting...\");\n      setTimeout(initWA, 1000);\n      return;\n    }\n    if (!res.pending || !res.pending.length) return;\n    for (const msg of res.pending) {\n      let ok = false, error = '';\n      try {\n        const jid = msg.phone.replace(/\\D/g, '') + '@s.whatsapp.net';\n        await sock.sendMessage(jid, { text: msg.message });\n        ok = true;\n        console.log(`\ud83d\udce4 Message sent to ${msg.phone}`);\n      } catch(e) { error = e.message; console.error(`\u274c Send error:`, error); }\n      await apiCall('POST', '/api/bridge/ack', { tenantId, msgId: msg.msgId, ok, error });\n    }\n  } catch(e) { /* \u05d1\u05e9\u05e7\u05d8 */ }\n  finally { isPolling = false; }\n}\n\nsetInterval(async () => {\n  if (!waReady) return;\n  try { await pushStatus('ready', null, sock?.user?.id?.split(':')[0] || null); } catch(e) {}\n}, HEALTH_INTERVAL);\n\n// \u2500\u2500 Baileys \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nasync function initWA() {\n  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);\n  const { version } = await fetchLatestBaileysVersion();\n\n  sock = makeWASocket({\n    version,\n    auth: state,\n    printQRInTerminal: false,\n    logger: {\n      level: 'silent',\n      trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this; }\n    },\n    browser: ['VaadPro', 'Chrome', '1.0'],\n    connectTimeoutMs: 30000,\n    keepAliveIntervalMs: 30000,\n  });\n\n  sock.ev.on('connection.update', async (update) => {\n    const { connection, lastDisconnect, qr } = update;\n\n    if (qr) {\n      waReady = false; stopPolling();\n      const qrDataUrl = await qrcode.toDataURL(qr);\n      await pushStatus('qr', qrDataUrl, null);\n      console.log('');\n      console.log('\ud83d\udc46 Open VaadPro in browser -> Click Connect WhatsApp -> Scan QR');\n      console.log('');\n    }\n\n    if (connection === 'open') {\n      waReady = true;\n      const phone = sock.user?.id?.split(':')[0] || null;\n      await pushStatus('ready', null, phone);\n      startPolling();\n    }\n\n    if (connection === 'close') {\n      waReady = false; stopPolling();\n      const statusCode = (lastDisconnect?.error instanceof Boom)\n        ? lastDisconnect.error.output.statusCode : 0;\n\n      await pushStatus('disconnected', null, null);\n\n      if (statusCode === DisconnectReason.loggedOut) {\n        console.log('\u26a0\ufe0f  Logged out - clearing auth and restarting...');\n        fs.rmSync(AUTH_DIR, { recursive: true, force: true });\n        setTimeout(initWA, 3000);\n      } else {\n        console.log('\ud83d\udd04 Reconnecting...');\n        setTimeout(initWA, 5000);\n      }\n    }\n  });\n\n  sock.ev.on('creds.update', saveCreds);\n}\n\n// \u2500\u2500 Start \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconsole.log('');\nconsole.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');\nconsole.log('\u2551   VaadPro Bridge                     \u2551');\nconsole.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');\nconsole.log('');\nconsole.log('Connecting to VaadPro server...');\ninitWA().catch(console.error);\n";
const BRIDGE_PKG_CONTENT = "{\n  \"name\": \"vaadpro-bridge\",\n  \"version\": \"1.0.0\",\n  \"description\": \"VaadPro Bridge \u2013 \u05d7\u05d9\u05d1\u05d5\u05e8 \u05d5\u05d5\u05d8\u05e1\u05d0\u05e4\",\n  \"main\": \"bridge.js\",\n  \"type\": \"commonjs\",\n  \"scripts\": {\n    \"start\": \"node bridge.js\"\n  },\n  \"dependencies\": {\n    \"@whiskeysockets/baileys\": \"6.5.0\",\n    \"@hapi/boom\": \"^10.0.1\",\n    \"qrcode\": \"^1.5.3\"\n  }\n}\n";
const BRIDGE_INSTALL_BAT = '@echo off\ntitle VaadPro Bridge - Install\necho.\necho  VaadPro Bridge - Installation\necho  ==============================\necho.\necho  Installing... please wait (~2 min)\necho.\nnpm install\nif %errorlevel% neq 0 (\n    echo  ERROR: Installation failed.\n    pause\n    exit /b 1\n)\necho.\necho  Done! Now double-click start.bat to run.\necho.\npause\n';
const BRIDGE_START_BAT = '@echo off\ntitle VaadPro Bridge\ncolor 0A\necho.\necho  VaadPro Bridge - Running\necho  Do NOT close this window!\necho.\nnode bridge.js\necho.\necho  Bridge stopped.\npause\ngoto :eof\n';
const BRIDGE_INSTALL_SH = '#!/bin/bash\necho \necho VaadPro Bridge - Installation\necho ==============================\necho \necho Installing... please wait\necho \nnpm install\necho \necho Done! Run: ./start.sh\necho \n';
const BRIDGE_START_SH = '#!/bin/bash\nBRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"\n\necho ""\necho " ========================================"\necho "   VaadPro Bridge Launcher"\necho " ========================================"\necho ""\n\n# Check Node.js\nif ! command -v node &>/dev/null; then\n    echo " ERROR: Node.js is not installed."\n    echo " Go to https://nodejs.org and install the LTS version."\n    echo ""\n    exit 1\nfi\n\n# Check bridge.js\nif [ ! -f "$BRIDGE_DIR/bridge.js" ]; then\n    echo " ERROR: bridge.js not found in $BRIDGE_DIR"\n    exit 1\nfi\n\n# Install if needed\nif [ ! -d "$BRIDGE_DIR/node_modules" ]; then\n    echo " Installing dependencies (one-time, ~2 min)..."\n    cd "$BRIDGE_DIR" && npm install\n    echo " Done!"\n    echo ""\nfi\n\n# Create Desktop shortcut (Mac only, one-time)\nSHORTCUT="$HOME/Desktop/VaadPro Bridge.command"\nif [ ! -f "$SHORTCUT" ]; then\n    echo "#!/bin/bash" > "$SHORTCUT"\n    echo "cd \\"$BRIDGE_DIR\\" && ./VaadPro-Start.sh" >> "$SHORTCUT"\n    chmod +x "$SHORTCUT"\n    echo " Shortcut created on Desktop: VaadPro Bridge"\n    echo ""\nfi\n\n# Start Bridge\necho " Starting VaadPro Bridge..."\necho " Do NOT close this window!"\necho ""\n\ncd "$BRIDGE_DIR"\nnode bridge.js\n\necho ""\necho " Bridge stopped. Press Enter to restart or Ctrl+C to exit."\nread\nexec "$0"\n';const BRIDGE_README = '# VaadPro Bridge\n\n## Installation (one-time)\n1. Double-click install.bat\n2. Wait ~2 minutes\n\n## Daily use\n1. Double-click start.bat\n2. Do NOT close the window!\n3. Scan QR in the app (first time only)\n\n## Support: vaadpro15@gmail.com\n';

const VAADPRO_START_BAT = Buffer.from("406563686f206f66660a7365746c6f63616c20656e61626c6564656c61796564657870616e73696f6e0a7469746c65205661616450726f20427269646765204c61756e636865720a0a736574204252494447455f4449523d257e6470300a69662022254252494447455f4449523a7e2d3125223d3d225c2220736574204252494447455f4449523d254252494447455f4449523a7e302c2d31250a0a73657420424a544d503d255553455250524f46494c45255c7661616470726f5f6272696467655f746d702e6a730a736574204e4d544d503d255553455250524f46494c45255c7661616470726f5f6e6d5f746d702e7a69700a0a3a3a20446f776e6c6f6164206272696467652e6a73206966206d697373696e670a6966206e6f742065786973742022254252494447455f444952255c6272696467652e6a732220280a202020206563686f2020446f776e6c6f6164696e67206272696467652e6a732e2e2e0a20202020706f7765727368656c6c202d4e6f50726f66696c65202d457865637574696f6e506f6c69637920427970617373202d436f6d6d616e642022496e766f6b652d57656252657175657374202768747470733a2f2f7661616470726f2e6f72672f6170692f6272696467652f6272696467652d6a732d7075626c696327202d4f757446696c65202725424a544d502527202d557365426173696350617273696e67220a202020206966206578697374202225424a544d502522206d6f7665202f79202225424a544d5025222022254252494447455f444952255c6272696467652e6a7322203e6e756c20323e26310a290a0a6966206e6f742065786973742022254252494447455f444952255c6272696467652e6a732220280a202020206563686f20204552524f523a206272696467652e6a73206e6f7420666f756e642e0a20202020706175736520262065786974202f6220310a290a0a3a3a20436865636b204e6f64652e6a730a736574204e4f44455f4558453d0a7768657265206e6f6465203e6e756c20323e263120262620736574204e4f44455f4558453d6e6f64650a6966206e6f7420646566696e6564204e4f44455f4558452069662065786973742022433a5c50726f6772616d2046696c65735c6e6f64656a735c6e6f64652e657865222073657420224e4f44455f4558453d433a5c50726f6772616d2046696c65735c6e6f64656a735c6e6f64652e657865220a6966206e6f7420646566696e6564204e4f44455f4558452069662065786973742022433a5c50726f6772616d2046696c65732028783836295c6e6f64656a735c6e6f64652e657865222073657420224e4f44455f4558453d433a5c50726f6772616d2046696c65732028783836295c6e6f64656a735c6e6f64652e657865220a0a3a3a20496e7374616c6c204e6f64652e6a73206966206e6f7420666f756e640a6966206e6f7420646566696e6564204e4f44455f45584520280a202020206563686f2e0a202020206563686f20204e6f64652e6a73206e6f7420666f756e642e20446f776e6c6f6164696e6720616e6420696e7374616c6c696e67206175746f6d61746963616c6c792e2e2e0a202020206563686f202054686973206d61792074616b6520322d33206d696e757465732e20506c6561736520776169742e0a202020206563686f2e0a20202020706f7765727368656c6c202d4e6f50726f66696c65202d457865637574696f6e506f6c69637920427970617373202d436f6d6d616e642022496e766f6b652d57656252657175657374202768747470733a2f2f6e6f64656a732e6f72672f646973742f7632302e31312e312f6e6f64652d7632302e31312e312d7836342e6d736927202d4f757446696c652027255553455250524f46494c45255c6e6f64655f73657475702e6d736927202d557365426173696350617273696e673b2053746172742d50726f63657373206d736965786563202d417267756d656e744c69737420272f6920255553455250524f46494c45255c6e6f64655f73657475702e6d7369202f7175696574202f6e6f7265737461727427202d576169743b2052656d6f76652d4974656d2027255553455250524f46494c45255c6e6f64655f73657475702e6d736927202d466f726365220a2020202073657420224e4f44455f4558453d433a5c50726f6772616d2046696c65735c6e6f64656a735c6e6f64652e657865220a202020206563686f2e0a202020206563686f20204e6f64652e6a7320696e7374616c6c65642120506c65617365207265737461727420796f757220636f6d707574657220616e642072756e205661616450726f2042726964676520616761696e2e0a2020202070617573650a2020202065786974202f6220300a290a0a3a3a20446f776e6c6f616420616e642065787472616374206e6f64655f6d6f64756c6573206966206d697373696e670a6966206e6f742065786973742022254252494447455f444952255c6e6f64655f6d6f64756c65732220280a202020206563686f2e0a202020206563686f20203d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d0a202020206563686f202020446f776e6c6f6164696e672042726964676520646570656e64656e636965732e2e2e0a202020206563686f202020506c656173652077616974205e287e3330207365636f6e64735e292e0a202020206563686f20203d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d0a202020206563686f2e0a20202020706f7765727368656c6c202d4e6f50726f66696c65202d457865637574696f6e506f6c69637920427970617373202d436f6d6d616e642022496e766f6b652d57656252657175657374202768747470733a2f2f7661616470726f2e6f72672f6170692f6272696467652f6e6f64652d6d6f64756c657327202d4f757446696c652027254e4d544d502527202d557365426173696350617273696e67220a2020202069662065786973742022254e4d544d50252220280a20202020202020206563686f202045787472616374696e672e2e2e0a2020202020202020706f7765727368656c6c202d4e6f50726f66696c65202d457865637574696f6e506f6c69637920427970617373202d436f6d6d616e6420225b53797374656d2e494f2e436f6d7072657373696f6e2e5a697046696c655d3a3a45787472616374546f4469726563746f72792827254e4d544d5025272c2027254252494447455f444952252729220a202020202020202064656c2022254e4d544d502522203e6e756c20323e26310a20202020202020206563686f2020446f6e65210a20202020202020206563686f2e0a20202020290a290a0a3a3a2046616c6c6261636b20746f206e706d20696e7374616c6c206966207374696c6c206d697373696e670a6966206e6f742065786973742022254252494447455f444952255c6e6f64655f6d6f64756c65732220280a202020206563686f2e0a202020206563686f2020547279696e67206e706d20696e7374616c6c2061732066616c6c6261636b2e2e2e0a2020202070757368642022254252494447455f44495225220a202020206e706d20696e7374616c6c0a20202020706f70640a290a0a3a3a2046696e616c20636865636b0a6966206e6f742065786973742022254252494447455f444952255c6e6f64655f6d6f64756c65732220280a202020206563686f2e0a202020206563686f20204552524f523a204661696c656420746f20696e7374616c6c20646570656e64656e63696573210a2020202070617573650a2020202065786974202f6220310a290a0a3a3a204175746f2d757064617465206272696467652e6a732066726f6d207365727665720a706f7765727368656c6c202d4e6f50726f66696c65202d457865637574696f6e506f6c69637920427970617373202d436f6d6d616e642022496e766f6b652d57656252657175657374202768747470733a2f2f7661616470726f2e6f72672f6170692f6272696467652f6272696467652d6a732d7075626c696327202d4f757446696c65202725424a544d502527202d557365426173696350617273696e6722203e6e756c20323e26310a6966206578697374202225424a544d502522206d6f7665202f79202225424a544d5025222022254252494447455f444952255c6272696467652e6a7322203e6e756c20323e26310a0a3a3a20437265617465204465736b746f702073686f7274637574202866697273742074696d65290a736574202253484f52544355543d255553455250524f46494c45255c4465736b746f705c5661616450726f204272696467652e6c6e6b220a6966206e6f7420657869737420222553484f5254435554252220280a20202020706f7765727368656c6c202d4e6f50726f66696c65202d457865637574696f6e506f6c69637920427970617373202d436f6d6d616e6420222477733d4e65772d4f626a656374202d436f6d4f626a65637420575363726970742e5368656c6c3b2024733d2477732e43726561746553686f727463757428272553484f52544355542527293b2024732e546172676574506174683d27254252494447455f444952255c5661616450726f2d53746172742e626174273b2024732e576f726b696e674469726563746f72793d27254252494447455f44495225273b2024732e4465736372697074696f6e3d275661616450726f20427269646765273b2024732e536176652829220a290a0a3a3a20436865636b20696620616c72656164792072756e6e696e670a7461736b6c697374202f4649202257494e444f575449544c45206571205661616450726f204272696467652a2220323e6e756c207c2066696e64202f492022636d642e65786522203e6e756c0a696620256572726f726c6576656c253d3d3020280a202020206563686f20205661616450726f2042726964676520697320616c72656164792072756e6e696e672e20436865636b20796f7572207461736b6261722e0a20202020706175736520262065786974202f6220300a290a0a3a3a205374617274204272696467650a737461727420225661616450726f204272696467652220636d64202f6b20226364202f642022254252494447455f4449522522202626206563686f2e202626206563686f20203d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d202626206563686f2020205661616450726f20427269646765202d2052756e6e696e67202626206563686f202020446f204e4f5420636c6f736520746869732077696e646f7721202626206563686f20203d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d202626206563686f2e2026262022254e4f44455f4558452522206272696467652e6a73220a65786974202f6220300a", "hex").toString("utf8");
const VAADPRO_START_SH = '#!/bin/bash\nBRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"\n\necho ""\necho " ========================================"\necho "   VaadPro Bridge Launcher"\necho " ========================================"\necho ""\n\n# Check Node.js\nif ! command -v node &>/dev/null; then\n    echo " ERROR: Node.js is not installed."\n    echo " Go to https://nodejs.org and install the LTS version."\n    echo ""\n    exit 1\nfi\n\n# Download bridge.js if missing\nif [ ! -f "$BRIDGE_DIR/bridge.js" ]; then\n    echo " Downloading bridge.js..."\n    curl -s "https://vaadpro.org/api/bridge/bridge-js-public" -o "$BRIDGE_DIR/bridge.js"\nfi\n\nif [ ! -f "$BRIDGE_DIR/bridge.js" ]; then\n    echo " ERROR: bridge.js not found in $BRIDGE_DIR"\n    exit 1\nfi\n\n# Install node_modules if needed\nif [ ! -d "$BRIDGE_DIR/node_modules" ]; then\n    echo " Downloading dependencies..."\n    curl -s "https://vaadpro.org/api/bridge/node-modules" -o /tmp/vaadpro_nm.zip\n    if [ -f /tmp/vaadpro_nm.zip ]; then\n        unzip -o /tmp/vaadpro_nm.zip -d "$BRIDGE_DIR" && rm /tmp/vaadpro_nm.zip\n    else\n        cd "$BRIDGE_DIR" && npm install\n    fi\nfi\n\n# Auto-update bridge.js\ncurl -s "https://vaadpro.org/api/bridge/bridge-js-public" -o /tmp/vaadpro_bridge.js 2>/dev/null\nif [ -f /tmp/vaadpro_bridge.js ]; then\n    mv /tmp/vaadpro_bridge.js "$BRIDGE_DIR/bridge.js"\nfi\n\n# Create Desktop shortcut (Mac only, one-time)\nSHORTCUT="$HOME/Desktop/VaadPro Bridge.command"\nif [ ! -f "$SHORTCUT" ]; then\n    echo "#!/bin/bash" > "$SHORTCUT"\n    echo "cd \\"$BRIDGE_DIR\\" && ./VaadPro-Start.sh" >> "$SHORTCUT"\n    chmod +x "$SHORTCUT"\nfi\n\n# Start Bridge\necho " Starting VaadPro Bridge..."\necho " Do NOT close this window!"\necho ""\n\ncd "$BRIDGE_DIR"\nnode bridge.js\n\necho ""\necho " Bridge stopped. Press Enter to restart or Ctrl+C to exit."\nread\nexec "$0"\n';
const JWT_SECRET = process.env.JWT_SECRET || 'vaadpro-secret-change-in-production';

// ── Directories ──────────────────────────────────────────────────
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, '_users.json');
const WA_SESSIONS_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'wa_sessions') : path.join(__dirname, 'wa_sessions');
[DATA_DIR, WA_SESSIONS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

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
  const empty = () => ({ tenants: [], sentLog: {}, config: {}, reports: [], rptLayouts: {} });
  if (!fs.existsSync(f)) return empty();
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch(e) {
    // Layer 1 (backup): primary file is corrupt — try the .bak before giving up.
    console.error('[Data] Failed to parse ' + tenantId + '.json:', e.message);
    const backup = f + '.bak';
    if (fs.existsSync(backup)) {
      try {
        const recovered = JSON.parse(fs.readFileSync(backup, 'utf8'));
        console.log('[Data] Recovered ' + tenantId + ' from backup file (.bak)');
        return recovered;
      } catch(e2) { console.error('[Data] .bak for ' + tenantId + ' also unreadable:', e2.message); }
    }
    return empty();
  }
}

function saveTenantData(tenantId, patch) {
  const current = loadTenantData(tenantId);
  const merged  = Object.assign(current, patch);
  const f       = tenantFile(tenantId);
  const tmp     = f + '.tmp';
  const backup  = f + '.bak';
  const data    = JSON.stringify(merged, null, 2);
  // Layer 1 (backup): atomic write — write .tmp → back up current to .bak → atomic rename.
  // Same pattern already proven on _portal_tokens.json. Prevents a 0-byte / half-written
  // money file if Railway crashes mid-write.
  fs.writeFileSync(tmp, data, 'utf8');
  if (fs.existsSync(f)) {
    try { fs.copyFileSync(f, backup); } catch(e) { /* non-fatal — backup is best-effort */ }
  }
  fs.renameSync(tmp, f);
  return merged;
}

// ════════════════════════════════════════════════════════════════
// Backup Layer 2 — rolling daily snapshots of ALL data files
// ════════════════════════════════════════════════════════════════
// Staged backup plan (Neve Yam v3.4 §7) — שכבה 2.
// Layer 1 = atomic write per file (saveTenantData). Layer 2 = a daily
// point-in-time ZIP of the ENTIRE data dir, kept BACKUP_KEEP_DAYS back,
// plus an extra snapshot taken right before any manual restore.
//
// Design decisions (confirmed with operator):
//  - ONE system-wide snapshot per run (not per-tenant) — disaster recovery
//    is all-or-nothing, and shared files (_portal_tokens etc.) span tenants.
//  - Retention via env var BACKUP_KEEP_DAYS (default 14) — SaaS-level knob,
//    not a per-vaad setting (a tenant must not be able to disable backups).
//  - Captures the WHOLE data dir minus regenerable/transient/huge things,
//    so a file added in a FUTURE version is included automatically (e.g.
//    meterReadings — plan §9.6). No per-file enumeration to forget.
//  - Pure-Node ZIP writer — zero new npm deps, no shelling out (Hebrew
//    filenames + child_process quoting is a footgun). Deflate, UTF-8 flag.
//
// EXCLUDES (never backed up): the _backups dir itself (no recursion),
// wa_sessions (binary Baileys creds — regenerable by re-scanning QR, and
// large), bridge-node-modules.zip (huge, regenerable), and *.tmp / *.bak
// (transient — .bak is itself a Layer-1 artifact, no point nesting it).

const BACKUPS_DIR     = path.join(DATA_DIR, '_backups');
const BACKUP_CONFIG_FILE = path.join(DATA_DIR, '_backup_config.json');
if (!fs.existsSync(BACKUPS_DIR)) { try { fs.mkdirSync(BACKUPS_DIR, { recursive: true }); } catch(e) {} }

// Retention is runtime-configurable from the admin panel (super only) and
// persisted to _backup_config.json. Precedence on boot:
//   1) saved value in _backup_config.json (set via admin)
//   2) env BACKUP_KEEP_DAYS
//   3) default 14
// Clamped to a sane 1..365 range.
//
// Layer 3 (off-site email) settings also live here:
//   emailFreq ∈ {'off','daily','weekly','monthly'} (default 'weekly')
//   lastEmailSent: ISO string of the last successful off-site email (for cadence)
const _VALID_EMAIL_FREQ = ['off', 'daily', 'weekly', 'monthly'];
function _clampKeepDays(n) { n = parseInt(n, 10); if (!Number.isFinite(n)) return 14; return Math.max(1, Math.min(365, n)); }
function loadBackupConfig() {
  let keepDays = null, emailFreq = null, lastEmailSent = null;
  try {
    if (fs.existsSync(BACKUP_CONFIG_FILE)) {
      const c = JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8'));
      if (c) {
        if (c.keepDays != null) keepDays = _clampKeepDays(c.keepDays);
        if (typeof c.emailFreq === 'string' && _VALID_EMAIL_FREQ.includes(c.emailFreq)) emailFreq = c.emailFreq;
        if (c.lastEmailSent) lastEmailSent = c.lastEmailSent;
      }
    }
  } catch(e) { console.error('[Backup] config read failed:', e.message); }
  if (keepDays == null) keepDays = process.env.BACKUP_KEEP_DAYS ? _clampKeepDays(process.env.BACKUP_KEEP_DAYS) : 14;
  if (emailFreq == null) emailFreq = 'weekly';
  return { keepDays, emailFreq, lastEmailSent };
}
function saveBackupConfig(patch) {
  const cur = loadBackupConfig();
  const next = {
    keepDays: cur.keepDays,
    emailFreq: cur.emailFreq,
    lastEmailSent: cur.lastEmailSent || null
  };
  if (patch && patch.keepDays != null) next.keepDays = _clampKeepDays(patch.keepDays);
  if (patch && typeof patch.emailFreq === 'string' && _VALID_EMAIL_FREQ.includes(patch.emailFreq)) next.emailFreq = patch.emailFreq;
  if (patch && 'lastEmailSent' in patch) next.lastEmailSent = patch.lastEmailSent;
  // Atomic write (same discipline as Layer 1)
  const tmp = BACKUP_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, BACKUP_CONFIG_FILE);
  return next;
}
function getBackupKeepDays() { return loadBackupConfig().keepDays; }

// CRC-32 table (built once)
const _crc32Table = (() => {
  let c, t = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function _crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Minimal pure-Node ZIP writer. files: [{ name, data:Buffer }]. Deflate + UTF-8.
function _writeZip(files, outPath) {
  const zlib = require('zlib');
  const chunks = [], central = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21; // fixed 1980-01-01 — avoids tz noise
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc  = _crc32(f.data);
    const comp = zlib.deflateRawSync(f.data);
    const store = comp.length >= f.data.length;
    const method = store ? 0 : 8;
    const body = store ? f.data : comp;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  // Atomic: write .tmp then rename (same discipline as Layer 1)
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([...chunks, cd, eocd]));
  fs.renameSync(tmp, outPath);
}

// Collect every data file worth backing up (top-level of DATA_DIR only).
// SHARED helper — Layer 3 (off-site) and a future "full manual backup"
// button must both call THIS, so there is one definition of "all data".
function collectAllDataFiles() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(DATA_DIR, { withFileTypes: true }); } catch(e) { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;                 // skip dirs (_backups, wa_sessions)
    const name = ent.name;
    if (name.endsWith('.tmp') || name.endsWith('.bak')) continue;  // transient
    if (name === 'bridge-node-modules.zip') continue;              // huge, regenerable
    try {
      const data = fs.readFileSync(path.join(DATA_DIR, name));
      out.push({ name, data });
    } catch(e) { console.error('[Backup] skip unreadable file', name, e.message); }
  }
  return out;
}

// Create one snapshot. reason ∈ {'daily','pre-restore','manual'}. Returns path or null.
function createBackup(reason) {
  try {
    const files = collectAllDataFiles();
    if (!files.length) { console.warn('[Backup] no data files to back up — skipping'); return null; }
    // Israel-local timestamp so filenames line up with the operator's day
    const ilNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const pad = n => String(n).padStart(2, '0');
    const ts = `${ilNow.getFullYear()}-${pad(ilNow.getMonth()+1)}-${pad(ilNow.getDate())}_${pad(ilNow.getHours())}${pad(ilNow.getMinutes())}${pad(ilNow.getSeconds())}`;
    const safeReason = (reason || 'manual').replace(/[^a-z0-9-]/gi, '');
    const outPath = path.join(BACKUPS_DIR, `backup-${safeReason}-${ts}.zip`);
    _writeZip(files, outPath);
    const sizeKb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(`[Backup] created ${path.basename(outPath)} — ${files.length} files, ${sizeKb}KB`);
    pruneOldBackups();
    return outPath;
  } catch(e) {
    console.error('[Backup] createBackup failed:', e.message);
    return null;  // never throw — a backup failure must not break the caller
  }
}

// Delete snapshots older than BACKUP_KEEP_DAYS (by mtime). Best-effort.
function pruneOldBackups() {
  try {
    const keepDays = getBackupKeepDays();
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(BACKUPS_DIR)) {
      if (!f.startsWith('backup-') || !f.endsWith('.zip')) continue;
      const fp = path.join(BACKUPS_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
      } catch(e) { /* skip */ }
    }
    if (removed > 0) console.log(`[Backup] pruned ${removed} backup(s) older than ${keepDays} days`);
  } catch(e) { console.error('[Backup] prune failed:', e.message); }
}

// ── Backup Layer 3 — off-site copy via email (Resend) ───────────────
// Attaches the latest ZIP to an email to ADMIN_EMAIL. The ONLY copy that
// survives total loss of the Railway volume. Frequency is admin-controlled
// (off/daily/weekly/monthly, default weekly). Uses the existing Resend key
// but a DEDICATED sender (sendEmailResend has no attachment support).
const RESEND_MAX_ATTACH_MB = 25; // Resend hard limit ~25MB

async function sendBackupEmail(zipPath, reason) {
  const adminEmail = process.env.ADMIN_EMAIL || '';
  if (!adminEmail) { console.log('[Backup] ADMIN_EMAIL not set — skipping off-site email'); return false; }
  if (!RESEND_API_KEY) { console.log('[Backup] RESEND_API_KEY not set — skipping off-site email'); return false; }
  let buf;
  try { buf = fs.readFileSync(zipPath); } catch(e) { console.error('[Backup] cannot read zip for email:', e.message); return false; }
  const sizeMb = buf.length / (1024 * 1024);
  if (sizeMb > RESEND_MAX_ATTACH_MB) {
    console.error(`[Backup] zip ${sizeMb.toFixed(1)}MB exceeds Resend ${RESEND_MAX_ATTACH_MB}MB limit — off-site email NOT sent. Consider R2/S3 for off-site at this scale.`);
    // Still notify the admin (without attachment) so the failure is visible
    try {
      await sendEmailResend(adminEmail, '⚠️ גיבוי VaadPro גדול מדי לאימייל',
        `<div dir="rtl">הגיבוי היומי (${Math.round(sizeMb)}MB) חורג ממגבלת ${RESEND_MAX_ATTACH_MB}MB של האימייל ולא נשלח כקובץ מצורף.<br>הגיבוי קיים בשרת (שכבות 1+2). כדאי לשקול מעבר לאחסון off-site (R2/S3).</div>`);
    } catch(e) {}
    return false;
  }
  const fname = path.basename(zipPath);
  const ilNow = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  let tenantCount = 0;
  try { tenantCount = (loadUsers() || []).length; } catch(e) {}
  const fromAddr = SMTP_FROM || 'VaadPro <onboarding@resend.dev>';
  const subject = `גיבוי VaadPro — ${ilNow}`;
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#222;max-width:560px;">
<h2 style="margin:0 0 12px">🛡️ גיבוי VaadPro</h2>
גיבוי אוטומטי של כל נתוני המערכת מצורף להודעה זו.<br><br>
<strong>תאריך:</strong> ${ilNow}<br>
<strong>לקוחות במערכת:</strong> ${tenantCount}<br>
<strong>גודל הגיבוי:</strong> ${Math.round(buf.length/1024)}KB<br>
<strong>קובץ:</strong> ${fname}<br><br>
<em style="color:#666;font-size:13px;">שמור הודעה זו — זהו עותק off-site של כל נתוני המערכת, מחוץ לשרת. לשחזור: פתח את ה-ZIP והעלה את הקובץ הרצוי דרך "שחזור מגיבוי".</em>
<hr style="margin:20px 0;border:none;border-top:1px solid #eee;">
<p style="font-size:12px;color:#999;">VaadPro — גיבוי אוטומטי (שכבה 3)</p>
</div>`;
  const payload = {
    from: fromAddr, to: adminEmail, subject, html,
    attachments: [{ filename: fname, content: buf.toString('base64') }]
  };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || JSON.stringify(data));
    console.log(`[Backup] off-site email sent to ${adminEmail} (${fname}, ${Math.round(buf.length/1024)}KB)`);
    return true;
  } catch(e) {
    console.error('[Backup] off-site email failed:', e.message);
    return false;
  }
}

// Decide if an off-site email is due now, based on emailFreq + lastEmailSent.
function offsiteEmailDue() {
  const cfg = loadBackupConfig();
  if (cfg.emailFreq === 'off') return false;
  if (!cfg.lastEmailSent) return true; // never sent → send now
  const last = new Date(cfg.lastEmailSent).getTime();
  if (isNaN(last)) return true;
  const days = (Date.now() - last) / (24 * 60 * 60 * 1000);
  if (cfg.emailFreq === 'daily')   return days >= 1;
  if (cfg.emailFreq === 'weekly')  return days >= 7;
  if (cfg.emailFreq === 'monthly') return days >= 30;
  return false;
}

// Create a fresh snapshot and email it off-site (if due / forced). Updates lastEmailSent.
async function runOffsiteBackup(force) {
  if (!force && !offsiteEmailDue()) return false;
  const zip = createBackup('daily');
  if (!zip) return false;
  const ok = await sendBackupEmail(zip, 'offsite');
  if (ok) saveBackupConfig({ lastEmailSent: new Date().toISOString() });
  return ok;
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

const WA_MODE = process.env.WA_MODE || 'server'; // 'server' (Baileys on Railway) | 'cloud' (external Bridge) | 'local' (legacy)
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'vaadpro-bridge-secret';

// ── WhatsApp state (used in both modes) ─────────────────────────
const waClients = {}; // tenantId → { client?, status, qrData, phone, restarting, healthTimer }
const deletedTenants = new Set(); // tenantId-ים שנמחקו — חוסם reconnect/init של session יתום

function getWa(tenantId) {
  if (!waClients[tenantId]) {
    waClients[tenantId] = { client: null, status: 'disconnected', qrData: null, phone: null, restarting: false, healthTimer: null, qrCount: 0, qrTimer: null };
  }
  return waClients[tenantId];
}

// ── Baileys WA Engine (server mode) ─────────────────────────────
// Silent pino logger — suppresses Baileys internal noise in Railway logs
const pinoLogger = require('pino')({ level: 'silent' });

// ── QR burn-protection ──────────────────────────────────────────
// אם המשתמש לא סורק את הברקוד, Baileys ממשיך לייצר QR חדש כל ~20ש'.
// כל QR נספר אצל WhatsApp כניסיון linking, ואחרי כמה כאלה WhatsApp חוסם
// זמנית ("Can't link new devices right now"). כדי למנוע זאת — סוגרים את
// ה-socket אחרי מספר מוגבל של QR-ים בלי סריקה.
const QR_MAX_REFRESHES = 4;        // עד 4 QR-ים (~1.5 דק') ואז סוגרים
const QR_IDLE_TIMEOUT_MS = 90000;  // או 90ש' ללא סריקה — מה שמגיע קודם

function stopQrWatch(wa) {
  if (wa && wa.qrTimer) { clearTimeout(wa.qrTimer); wa.qrTimer = null; }
}

function closeIdleQr(tenantId, reason) {
  const wa = getWa(tenantId);
  stopQrWatch(wa);
  if (wa.status !== 'qr') return; // נסרק/נסגר בינתיים — אין מה לעשות
  console.log(`[WA:${tenantId}] QR idle — closing socket (${reason})`);
  if (wa.client) { try { wa.client.end(undefined); } catch(e) {} }
  wa.client = null;
  wa.status = 'qr_expired';
  wa.qrData = null;
  wa.qrCount = 0;
}

async function restartWa(tenantId, reason) {
  const wa = getWa(tenantId);
  if (wa.restarting) return;
  wa.restarting = true;
  wa.status = 'disconnected';
  wa.phone  = null;
  console.log(`[WA:${tenantId}] restart: ${reason}`);
  // Close existing sock if any
  if (wa.client) {
    try { wa.client.end(undefined); } catch(e) {}
    wa.client = null;
  }
  await new Promise(r => setTimeout(r, 3000));
  wa.restarting = false;
  initWa(tenantId);
}

async function initWa(tenantId) {
  if (WA_MODE !== 'server') return; // Only run in server mode
  if (deletedTenants.has(tenantId)) {
    console.log(`[WA:${tenantId}] init skipped — tenant deleted`);
    return;
  }
  const wa = getWa(tenantId);
  const sessionDir = path.join(WA_SESSIONS_DIR, tenantId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  // אתחול מונה QR לכל ניסיון חיבור חדש
  stopQrWatch(wa);
  wa.qrCount = 0;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pinoLogger,
      browser: ['VaadPro', 'Chrome', '1.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
    });

    wa.client = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        wa.status = 'qr';
        wa.qrData = await qrcode.toDataURL(qr);
        wa.qrCount = (wa.qrCount || 0) + 1;
        console.log(`[WA:${tenantId}] QR ready (#${wa.qrCount}) — waiting for scan`);
        // אם נשרפו יותר מדי QR-ים בלי סריקה — סגור כדי לא לעורר חסימת WhatsApp
        if (wa.qrCount >= QR_MAX_REFRESHES) {
          closeIdleQr(tenantId, `${QR_MAX_REFRESHES} QRs unscanned`);
          return;
        }
        // אפס טיימר idle — סגירה אם המשתמש נוטש את המסך
        stopQrWatch(wa);
        wa.qrTimer = setTimeout(() => closeIdleQr(tenantId, 'idle timeout'), QR_IDLE_TIMEOUT_MS);
      }

      if (connection === 'open') {
        wa.status = 'ready';
        wa.qrData = null;
        stopQrWatch(wa);
        wa.qrCount = 0;
        wa.phone  = sock.user?.id?.split(':')[0] || null;
        console.log(`[WA:${tenantId}] connected — ${wa.phone}`);
        // עדכן firstConnectedAt / lastConnectedAt — מוציא מ"ממתינים להתקנה" באדמין
        try {
          const users = loadUsers();
          const user = users.find(u => u.tenantId === tenantId);
          if (user) {
            if (!user.firstConnectedAt) user.firstConnectedAt = new Date().toISOString();
            user.lastConnectedAt = new Date().toISOString();
            saveUsers(users);
            console.log(`[WA:${tenantId}] lastConnectedAt saved`);
          }
        } catch(e) { console.error(`[WA:${tenantId}] failed to save lastConnectedAt:`, e.message); }
      }

      if (connection === 'close') {
        stopQrWatch(wa);
        // אם סגרנו בכוונה QR נטוש — אל תפעיל reconnect (זה היה שורף עוד QR-ים)
        if (wa.status === 'qr_expired') {
          wa.phone = null;
          wa.client = null;
          console.log(`[WA:${tenantId}] closed after idle QR — not reconnecting (user must click again)`);
          return;
        }
        wa.status = 'disconnected';
        wa.phone  = null;
        wa.client = null;
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode : 0;
        console.log(`[WA:${tenantId}] closed — code=${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut) {
          // Logged out from phone — clear session, wait for new QR scan
          console.log(`[WA:${tenantId}] logged out — clearing session`);
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e) {}
          wa.status = 'disconnected';
          // Do NOT auto-restart — user must click "Connect WhatsApp" again
        } else {
          // Network/timeout disconnect — auto reconnect
          console.log(`[WA:${tenantId}] reconnecting in 5s...`);
          setTimeout(() => initWa(tenantId), 5000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch(e) {
    console.error(`[WA:${tenantId}] init error:`, e.message);
    wa.status = 'disconnected';
    wa.client = null;
    setTimeout(() => restartWa(tenantId, 'init: '+e.message), 8000);
  }
}

async function sendWaMsg(tenantId, phone, message) {
  // חובה לשלוח דרך ה-session של הלקוח עצמו — לעולם לא דרך מספר של לקוח אחר.
  // (fallback חוצה-לקוחות נמחק: הוא גרם להודעות להישלח ממספר זר ומנע שמירת lastConnectedAt)
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    // רק כשאין tenantId בכלל (קריאה כללית) — קח כל session מחובר
    resolvedTenantId = Object.keys(waClients).find(id => waClients[id] && waClients[id].status === 'ready');
  }
  if (!resolvedTenantId) throw new Error('WhatsApp לא מחובר. לחץ על "חיבור WhatsApp" וסרוק את הברקוד.');
  const wa = getWa(resolvedTenantId);
  if (wa.status !== 'ready') throw new Error('WhatsApp מנותק — לחץ "חיבור WhatsApp" וסרוק ברקוד.');
  let normalized = phone.replace(/\D/g, '');
  if (normalized.startsWith('0')) normalized = '972' + normalized.slice(1);

  if (WA_MODE === 'server') {
    // Baileys running on Railway — send directly
    if (!wa.client) throw new Error('WhatsApp לא מחובר — סרוק ברקוד חדש');
    const jid = normalized + '@s.whatsapp.net';
    await wa.client.sendMessage(jid, { text: message });
    return;
  }

  if (WA_MODE === 'cloud') {
    // External Bridge polling mode (legacy)
    const queue = sendQueue[tenantId] = sendQueue[tenantId] || [];
    return new Promise((resolve, reject) => {
      const msgId = Date.now() + '_' + Math.random().toString(36).slice(2);
      queue.push({ msgId, phone: normalized, message, resolve, reject, ts: Date.now() });
      setTimeout(() => reject(new Error('Bridge timeout – וודא שה-WA Bridge מחובר')), 30000);
    });
  }

  // WA_MODE === 'local' (legacy — whatsapp-web.js, kept for backward compat)
  try {
    await wa.client.sendMessage(normalized + '@c.us', message);
  } catch(e) {
    throw new Error('WhatsApp התנתק – מתחבר מחדש, נסה שוב בעוד 15 שניות');
  }
}

// ── Send Queue (cloud mode) ──────────────────────────────────────
const sendQueue  = {}; // tenantId → [{msgId, phone, message, resolve, reject}]
const bridgeCmds = {}; // tenantId → ['reset-auth', ...]

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
  const cmds = bridgeCmds[tenantId] || [];
  bridgeCmds[tenantId] = []; // clear after sending
  res.json({ pending, cmds });
});

// Reset WhatsApp auth — sends reset-auth command to Bridge
app.post('/api/wa/reset-auth', authMiddleware, (req, res) => {
  const { tenantId } = req.user;
  if (!bridgeCmds[tenantId]) bridgeCmds[tenantId] = [];
  bridgeCmds[tenantId].push('reset-auth');
  const wa = getWa(tenantId);
  wa.status = 'disconnected';
  wa.phone  = null;
  wa.qrData = null;
  console.log(`[wa/reset-auth] reset-auth queued for ${tenantId}`);
  res.json({ ok: true });
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

// ════════════════════════════════════════════════════════════════
// PARTIAL PAYMENT SUPPORT (v2.13.8) — Stage 1: derivation only
// ════════════════════════════════════════════════════════════════
// ⚠️ READ-ONLY. Nothing here writes to disk or mutates openingDebt.
// Accrual to openingDebt stays EXCLUSIVELY in closeMonthUnpaid.
//
// Two stores, two roles (see SKILL "sentLog / paymentHistory Architecture"):
//   • HOW MUCH ARRIVED -> sentLog VALUE. Source of truth. Both import paths
//     (Agent /api/import-bank and manual POST /api/data) encode it identically.
//   • HOW MUCH WAS DUE -> paymentHistory.amount — the tariff FROZEN at payment
//     time. Required: reading the live customAmount for a historical month
//     would retroactively invent debt on settled months after any tariff change.
// ⚠️ The paymentHistory `paid` FLAG is NEVER read here. That flag is what
//    produced the v2.13.2 "Tami" divergence. The `amount` field is a different
//    field with a different history and is safe. Do not conflate the two.

// Parse the amount actually paid out of a sentLog VALUE.
//   bank_import_<ISO>_<AMOUNT>_payer_<NAME>  |  manual_paid_<ISO>_amount_<AMOUNT>
// Returns null for reminders (sent_) and for legacy values with no amount.
function parseSentLogAmount(val) {
  const s = String(val || '');
  if (!s) return null;
  if (s.startsWith('bank_import')) {
    const m = s.match(/^bank_import_[^_]+_([\d.]+)_payer_/);
    return m ? parseFloat(m[1]) : null;
  }
  if (s.startsWith('manual_paid')) {
    const m = s.match(/_amount_([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

// Does sentLog say a payment (of any size) arrived? Same predicate the rest of
// the codebase already uses — kept identical on purpose.
function sentLogIsPayment(val) {
  const s = String(val || '');
  return s.startsWith('bank_import') || s.startsWith('manual_paid');
}

// Expected charge for a month: frozen paymentHistory.amount, else live fallback.
function getExpectedAmount(history, monthKey, fallbackAmount) {
  const rec = (history || []).find(r => r.month === monthKey && r.type !== 'wa_sent');
  if (rec && rec.amount != null && !isNaN(parseFloat(rec.amount))) return parseFloat(rec.amount);
  return parseFloat(fallbackAmount) || 0;
}

// Per-month balance derived ONLY from sentLog + the frozen expected amount.
// status: 'paid' | 'partial' | 'unpaid' | 'reminded'
function calcMonthBalance(sentLogVal, expectedAmount) {
  const expected = parseFloat(expectedAmount) || 0;
  if (!sentLogIsPayment(sentLogVal)) {
    return {
      status: String(sentLogVal || '').startsWith('sent_') ? 'reminded' : 'unpaid',
      paidAmount: 0, expected, shortfall: expected, credit: 0
    };
  }
  const parsed = parseSentLogAmount(sentLogVal);
  // Legacy value with no amount encoded -> treat as a full payment (preserves
  // pre-v2.13.8 behaviour for existing data; no retroactive debt).
  if (parsed === null) return { status: 'paid', paidAmount: expected, expected, shortfall: 0, credit: 0 };
  const diff = Math.round((parsed - expected) * 100) / 100;
  if (diff < 0) return { status: 'partial', paidAmount: parsed, expected, shortfall: Math.abs(diff), credit: 0 };
  return { status: 'paid', paidAmount: parsed, expected, shortfall: 0, credit: diff };
}

// ⚠️⚠️ DOUBLE-COUNT GUARD — read this before touching credit logic.
// An overpayment is visible in TWO places, but only ever counts ONCE:
//   1. Derived live from sentLog (surplus in the month value)  -> pre-close
//   2. Written into a NEGATIVE openingDebt by closeMonthUnpaid -> post-close (1st)
// After closeMonthUnpaid runs, both are true at the same time; naively adding
// them would double the tenant's credit. Rule: a NEGATIVE openingDebt means the
// surplus has ALREADY been banked to disk, so the derived credit is suppressed.
// (openingDebt >= 0 -> nothing banked yet -> derived credit is the only source.)
// This mirrors the "conservative on disk, aggressive on display" rule: we never
// write here, we only decide which of the two already-existing sources to trust.
function getDerivedCredit(tenantData, tenantId, creditTotal) {
  if (!creditTotal) return 0;
  const openingDebt = parseFloat(
    (tenantData.tenants || []).find(t => String(t.id) === String(tenantId))?.openingDebt || 0
  );
  if (openingDebt < 0) return 0; // already banked by closeMonthUnpaid — do not count twice
  return creditTotal;
}

// Sum of unpaid + short-paid amounts across ALL months present in sentLog for a
// tenant, EXCLUDING the month keys' current-month handling (callers decide).
// Derives every month from sentLog; paymentHistory supplies only frozen amounts.
function calcShortfallFromSentLog(tenantData, tenantId, opts) {
  const o = opts || {};
  const sentLog = tenantData.sentLog || {};
  const history = (tenantData.paymentHistory || {})[String(tenantId)] || [];
  const tenant  = (tenantData.tenants || []).find(t => String(t.id) === String(tenantId));
  const live    = (tenant && tenant.customAmount) || (tenantData.config && tenantData.config.amount) || 300;
  const year    = o.year || new Date().getFullYear();
  let total = 0;
  let creditTotal = 0;
  const months = [];
  Object.keys(sentLog).forEach(key => {
    if (key.includes('__acc__')) return;                 // extra accounts: separate path
    const lastSep = key.lastIndexOf('_');
    if (lastSep < 0) return;
    if (String(key.slice(0, lastSep)) !== String(tenantId)) return;
    const hebMonth = key.slice(lastSep + 1);
    const idx = HEBREW_MONTHS.indexOf(hebMonth);
    if (idx < 0) return;                                  // legacy/ISO key -> untouched
    const monthKey = year + '-' + String(idx + 1).padStart(2, '0');
    if (o.excludeMonthKey && monthKey === o.excludeMonthKey) return;
    const expected = getExpectedAmount(history, monthKey, live);
    const bal = calcMonthBalance(sentLog[key], expected);
    if (bal.status === 'partial') { total += bal.shortfall; months.push({ monthKey, hebMonth, shortfall: bal.shortfall }); }
    // v2.13.8: overpayment in a month is credit the moment it lands — do NOT
    // wait for closeMonthUnpaid to write a negative openingDebt on the 1st.
    else if (bal.credit > 0) { creditTotal += bal.credit; months.push({ monthKey, hebMonth, credit: bal.credit }); }
  });
  return {
    total: Math.round(total * 100) / 100,
    creditTotal: Math.round(creditTotal * 100) / 100,
    months
  };
}

// Calculate total cumulative debt for a tenant:
// unpaid paymentHistory months + openingDebt (includes current month)
// openingDebt can be negative (tenant has credit) — it offsets historyDebt
function calcTotalDebt(tenantData, tenantId, currentMonthKey) {
  const openingDebt = parseFloat(
    (tenantData.tenants || []).find(t => String(t.id) === String(tenantId))?.openingDebt || 0
  );
  const history = (tenantData.paymentHistory || {})[String(tenantId)] || [];
  const historyDebt = history
    .filter(r => !r.paid && r.type !== 'wa_sent')
    .reduce((s, r) => s + (r.amount || 0), 0);
  // v2.13.8: add short-paid months (paid < expected). Derived from sentLog only;
  // openingDebt is NOT mutated here (accrual stays in closeMonthUnpaid).
  // currentMonthKey is NOT excluded: a partial payment this month is real debt now.
  const sf = calcShortfallFromSentLog(tenantData, tenantId, {
    year: currentMonthKey ? parseInt(String(currentMonthKey).split('-')[0]) : undefined
  });
  // ⚠️ Overpayment counts as credit IMMEDIATELY (sf.creditTotal), symmetric with
  // sf.total. Once closeMonthUnpaid runs it writes the same surplus into a
  // negative openingDebt — see getDerivedCredit() for the double-count guard.
  const derivedCredit = getDerivedCredit(tenantData, tenantId, sf.creditTotal);
  // openingDebt can be negative (credit from overpayment) — offsets historyDebt
  // Math.max(0,...) — total debt shown cannot be negative; credit shown separately via getCreditBalance()
  return Math.max(0, historyDebt + openingDebt + sf.total - derivedCredit);
}

// Returns the credit balance (positive number = tenant has credit).
// Credit exists when openingDebt is negative and no unpaid history debt.
function getCreditBalance(tenantData, tenantId) {
  const openingDebt = parseFloat(
    (tenantData.tenants || []).find(t => String(t.id) === String(tenantId))?.openingDebt || 0
  );
  const history = (tenantData.paymentHistory || {})[String(tenantId)] || [];
  const historyDebt = history
    .filter(r => !r.paid && r.type !== 'wa_sent')
    .reduce((s, r) => s + (r.amount || 0), 0);
  const sf = calcShortfallFromSentLog(tenantData, tenantId, {});
  // v2.13.8: credit is SYMMETRIC with shortfall — an overpayment is credit the
  // moment the bank row lands, not only after closeMonthUnpaid writes a negative
  // openingDebt on the 1st. The old `if (openingDebt >= 0) return 0` early-exit
  // hid all pre-close credit and is deliberately removed.
  const derivedCredit = getDerivedCredit(tenantData, tenantId, sf.creditTotal);
  // Net: positive means credit remaining after covering any unpaid history/shortfall
  const net = -(historyDebt + openingDebt) + derivedCredit - sf.total;
  return Math.max(0, Math.round(net * 100) / 100);
}

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
// paidAmount: the actual amount the tenant paid (may differ from the monthly fee)
function recordPayment(tenantData, tenantId, monthKey, type, amount, tenantName, payerName, paidAmount) {
  if (!tenantData.paymentHistory) tenantData.paymentHistory = {};
  if (!tenantData.paymentHistory[tenantId]) tenantData.paymentHistory[tenantId] = [];
  // wa_sent = תזכורת בלבד, לא תשלום
  const isPaid = (type === 'manual' || type === 'bank');
  const record = {
    month:      monthKey,
    paid:       isPaid,
    amount:     amount || 0,
    paidAmount: (paidAmount != null && isPaid) ? parseFloat(paidAmount) : (amount || 0),
    date:       new Date().toISOString().split('T')[0],
    type:       type, // 'wa_sent' | 'manual' | 'bank'
    name:       tenantName || '',
    payerName:  payerName || ''
  };
  const existing = tenantData.paymentHistory[tenantId].findIndex(r => r.month === monthKey);
  if (existing >= 0) {
    // אל תדרוס תשלום אמיתי עם תזכורת
    if (!isPaid && tenantData.paymentHistory[tenantId][existing].paid) return;
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
<strong>לחיבור WhatsApp — רק לסרוק ברקוד:</strong>
<hr style="margin:8px 0;border:none;border-top:1px solid #eee;">

<strong>1. כנס לאפליקציה</strong>
היכנס עם האימייל והסיסמה שבחרת בהרשמה.

<strong>2. לחץ "חיבור WhatsApp"</strong>
בהגדרות ← לחץ על כפתור "חיבור WhatsApp". יוצג ברקוד QR.

<strong>3. סרוק עם הטלפון</strong>
פתח WhatsApp בטלפון ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← סרוק את הברקוד שעל המסך ← מחובר ✅

<em style="color:#666;font-size:13px;">אין צורך בהורדה או התקנה כלשהי — הכל פועל מהדפדפן.</em>

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

// ── התראת Super Admin על הרשמת לקוח חדש (אימייל) ──────────
// נשלח לכתובת ADMIN_EMAIL — fire-and-forget, לעולם לא מפיל את ההרשמה.
async function notifyAdminNewSignup(user) {
  const adminEmail = process.env.ADMIN_EMAIL || '';
  if (!adminEmail) { console.log('[Admin notify] ADMIN_EMAIL not set - skipping new-signup alert'); return; }
  if (!RESEND_API_KEY && (!SMTP_HOST || !SMTP_USER)) { console.log('[Admin notify] email not configured - skipping'); return; }
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';
  const when = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const subject = '\u{1F195} לקוח חדש נרשם ל-VaadPro: ' + (user.buildingName || user.address || user.email);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const row = (label, val) => val ? ('<tr><td style="padding:4px 12px 4px 0;color:#888;white-space:nowrap">' + label + '</td><td style="padding:4px 0;font-weight:bold">' + esc(val) + '</td></tr>') : '';
  const body = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#222;max-width:560px;">'
    + '<h2 style="margin:0 0 12px;font-size:18px;">\u{1F195} לקוח חדש נרשם למערכת</h2>'
    + '<table style="border-collapse:collapse;margin:8px 0 16px;">'
    + row('שם בניין / תצוגה:', user.buildingName)
    + row('כתובת:', user.address)
    + row('איש קשר:', user.fullName)
    + row('טלפון:', user.phone)
    + row('אימייל:', user.email)
    + row('נרשם ב:', when)
    + '</table>'
    + '<a href="' + appUrl + '/admin" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">פתח פאנל אדמין &#8592;</a>'
    + '<p style="font-size:12px;color:#999;margin-top:20px;">הלקוח טרם חיבר WhatsApp - יופיע ב"ממתינים לחיבור WhatsApp".</p>'
    + '</div>';
  try {
    await sendEmailResend(adminEmail, subject, body);
    console.log('[Admin notify] new-signup alert sent to ' + adminEmail + ' for ' + user.email);
  } catch(e) {
    console.error('[Admin notify] failed:', e.message);
  }
}

// מפתח Google Maps (ציבורי — מוגבל ב-referrer בצד Google). מאפשר החלפת מפתח דרך env var בלי deploy.
app.get('/api/maps-key', (req, res) => {
  res.json({ key: process.env.GOOGLE_MAPS_KEY || '' });
});

// הרשמה
app.post('/api/auth/register', async (req, res) => {
  const { email, password, buildingName, address, placeId, phone, fullName } = req.body;
  // הכתובת היא החובה החדשה; שם הבניין אופציונלי (נופל חזרה לכתובת לתצוגה)
  if (!email || !password || !address) return res.json({ ok: false, error: 'יש למלא את כל השדות' });
  if (password.length < 6) return res.json({ ok: false, error: 'סיסמה חייבת להכיל לפחות 6 תווים' });

  const users = loadUsers();
  if (users.find(u => u.email === email.toLowerCase())) return res.json({ ok: false, error: 'אימייל זה כבר רשום' });

  // אם שם הבניין ריק — השתמש בכתובת כשם תצוגה (fallback)
  const displayName = (buildingName && buildingName.trim()) ? buildingName.trim() : address;

  const tenantId  = uuidv4();
  const passHash  = await bcrypt.hash(password, 10);
  const trialEnd  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 יום

  const user = { id: uuidv4(), email: email.toLowerCase(), passHash, tenantId, buildingName: displayName, address: address||'', buildingPlaceId: placeId||'', phone: phone||'', fullName: fullName||'', plan: 'trial', trialEnd, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);

  // צור קובץ נתונים ראשוני לבניין
  saveTenantData(tenantId, { tenants: [], sentLog: {}, config: { amount: 300, sendDay: 1, sendHour: 9, sendMinute: 0, monthMode: 'auto', manualMonth: '', template: 'שלום {שם}! 👋\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה! 🙏' }, reports: [], rptLayouts: {} });

  const token = jwt.sign({ userId: user.id, tenantId, email: user.email, buildingName: displayName, fullName: fullName||'' }, JWT_SECRET, { expiresIn: '30d' });
  // שלח אימייל ברוכה (לא חוסם את התשובה)
  sendWelcomeEmail(user.email, displayName, tenantId).catch(() => {});
  // התראה ל-Super Admin על לקוח חדש (לא חוסם, לא מפיל את ההרשמה)
  notifyAdminNewSignup(user).catch(() => {});
  res.json({ ok: true, token, buildingName: displayName, plan: 'trial', trialEnd });
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
  // qr_expired (סגרנו QR נטוש) → מציגים למשתמש "מנותק" כדי שילחץ חיבור מחדש
  const outStatus = wa.restarting ? 'reconnecting'
                  : (wa.status === 'qr_expired' ? 'disconnected' : wa.status);
  res.json({
    status:          outStatus,
    qrDataUrl:       wa.status === 'qr_expired' ? null : wa.qrData,
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
  // Stage 2: computed labels (orgType + overrides) so the frontend mirrors the
  // SAME LABELS + fallback as the server. orgType absent -> vaad -> existing strings.
  d.labels = getLabels(d.config);
  // ⚠️ v2.13.10 — SINGLE SOURCE OF TRUTH for all money math.
  // The server computes every derived figure ONCE and ships it; app.html and
  // tenant-portal.html CONSUME these and must NEVER recompute debt/credit
  // locally. Duplicated client-side math is what produced both the "paid +
  // 30 due" portal contradiction and the payments-tab "שולם" on a partial
  // payment. Same rule as buildAccountsBlock (v2.12.0): one definition, many
  // call sites. If a new figure is needed by a screen, ADD IT HERE — do not
  // recompute it in the page.
  if (d.tenants) {
    const mkNow = getMonthKey(d.config || {});
    const emNow = getEffectiveMonth(d.config || {});
    d.tenants = d.tenants.map(t => {
      const tid  = String(t.id);
      const hist = (d.paymentHistory || {})[tid] || [];
      const live = t.customAmount || (d.config && d.config.amount) || 300;
      // Per-month balance map for every month present in sentLog (main account).
      const monthBalances = {};
      Object.keys(d.sentLog || {}).forEach(key => {
        if (key.includes('__acc__')) return;
        const sep = key.lastIndexOf('_');
        if (sep < 0 || String(key.slice(0, sep)) !== tid) return;
        const heb = key.slice(sep + 1);
        const idx = HEBREW_MONTHS.indexOf(heb);
        if (idx < 0) return; // legacy/ISO key — untouched
        const mKey = String(mkNow).split('-')[0] + '-' + String(idx + 1).padStart(2, '0');
        monthBalances[heb] = calcMonthBalance(d.sentLog[key], getExpectedAmount(hist, mKey, live));
      });
      // Balance for a month with NO sentLog entry (unpaid) — still needed by views.
      const emBal = monthBalances[emNow] || calcMonthBalance(null, getExpectedAmount(hist, mkNow, live));
      return {
        ...t,
        creditBalance: getCreditBalance(d, tid),
        totalDebt:     calcTotalDebt(d, tid, mkNow),
        effectiveAmount: live,        // resolved customAmount || config.amount || 300
        monthBalances,                // { hebMonth: {status, paidAmount, expected, shortfall, credit} }
        currentBalance: emBal         // balance for the ACTIVE month (em)
      };
    });
  }
  res.json(d);
});

// ── עדכון sentLog key בודד — ללא סנכרון paymentHistory ──────────────
// להשתמש בזה במקום POST /api/data כשרוצים רק לעדכן/למחוק key ספציפי
// (markPaid, markUnpaid, resetSent, sendOne — לא bank import)
app.post('/api/sentlog-key', authMiddleware, (req, res) => {
  const { key, value } = req.body; // value=null → מחיקה
  if (!key) return res.json({ ok: false, error: 'חסר key' });
  const d = loadTenantData(req.user.tenantId);
  if (!d.sentLog) d.sentLog = {};
  if (!d.paymentHistory) d.paymentHistory = {};

  // ⚠️ v2.13.14 — this endpoint MUST keep paymentHistory in sync with sentLog.
  // Previously it wrote ONLY sentLog, which caused two bugs:
  //   • markPaid → sentLog set, but no paymentHistory record → the frozen tariff
  //     was never (re)written, so a customAmount changed BEFORE marking paid was
  //     ignored and the OLD amount stuck (Tal: 350 fee, but 230 used).
  //   • markUnpaid → sentLog deleted, but the paid paymentHistory record
  //     survived → closeMonthUnpaid on the 1st resurrected the credit/debt.
  // Resolve the tenant + Hebrew month → monthKey so we can record/clear properly.
  const lastSep = String(key).lastIndexOf('_');
  const tenantId = lastSep >= 0 ? String(key).slice(0, lastSep) : null;
  const hebMonth = lastSep >= 0 ? String(key).slice(lastSep + 1) : null;
  const monthIdx = hebMonth ? HEBREW_MONTHS.indexOf(hebMonth) : -1;
  const tenant = tenantId ? (d.tenants || []).find(t => String(t.id) === tenantId) : null;
  const monthKey = monthIdx >= 0
    ? (String(getMonthKey(d.config || {})).split('-')[0] + '-' + String(monthIdx + 1).padStart(2, '0'))
    : null;

  if (value === null || value === undefined) {
    delete d.sentLog[key];
    // Keep paymentHistory consistent: drop the matching PAID record so a manual
    // "unmark" cannot be resurrected by closeMonthUnpaid. (Do NOT touch a
    // wa_sent-only record — there was no payment to remove.)
    if (tenantId && monthKey && d.paymentHistory[tenantId]) {
      d.paymentHistory[tenantId] = d.paymentHistory[tenantId].filter(
        r => !(r.month === monthKey && (r.type === 'manual' || r.type === 'bank'))
      );
    }
    saveTenantData(req.user.tenantId, { sentLog: d.sentLog, paymentHistory: d.paymentHistory });
    return res.json({ ok: true });
  }

  // אם כבר קיים manual_paid או bank_import — לא דורסים את ה-sentLog
  const existing = String(d.sentLog[key] || '');
  if (existing.startsWith('manual_paid') || existing.startsWith('bank_import')) {
    return res.json({ ok: true, skipped: true });
  }
  d.sentLog[key] = value;

  // If this write is an actual PAYMENT (manual mark), freeze the CURRENT tariff
  // now — approach A: the amount owed is decided at payment time, not at the
  // time an earlier reminder was sent. recordPayment overwrites any stale record
  // for this month, so a customAmount changed before marking paid takes effect.
  if (String(value).startsWith('manual_paid') && tenant && monthKey) {
    const liveAmount = tenant.customAmount || (d.config && d.config.amount) || 300;
    const amtMatch = String(value).match(/_amount_([\d.]+)/);
    const paidAmount = amtMatch ? parseFloat(amtMatch[1]) : liveAmount;
    recordPayment(d, tenantId, monthKey, 'manual', liveAmount, tenant.name, '', paidAmount);
    saveTenantData(req.user.tenantId, { sentLog: d.sentLog, paymentHistory: d.paymentHistory });
    return res.json({ ok: true });
  }

  saveTenantData(req.user.tenantId, { sentLog: d.sentLog });
  res.json({ ok: true });
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
    // ⚠️ Record each payment against the month named IN ITS OWN sentLog key,
    // NOT against `mk` (current month / bankMonthOverride). The old code used `mk`
    // for every entry, so a stray old bank_import value present anywhere in the
    // posted sentLog would be re-recorded as paid:true for the CURRENT month —
    // this is exactly what wrote the bogus June record for tenant "תמי" (see SKILL
    // "sentLog/paymentHistory divergence"). The sentLog key is `tenantId_<hebMonth>`.
    // Year is taken from `mk` (approach A) — ⚠️ NOT year-boundary safe (importing a
    // December file in January mis-years it). Documented in SKILL for a future fix.
    const mkYear = String(mk).split('-')[0];
    Object.entries(req.body.sentLog).forEach(([key, val]) => {
      if (!val) return;
      if (key.includes('__acc__')) return; // extra accounts handled by the dedicated import path
      // Derive tenantId + month from the key end (month name has no '_', so split from the last '_').
      const lastSep = key.lastIndexOf('_');
      if (lastSep < 0) return;
      const tenantId = key.slice(0, lastSep);
      const hebMonth = key.slice(lastSep + 1);
      const monthIdx = HEBREW_MONTHS.indexOf(hebMonth);
      if (monthIdx < 0) return; // unexpected key (e.g. legacy ISO key like _2026-04) — leave untouched
      const keyMonthKey = mkYear + '-' + String(monthIdx + 1).padStart(2, '0');
      const tenant = tenants.find(t => String(t.id) === tenantId);
      if (!tenant) return;
      const amount = tenant.customAmount || (config.amount || 300);
      let type = null;
      let payerName = '';
      let paidAmount = null;
      if (String(val).startsWith('manual_paid')) {
        type = 'manual';
        // Extract paidAmount stored as: manual_paid_TIMESTAMP_amount_XXX
        const amtMatch = String(val).match(/_amount_([\d.]+)/);
        if (amtMatch) paidAmount = parseFloat(amtMatch[1]);
      } else if (String(val).startsWith('bank_import')) {
        type = 'bank';
        // Extract payer name stored as: bank_import_..._amount_payer_NAME
        const payerMatch = String(val).match(/_payer_(.+)$/);
        if (payerMatch) payerName = payerMatch[1];
        // Extract paid amount: bank_import_TIMESTAMP_AMOUNT_payer_...
        const bankAmtMatch = String(val).match(/bank_import_[^_]+_([\d.]+)_/);
        if (bankAmtMatch) paidAmount = parseFloat(bankAmtMatch[1]);
      }
      if (type) recordPayment(current, tenantId, keyMonthKey, type, amount, tenant.name, payerName, paidAmount);
    });
    req.body.paymentHistory = current.paymentHistory;
    delete req.body.bankMonthOverride; // don't save this field to tenant data
  }
  const merged = saveTenantData(req.user.tenantId, req.body);
  res.json({ ok: true, effectiveMonth: getEffectiveMonth(merged.config), data: merged });
});

// Backup Layer 2 — manual / pre-restore snapshot trigger.
// Called by the frontend (restoreData) BEFORE a manual restore overwrites data,
// so an accidental restore from a wrong/old file is itself recoverable.
// System-wide snapshot (not per-tenant) — same artifact as the daily cron.
app.post('/api/backup-now', authMiddleware, (req, res) => {
  const reason = (req.body && req.body.reason === 'pre-restore') ? 'pre-restore' : 'manual';
  const p = createBackup(reason);
  res.json({ ok: !!p, file: p ? path.basename(p) : null });
});

// Init WhatsApp — server mode: start Baileys, return QR / status
app.post('/api/wa/init', authMiddleware, (req, res) => {
  const { tenantId } = req.user;
  const wa = getWa(tenantId);
  console.log(`[wa/init] mode=${WA_MODE} tenantId=${tenantId} status=${wa.status}`);

  if (WA_MODE === 'server') {
    if (!wa.client && !wa.restarting && wa.status !== 'qr') {
      console.log(`[wa/init] starting Baileys for ${tenantId}`);
      initWa(tenantId);
    }
    const outStatus = wa.restarting ? 'reconnecting'
                    : (wa.status === 'qr_expired' ? 'reconnecting' : wa.status);
    return res.json({ ok: true, status: outStatus, qrDataUrl: wa.qrData });
  }

  if (WA_MODE === 'cloud') {
    return res.json({ ok: true, status: wa.status, qrDataUrl: wa.qrData });
  }

  // WA_MODE === 'local' (legacy)
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

// ─────────────────────────────────────────────────────────────────────────────
// buildAccountsBlock(d, tenant, month) — SINGLE source of truth for the {חשבונות}
// block. Replaces the 3 duplicated copies (send / send-all / AutoSend).
// Returns: { block, recipients }
//   block      — the '\n'-prefixed accounts text (or '' when none open), IDENTICAL
//                 byte-for-byte to the old code when no openingDebt and no payer.
//   recipients — Map<payerPhone, [accLabels]> for future per-payer routing (שלב 1
//                 surfaces the data; actual split-send is OUT of scope). Reminder is
//                 still sent to the tenant's main phone in this stage.
// ─────────────────────────────────────────────────
// LABELS / getLabels(config) / t(labels, key) — שלב 2 (Neve Yam)
// SINGLE source of truth for visible terminology. Same principle as
// buildAccountsBlock: server AND frontend (app.html) mirror the SAME LABELS
// + the SAME staged fallback, so there is zero drift between UI / email / PDF.
//
// Layers: (A) LABELS global hardcoded, language-keyed, two base sets (vaad/kibbutz).
//         (B) config.orgType ('vaad' default | 'kibbutz')  — per-customer choice.
//         (C) config.labelOverrides[lang][key]             — per-customer override.
//
// t(labels, key) staged fallback (never empty):
//   labelOverrides[lang][key] ?? LABELS[lang][orgType][key] ?? LABELS['he']['vaad'][key]
//
// ⚠ DEFAULT RULE: orgType missing → 'vaad' → overrides empty → t() returns the
//   EXISTING strings → an existing vaad customer sees ZERO change (byte-identical).
// Minimal key set this stage: org / person / persons / unit / body.
// ──────────────────────────────────────────────────
const LABELS = {
  he: {
    vaad: {
      org:     'ועד הבית',
      person:  'דייר',
      persons: 'דיירים',
      unit:    'דירה',
      body:    'ועד הבית'
    },
    kibbutz: {
      org:     'קיבוץ',
      person:  'חבר',
      persons: 'חברים',
      unit:    'בית/נכס',
      body:    'הנהלת הקיבוץ'
    }
  }
};
const LABEL_LANG = 'he'; // שלב 2: he בלבד. המבנה מוכן לשפות נוספות בלי שינוי מבנה.

// getLabels(config) → flat { key: value } for the customer's orgType, overrides applied.
function getLabels(config) {
  config = config || {};
  const orgType = (config.orgType === 'kibbutz') ? 'kibbutz' : 'vaad';
  const lang = LABEL_LANG;
  const base = (LABELS[lang] && LABELS[lang][orgType]) || LABELS.he.vaad;
  const fallback = LABELS.he.vaad;
  const ov = (config.labelOverrides && config.labelOverrides[lang]) || {};
  const out = {};
  Object.keys(fallback).forEach(function (k) {
    const o = ov[k];
    out[k] = (o != null && String(o).trim() !== '') ? String(o)
           : (base[k] != null ? base[k] : fallback[k]);
  });
  return out;
}

// t(labels, key) — single label lookup off a computed labels object.
function t(labels, key) {
  if (labels && labels[key] != null) return labels[key];
  return (LABELS.he.vaad[key] != null) ? LABELS.he.vaad[key] : key;
}

// Phone resolution per account uses staged fallback:
//   payer-slot phone → owner phone → tenant phone → main tenant.phone
// ─────────────────────────────────────────────────────────────────────────────
function resolvePayerPhone(tenant, acc) {
  const payer = acc && acc.payer; // 'owner' | 'tenant' | undefined
  const owner  = tenant.owner  || {};
  const renter = tenant.tenant || {};
  if (payer === 'owner'  && String(owner.phone  || '').trim()) return String(owner.phone).trim();
  if (payer === 'tenant' && String(renter.phone || '').trim()) return String(renter.phone).trim();
  // staged fallback: owner → tenant → main
  if (String(owner.phone  || '').trim()) return String(owner.phone).trim();
  if (String(renter.phone || '').trim()) return String(renter.phone).trim();
  return String(tenant.phone || '').trim();
}

function buildAccountsBlock(d, tenant, month) {
  const sentLog = d.sentLog || {};
  const extraAccounts = (tenant.extraAccounts || []).filter(a => a.active !== false);
  const recipients = {};
  if (!extraAccounts.length) return { block: '', recipients };

  const lines = extraAccounts.map(acc => {
    const slKey = String(tenant.id) + '__acc__' + acc.id + '_' + month;
    const lv = String(sentLog[slKey] || '');
    const paid = lv.startsWith('manual_paid') || lv.startsWith('bank_import');
    if (paid) return null;

    const amount = parseFloat(acc.amount) || 0;
    const openingDebt = Math.max(0, parseFloat(acc.openingDebt) || 0);
    let line;
    if (openingDebt > 0) {
      const total = Math.round((amount + openingDebt) * 100) / 100;
      line = `• ${acc.label}: *${amount} ₪* + חוב קודם ${openingDebt} ₪ = *${total} ₪*`;
    } else {
      line = `• ${acc.label}: *${amount} ₪*`;
    }

    // track intended recipient (data only — no split-send in שלב 1)
    const phone = resolvePayerPhone(tenant, acc);
    if (phone) {
      if (!recipients[phone]) recipients[phone] = [];
      recipients[phone].push(acc.label);
    }
    return line;
  }).filter(Boolean);

  const block = lines.length ? '\n' + lines.join('\n') : '';
  return { block, recipients };
}

// Send to single tenant
app.post('/api/send/:id', authMiddleware, async (req, res) => {
  const d      = loadTenantData(req.user.tenantId);
  const tenant = d.tenants.find(t => String(t.id) === req.params.id);
  if (!tenant) return res.json({ ok: false, error: 'דייר לא נמצא' });
  const month  = getEffectiveMonth(d.config);
  const globalAmount = (d.config||{}).amount || 300;
  const amount = tenant.customAmount || globalAmount;
  const tmpl   = (d.config||{}).template || 'שלום {שם}!\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה!';
  const mk     = getMonthKey(d.config);
  const debt   = calcTotalDebt(d, tenant.id, mk);
  const total  = amount + debt;
  // בנה רשימת חשבונות נוספים פתוחים (helper יחיד — מקור אמת אחד)
  const { block: accountsBlock } = buildAccountsBlock(d, tenant, month);
  const portalUrl1 = tmpl.includes('{לינק_פורטל}')
    ? getOrCreatePortalUrl(req.user.tenantId, tenant.id, tenant.name)
    : '';
  const msg    = tmpl
    .replace(/{שם}/g, tenant.name)
    .replace(/{חודש}/g, month)
    .replace(/{סכום}/g, amount)
    .replace(/{חוב_קודם}/g, debt > 0 ? debt : '')
    .replace(/{סה"כ}/g, debt > 0 ? total : amount)
    .replace(/{חשבונות}/g, accountsBlock)
    .replace(/{לינק_פורטל}/g, portalUrl1);
  try {
    await sendWaMsg(req.user.tenantId, tenant.phone, msg);
    const key = tenant.id+'_'+month;
    // אל תדרוס תשלום קיים (bank_import / manual_paid) עם תזכורת WA
    const existingVal = String(d.sentLog[key] || '');
    if (!existingVal.startsWith('manual_paid') && !existingVal.startsWith('bank_import')) {
      d.sentLog[key] = 'sent_'+new Date().toISOString();
    }
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
    const debt   = calcTotalDebt(d, tenant.id, mk);
    const total  = amount + debt;
    // בנה רשימת חשבונות נוספים פתוחים (helper יחיד — מקור אמת אחד)
    const { block: accountsBlock } = buildAccountsBlock(d, tenant, month);
    const portalUrlSA = tmpl.includes('{לינק_פורטל}')
      ? getOrCreatePortalUrl(req.user.tenantId, tenant.id, tenant.name)
      : '';
    const msg = tmpl
      .replace(/{שם}/g, tenant.name)
      .replace(/{חודש}/g, month)
      .replace(/{סכום}/g, amount)
      .replace(/{חוב_קודם}/g, debt > 0 ? debt : '')
      .replace(/{סה"כ}/g, debt > 0 ? total : amount)
      .replace(/{חשבונות}/g, accountsBlock)
      .replace(/{לינק_פורטל}/g, portalUrlSA);
    try {
      await sendWaMsg(req.user.tenantId, tenant.phone, msg);
      const saKey = tenant.id+'_'+month;
      const saExisting = String(d.sentLog[saKey] || '');
      if (!saExisting.startsWith('manual_paid') && !saExisting.startsWith('bank_import')) {
        d.sentLog[saKey] = 'sent_'+new Date().toISOString();
      }
      recordPayment(d, String(tenant.id), mk, 'wa_sent', amount, tenant.name);
      sent++;
      await new Promise(r=>setTimeout(r,1200));
    }
    catch(e) { console.error(`[send-all:${req.user.tenantId}]`, tenant.name, e.message); }
  }
  saveTenantData(req.user.tenantId, { sentLog: d.sentLog, paymentHistory: d.paymentHistory });
  res.json({ ok: true, sent });
});

// Manual resend-auto: same logic as cron, triggered from settings UI
app.post('/api/resend-auto', authMiddleware, async (req, res) => {
  try {
    const users = loadUsers();
    const user = users.find(u => u.tenantId === req.user.tenantId);
    if (!user) return res.json({ ok: false, error: 'user not found' });
    const result = await doAutoSend(user);
    res.json({ ok: true, sent: result.sent, month: result.month });
  } catch(e) {
    console.error('[resend-auto]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Generic send message
app.post('/api/send-message', authMiddleware, async (req, res) => {
  const { phone, message, tenantName } = req.body;
  if (!phone || !message) return res.json({ ok: false, error: 'חסר מידע' });
  try {
    await sendWaMsg(req.user.tenantId, phone, message);
    res.json({ ok: true });
  } catch(e) {
    const isDisconnected = e.message && (e.message.includes('מנותק') || e.message.includes('not connected') || e.message.includes('socket'));
    const displayError = isDisconnected
      ? (tenantName ? `ההודעה לא נשלחה ל${tenantName} — WhatsApp מנותק. לחץ "חיבור WhatsApp" וסרוק ברקוד.` : 'WhatsApp מנותק — לחץ "חיבור WhatsApp" וסרוק ברקוד.')
      : e.message;
    res.json({ ok: false, error: displayError, disconnected: isDisconnected });
  }
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
// ── תיקון נתונים: מחק רשומות paymentHistory שגויות לחודש ספציפי (של הלקוח המחובר בלבד) ──
// תיקון נתונים — שני מצבים:
//   mode='inconsistent' (מומלץ, ברירת מחדל): מוחק רק רשומות paymentHistory
//        ש"שולם" אבל סותרות את sentLog (מקור האמת). פותר בדיוק את התקלה של
//        קובץ בנק ישן שכתב paid:true בלי שsentLog עודכן. רשומות תקינות נשמרות.
//   mode='all' (ההתנהגות הישנה): מוחק את כל רשומות החודש — גס, משאיר לתאימות לאחור.
// dryRun=true: רק מדווח מה היה נמחק, בלי לשמור — לתצוגה למשתמש לפני אישור.
//
// המפתחות ב-paymentHistory הם או tenantId רגיל או '<tenantId>__acc__<accId>'
// לחשבונות נוספים. החודש ב-sentLog הוא שם החודש העברי, ולא YYYY-MM, ולכן
// משווים מול שם החודש הנגזר מ-config של אותו חודש.
app.post('/api/fix-payment-history', authMiddleware, (req, res) => {
  const { month } = req.body;
  const mode   = req.body.mode === 'all' ? 'all' : 'inconsistent';
  const dryRun = req.body.dryRun === true;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.json({ ok: false, error: 'חסר month תקין (YYYY-MM)' });
  try {
    const d = loadTenantData(req.user.tenantId);
    if (!d.paymentHistory) return res.json({ ok: true, fixed: 0, removed: [], message: 'אין paymentHistory' });

    const sentLog = d.sentLog || {};
    // שם החודש העברי עבור החודש שנבחר (sentLog ממופתח בשם חודש, לא ב-YYYY-MM)
    const [yy, mm] = month.split('-').map(Number);
    const HEB_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const hebMonthName = HEB_MONTHS[mm - 1];

    // האם sentLog אומר ש"שולם" עבור tenantId נתון בחודש הזה?
    const sentSaysPaid = (tenantId) => {
      const v = sentLog[tenantId + '_' + hebMonthName];
      if (!v) return false;
      const s = String(v);
      return s.startsWith('manual_paid') || s.startsWith('bank_import');
    };

    const removed = [];   // לתיעוד/תצוגה: מה נמחק (או יימחק ב-dry-run)
    let fixed = 0;

    Object.keys(d.paymentHistory).forEach(key => {
      // הוצא את ה-tenantId הבסיסי גם ממפתח של חשבון נוסף
      const baseTenantId = key.split('__acc__')[0];
      const tenant = (d.tenants || []).find(t => String(t.id) === String(baseTenantId));
      const tenantName = tenant ? tenant.name : baseTenantId;

      const before = d.paymentHistory[key].length;
      d.paymentHistory[key] = d.paymentHistory[key].filter(r => {
        if (r.month !== month) return true; // חודש אחר — לא נוגעים
        if (mode === 'all') {
          // התנהגות ישנה: מחק את כל רשומות החודש
          removed.push({ tenant: tenantName, key, paid: r.paid, amount: r.amount, type: r.type, reason: 'all' });
          return false;
        }
        // mode='inconsistent': מחק רק אם הרשומה "שולם" אך sentLog לא מאשר
        const recordSaysPaid = r.paid === true;
        if (recordSaysPaid && !sentSaysPaid(baseTenantId)) {
          removed.push({ tenant: tenantName, key, paid: r.paid, amount: r.amount, type: r.type, reason: 'sentLog לא מאשר תשלום' });
          return false; // מוחק את הרשומה הסותרת
        }
        return true; // רשומה תקינה (תואמת sentLog, או רשומת "לא שולם") — נשמרת
      });
      fixed += before - d.paymentHistory[key].length;
    });

    if (dryRun) {
      return res.json({
        ok: true, dryRun: true, fixed, removed,
        message: fixed > 0
          ? `נמצאו ${fixed} רשומות שגויות ל-${month}` +
            (mode === 'inconsistent' ? ' (סותרות את sentLog)' : '')
          : `לא נמצאו רשומות למחיקה ל-${month}`
      });
    }

    if (fixed > 0) saveTenantData(req.user.tenantId, { paymentHistory: d.paymentHistory });
    res.json({
      ok: true, fixed, removed,
      message: fixed > 0 ? `נמחקו ${fixed} רשומות שגויות ל-${month}` : `לא נמצאו רשומות למחיקה ל-${month}`
    });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

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

  // בניין snapshot — רק ללקוחות (tenantId קיים ב-_users)
  let buildingSnapshot = null;
  const users = loadUsers();
  const user = users.find(u => u.tenantId === req.params.id);
  if (user) {
    const td = loadTenantData(user.tenantId);
    const tenants = td.tenants || [];
    const numTenants = tenants.length;
    // ספור חשבונות: כל דייר = 1 (חשבון ראשי) + extraAccounts שלו
    const totalAccounts = tenants.reduce((sum, t) => sum + 1 + (t.extraAccounts ? t.extraAccounts.length : 0), 0);
    const avgAccountsPerTenant = numTenants > 0 ? Math.round((totalAccounts / numTenants) * 10) / 10 : 0;
    // BankAgent — השתמש בנתוני הריצה האחרונה
    const lastBankSync = td.lastBankSyncImport || null;
    // WhatsApp bridge
    const waStatus = waClients[user.tenantId] ? waClients[user.tenantId].status : null;
    // Clearing house — placeholder לעתיד
    const clearingHouse = user.clearingHouse || null;

    buildingSnapshot = {
      numTenants,
      totalAccounts,
      avgAccountsPerTenant,
      lastBankSync,
      waStatus,
      clearingHouse,
      plan: user.plan,
      createdAt: user.createdAt,
      billing: user.billing || null,
      email: user.email
    };
  }

  res.json({ ok: true, card, msgHistory: log, buildingSnapshot });
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
  const { oldEmail, newEmail, fullName, phone, buildingName, address, password, billing } = req.body;
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
  // billing info (SaaS-level payment tracking)
  if (billing !== undefined) {
    users[idx].billing = billing;
  }
  saveUsers(users);
  res.json({ ok: true });
});

// ── Stage 2: Super-Admin label-override editor ──────────────────────────────
// Reads/writes config.orgType + config.labelOverrides for a customer's tenant
// data file (by email). Writes merge into the EXISTING config (saveTenantData does
// a top-level Object.assign, so we load → merge config → save the whole config).
app.get('/api/admin/labels/:email', superAdminMiddleware, (req, res) => {
  const users = loadUsers();
  const user  = users.find(u => u.email === String(req.params.email || '').toLowerCase());
  if (!user) return res.json({ ok: false, error: 'לקוח לא נמצא' });
  const d = loadTenantData(user.tenantId);
  const cfg = d.config || {};
  res.json({
    ok: true,
    orgType: (cfg.orgType === 'kibbutz') ? 'kibbutz' : 'vaad',
    labelOverrides: cfg.labelOverrides || {},
    labels: getLabels(cfg),
    baseSets: LABELS.he
  });
});

app.post('/api/admin/labels/:email', superAdminMiddleware, (req, res) => {
  const users = loadUsers();
  const user  = users.find(u => u.email === String(req.params.email || '').toLowerCase());
  if (!user) return res.json({ ok: false, error: 'לקוח לא נמצא' });
  const { orgType, labelOverrides } = req.body || {};
  const d = loadTenantData(user.tenantId);
  const cfg = Object.assign({}, d.config || {});
  if (orgType === 'vaad' || orgType === 'kibbutz') cfg.orgType = orgType;
  if (labelOverrides && typeof labelOverrides === 'object') {
    // sanitize: keep only known keys under he, drop empties
    const he = {};
    const allowed = Object.keys(LABELS.he.vaad);
    const src = labelOverrides.he || {};
    allowed.forEach(function (k) {
      if (src[k] != null && String(src[k]).trim() !== '') he[k] = String(src[k]).trim();
    });
    cfg.labelOverrides = Object.keys(he).length ? { he: he } : {};
  }
  saveTenantData(user.tenantId, { config: cfg });
  res.json({ ok: true, labels: getLabels(cfg) });
});

// ── Admin: מחיקת לקוח ───────────────────────────────────────────
app.post('/api/admin/delete-customer', superAdminMiddleware, (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ ok: false, error: 'חסר אימייל' });
  let users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'לקוח לא נמצא' });
  // סגור Baileys session ושחרר RAM לפני מחיקת הנתונים
  const { tenantId } = user;
  // סמן כמחוק — חוסם reconnect מושהה (setTimeout) ו-reconnect בעליית שרת
  deletedTenants.add(tenantId);
  const wa = waClients[tenantId];
  if (wa) {
    stopQrWatch(wa);
    // logout אמיתי מנתק את ה-device אצל WhatsApp (end() לבד משאיר חיבור חי שמתחבר מחדש)
    if (wa.client) {
      try { wa.client.logout(); } catch(e) {
        try { wa.client.end(undefined); } catch(e2) {}
      }
    }
    delete waClients[tenantId];
    console.log(`[delete-customer] WA session logged out and freed for ${tenantId}`);
  }
  // מחק קובץ נתוני הבניין
  const tf = tenantFile(tenantId);
  if (fs.existsSync(tf)) fs.unlinkSync(tf);
  // מחק תיקיית WA session מהדיסק
  const sessionDir = path.join(WA_SESSIONS_DIR, tenantId);
  if (fs.existsSync(sessionDir)) {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e) {}
    console.log(`[delete-customer] WA session dir deleted for ${tenantId}`);
  }
  // ניקוי חוזר מושהה — logout הוא אסינכרוני ועלול לכתוב מחדש creds.json אחרי המחיקה
  setTimeout(() => {
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`[delete-customer] WA session dir re-cleaned for ${tenantId}`);
      }
    } catch(e) {}
  }, 8000);
  // הסר מרשימת המשתמשים
  users = users.filter(u => u.email !== email.toLowerCase());
  saveUsers(users);
  res.json({ ok: true });
});

// ── Admin: זיהוי וניקוי sessions יתומים (WA session בלי user) ──────
// GET = רשימה בלבד (preview). POST = מנתק, מוחק תיקייה ומסיר מהזיכרון.
app.get('/api/admin/orphan-sessions', superAdminMiddleware, (req, res) => {
  const users = loadUsers();
  const validIds = new Set(users.map(u => u.tenantId));
  const orphans = [];
  // sessions על הדיסק
  let dirs = [];
  try { dirs = fs.readdirSync(WA_SESSIONS_DIR); } catch(e) {}
  dirs.forEach(d => {
    try {
      const sd = path.join(WA_SESSIONS_DIR, d);
      if (!fs.statSync(sd).isDirectory()) return;
      if (!validIds.has(d)) {
        const wa = waClients[d];
        orphans.push({ tenantId: d, onDisk: true, inMemory: !!wa, status: wa ? wa.status : null, phone: wa ? wa.phone : null });
      }
    } catch(e) {}
  });
  // sessions בזיכרון בלבד (בלי תיקייה)
  Object.keys(waClients).forEach(tid => {
    if (!validIds.has(tid) && !orphans.find(o => o.tenantId === tid)) {
      orphans.push({ tenantId: tid, onDisk: false, inMemory: true, status: waClients[tid].status, phone: waClients[tid].phone });
    }
  });
  res.json({ ok: true, count: orphans.length, orphans });
});

app.post('/api/admin/orphan-sessions/clean', superAdminMiddleware, (req, res) => {
  const users = loadUsers();
  const validIds = new Set(users.map(u => u.tenantId));
  const { tenantId } = req.body; // אופציונלי — ניקוי ספציפי; בלעדיו מנקה את כל היתומים
  const cleaned = [];
  const targets = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(WA_SESSIONS_DIR); } catch(e) {}
  dirs.forEach(d => { if (!validIds.has(d)) targets.add(d); });
  Object.keys(waClients).forEach(tid => { if (!validIds.has(tid)) targets.add(tid); });
  targets.forEach(tid => {
    if (tenantId && tid !== tenantId) return;
    deletedTenants.add(tid);
    const wa = waClients[tid];
    if (wa) {
      stopQrWatch(wa);
      if (wa.client) { try { wa.client.logout(); } catch(e) { try { wa.client.end(undefined); } catch(e2) {} } }
      delete waClients[tid];
    }
    const sd = path.join(WA_SESSIONS_DIR, tid);
    try { if (fs.existsSync(sd)) fs.rmSync(sd, { recursive: true, force: true }); } catch(e) {}
    setTimeout(() => { try { if (fs.existsSync(sd)) fs.rmSync(sd, { recursive: true, force: true }); } catch(e) {} }, 8000);
    cleaned.push(tid);
    console.log(`[orphan-clean] removed orphan session ${tid}`);
  });
  res.json({ ok: true, cleaned, count: cleaned.length });
});

// ── Admin: הגדרות גיבוי (שכבה 2) — Super Admin בלבד ───────────────
// GET: מחזיר את מספר ימי השמירה הנוכחי + רשימת הגיבויים הקיימים
app.get('/api/admin/backup-settings', superAdminMiddleware, (req, res) => {
  let backups = [];
  try {
    backups = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
      .map(f => {
        const fp = path.join(BACKUPS_DIR, f);
        let size = 0, mtime = null;
        try { const st = fs.statSync(fp); size = st.size; mtime = st.mtime.toISOString(); } catch(e) {}
        return { name: f, sizeKb: Math.round(size / 1024), mtime };
      })
      .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  } catch(e) {}
  const cfg = loadBackupConfig();
  res.json({
    ok: true,
    keepDays: cfg.keepDays,
    emailFreq: cfg.emailFreq,
    lastEmailSent: cfg.lastEmailSent || null,
    adminEmailSet: !!(process.env.ADMIN_EMAIL),
    count: backups.length,
    backups: backups.slice(0, 30)
  });
});

// POST { keepDays?, emailFreq? } — עדכון הגדרות גיבוי (נשמר ל-_backup_config.json, נכנס לתוקף מיד)
app.post('/api/admin/backup-settings', superAdminMiddleware, (req, res) => {
  const { keepDays, emailFreq } = req.body || {};
  const patch = {};
  if (keepDays != null) {
    if (isNaN(parseInt(keepDays, 10))) return res.json({ ok: false, error: 'מספר ימים לא תקין' });
    patch.keepDays = keepDays;
  }
  if (emailFreq != null) {
    if (!['off','daily','weekly','monthly'].includes(emailFreq)) return res.json({ ok: false, error: 'תדירות לא תקינה' });
    patch.emailFreq = emailFreq;
  }
  if (!Object.keys(patch).length) return res.json({ ok: false, error: 'אין מה לעדכן' });
  const cfg = saveBackupConfig(patch);
  console.log(`[Backup] settings updated (keepDays=${cfg.keepDays}, emailFreq=${cfg.emailFreq}) by admin ${req.adminUser && req.adminUser.email}`);
  if (patch.keepDays != null) pruneOldBackups(); // החל מיד — מחק גיבויים שחורגים מהסף החדש
  res.json({ ok: true, keepDays: cfg.keepDays, emailFreq: cfg.emailFreq });
});

// POST — שלח גיבוי off-site עכשיו (בדיקה / כפוי), ללא תלות בתדירות (Super Admin)
app.post('/api/admin/backup-email-now', superAdminMiddleware, async (req, res) => {
  if (!process.env.ADMIN_EMAIL) return res.json({ ok: false, error: 'ADMIN_EMAIL לא מוגדר ב-Railway' });
  if (!RESEND_API_KEY) return res.json({ ok: false, error: 'RESEND_API_KEY לא מוגדר' });
  try {
    const ok = await runOffsiteBackup(true);
    res.json({ ok, error: ok ? null : 'השליחה נכשלה — בדוק לוגים' });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST — צור גיבוי ידני עכשיו (Super Admin)
app.post('/api/admin/backup-now', superAdminMiddleware, (req, res) => {
  const p = createBackup('manual');
  res.json({ ok: !!p, file: p ? path.basename(p) : null });
});

// POST { file } — מחק גיבוי בודד לפי שם (Super Admin)
app.post('/api/admin/backup-delete', superAdminMiddleware, (req, res) => {
  const { file } = req.body || {};
  // ולידציה קפדנית — רק שם קובץ backup-*.zip, ללא נתיבים (מניעת path traversal)
  if (!file || typeof file !== 'string' ||
      file !== path.basename(file) ||           // אסור תווי נתיב
      !/^backup-[a-z-]+-\d[\d_-]*\.zip$/i.test(file)) {
    return res.json({ ok: false, error: 'שם קובץ לא תקין' });
  }
  const fp = path.join(BACKUPS_DIR, file);
  // ודא שהקובץ אכן בתוך BACKUPS_DIR אחרי resolve
  if (path.dirname(fp) !== BACKUPS_DIR || !fs.existsSync(fp)) {
    return res.json({ ok: false, error: 'הגיבוי לא נמצא' });
  }
  try {
    fs.unlinkSync(fp);
    console.log(`[Backup] deleted ${file} by admin ${req.adminUser && req.adminUser.email}`);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: 'מחיקה נכשלה: ' + e.message });
  }
});

// POST — נקה גיבויי startup ישנים (משאיר את האחרון; daily/pre-restore/manual לא נגעים)
app.post('/api/admin/backup-clean-startup', superAdminMiddleware, (req, res) => {
  let removed = 0;
  try {
    const startups = fs.readdirSync(BACKUPS_DIR)
      .filter(f => /^backup-startup-[\d_-]+\.zip$/i.test(f))
      .map(f => {
        const fp = path.join(BACKUPS_DIR, f);
        let mtime = 0; try { mtime = fs.statSync(fp).mtimeMs; } catch(e) {}
        return { f, fp, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // החדש ראשון
    // השאר את גיבוי ה-startup האחרון; מחק את כל השאר
    for (let i = 1; i < startups.length; i++) {
      try { fs.unlinkSync(startups[i].fp); removed++; } catch(e) {}
    }
    if (removed > 0) console.log(`[Backup] cleaned ${removed} old startup backup(s) by admin ${req.adminUser && req.adminUser.email}`);
  } catch(e) {
    return res.json({ ok: false, error: e.message });
  }
  res.json({ ok: true, removed });
});

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
    .map(u => {
      const wa = waClients[u.tenantId];
      let waStatus = 'none';
      if (wa) {
        if (wa.status === 'ready' || wa.status === 'connected') waStatus = 'ready';
        else if (wa.status === 'qr') waStatus = 'qr';
        else if (wa.status === 'qr_expired') waStatus = 'qr_expired';
        else if (wa.status === 'reconnecting') waStatus = 'reconnecting';
        else waStatus = wa.status || 'connecting';
      }
      return {
        email: u.email,
        fullName: u.fullName||'',
        buildingName: u.buildingName||'',
        address: u.address||'',
        buildingPlaceId: u.buildingPlaceId||'',
        phone: u.phone||'',
        createdAt: u.createdAt,
        daysSince: Math.floor((now - new Date(u.createdAt)) / (1000*60*60*24)),
        plan: u.plan,
        trialEnd: u.trialEnd||null,
        maxTenantsOverride: u.maxTenantsOverride||null,
        lastConnectedAt: u.lastConnectedAt||null,
        waStatus,
        installStatus: (statuses[u.email] && statuses[u.email].status) || 'pending'
      };
    })
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

// ── סגירת חודש — רישום דיירים שלא שילמו ───────────────────────
// רץ ב-1 לחודש, כותב paid:false לכל דייר שאין לו רשומה לחודש הקודם.
// לא נוגע ברשומות קיימות — רק מוסיף חסרות.
function closeMonthUnpaid() {
  const now = new Date();
  // חודש קודם כ-YYYY-MM
  const prevDate  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey   = prevDate.getFullYear() + '-' + String(prevDate.getMonth() + 1).padStart(2, '0');
  const prevHebMonth = HEBREW_MONTHS[prevDate.getMonth()]; // שם עברי לחודש הקודם (למפתח sentLog)

  const users = loadUsers();
  let closed = 0;

  for (const user of users) {
    if (!user.tenantId) continue;
    try {
      const d = loadTenantData(user.tenantId);
      if (!d.tenants || !d.tenants.length) continue;
      if (!d.paymentHistory) d.paymentHistory = {};

      let changed = false;

      for (const tenant of d.tenants) {
        const tid = String(tenant.id);
        if (!d.paymentHistory[tid]) d.paymentHistory[tid] = [];

        const amount = parseFloat(tenant.customAmount || (d.config && d.config.amount) || 300);

        // בדוק אם יש רשומה לחודש הקודם
        const existing = d.paymentHistory[tid].find(r => r.month === prevKey);

        if (existing) {
          // רשומה קיימת — אם לא שולמה, צבור ל-openingDebt ומחק את הרשומה
          if (!existing.paid) {
            tenant.openingDebt = Math.round(
              (Math.max(0, parseFloat(tenant.openingDebt) || 0) + amount) * 100
            ) / 100;
            d.paymentHistory[tid] = d.paymentHistory[tid].filter(r => r.month !== prevKey);
            changed = true;
            closed++;
          } else {
            // ⚠️ הרשומה אומרת paid:true — אמת מול sentLog (מקור האמת).
            // אם sentLog של החודש הקודם לא מאשר תשלום (לא bank_import/manual_paid),
            // זו רשומה חשודה כמו מקרה "תמי" (paid:true שנכתב בלי אישור sentLog).
            // מצב שמרני מכוון: רק מזהירים בלוג, לא פועלים אוטומטית — כי מחיקת
            // רשומת paid:true אוטומטית עלולה לחייב שלא בצדק אם קיים מסלול תשלום
            // שכותב paid בלי sentLog. בדיקה/תיקון ידני דרך הכפתור "תקן נתונים".
            const slVal = String((d.sentLog || {})[tid + '_' + prevHebMonth] || '');
            const sentSaysPaid = slVal.startsWith('bank_import') || slVal.startsWith('manual_paid');
            if (!sentSaysPaid) {
              console.warn(`[closeMonthUnpaid] ⚠️ סתירה: דייר ${tenant.name} (${tid}) — paymentHistory אומר שולם ל-${prevKey} אך sentLog[${prevHebMonth}]="${slVal || '(ריק)'}" לא מאשר. לא בוצעה פעולה אוטומטית — בדוק ידנית (כפתור "תקן נתונים").`);
            }
            // שולמה — בדוק אם יש עודף תשלום → יתרה שלילית ב-openingDebt
            const paidAmt = parseFloat(existing.paidAmount ?? existing.amount ?? amount);
            const overpay = Math.round((paidAmt - amount) * 100) / 100;
            if (overpay > 0) {
              // הפחת עודף מ-openingDebt (יכול להפוך שלילי = קרדיט)
              tenant.openingDebt = Math.round(
                ((parseFloat(tenant.openingDebt) || 0) - overpay) * 100
              ) / 100;
              changed = true;
              console.log(`[closeMonthUnpaid] עודף תשלום לדייר ${tenant.name}: ${overpay} ₪ → openingDebt=${tenant.openingDebt}`);
            }
            // אין צורך להסיר רשומה ששולמה — היא כבר paid:true
          }
        } else {
          // אין רשומה כלל — הדייר לא שילם ולא נרשם → צבור ל-openingDebt
          tenant.openingDebt = Math.round(
            (Math.max(0, parseFloat(tenant.openingDebt) || 0) + amount) * 100
          ) / 100;
          changed = true;
          closed++;
        }
      }

      if (changed) {
        saveTenantData(user.tenantId, { tenants: d.tenants, paymentHistory: d.paymentHistory });
      }
    } catch(e) {
      console.error(`[closeMonthUnpaid:${user.tenantId}]`, e.message);
    }
  }

  if (closed > 0) console.log(`[closeMonthUnpaid] נצברו ${closed} חובות לחודש ${prevKey} ל-openingDebt`);
  else console.log(`[closeMonthUnpaid] כל הדיירים שילמו לחודש ${prevKey}`);
}
// ── Cron יומי — בדיקת תחזוקה ───────────────────────────────────
async function runMaintenanceCron() {
  const users = loadUsers();
  const today = new Date();
  today.setHours(0,0,0,0);
  let alertsSent = 0;

  // ב-1 לחודש — סגור את החודש הקודם (רשום מי לא שילם)
  if (today.getDate() === 1) {
    console.log('[runMaintenanceCron] ראשון לחודש — מריץ closeMonthUnpaid');
    closeMonthUnpaid();
  }

  // Backup Layer 2 — daily rolling snapshot of all data files (then prune old)
  createBackup('daily');

  // Backup Layer 3 — off-site email (only if due per admin frequency: off/daily/weekly/monthly)
  runOffsiteBackup(false).catch(e => console.error('[Backup] offsite cron error:', e.message));

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

  // ── תזכורת אישור אסיפות — 5 ימים אחרי שליחת הסיכום ──────────────
  await runMeetingReminderCron();
}

async function runMeetingReminderCron() {
  const users = loadUsers();
  const today = new Date(); today.setHours(0,0,0,0);
  const REMINDER_DAYS = 5;
  let remindersSent = 0;

  for (const user of users) {
    if (!user.tenantId) continue;
    try {
      const meetings = loadMeetings(user.tenantId);
      const d = loadTenantData(user.tenantId);
      const tenants = (d.tenants || []).filter(t => t.active !== false);

      for (const mtg of meetings) {
        if (!mtg.summarySentAt) continue; // סיכום טרם נשלח
        const sentDate = new Date(mtg.summarySentAt); sentDate.setHours(0,0,0,0);
        const daysSince = Math.floor((today - sentDate) / (1000*60*60*24));
        if (daysSince !== REMINDER_DAYS) continue;
        if (mtg.reminderSentAt) continue; // תזכורת כבר נשלחה

        const confirmed = mtg.confirmations || {};
        const unconfirmed = tenants.filter(t => !confirmed[String(t.id)]);
        if (!unconfirmed.length) continue;

        const msg = `📋 תזכורת — אסיפת דיירים ${mtg.date}\n\nטרם אישרת קריאת פרוטוקול האסיפה.\nניתן לאשר דרך פורטל הדיירים.\n\nתודה, ועד הבית`;

        for (const tenant of unconfirmed) {
          try {
            if (tenant.phone) await sendWaMsg(user.tenantId, tenant.phone, msg);
            else if (tenant.email) await sendEmailResend(tenant.email, `תזכורת אישור אסיפת דיירים — ${mtg.date}`, msg.replace(/\n/g,'<br>'));
            remindersSent++;
          } catch(e) {}
        }
        mtg.reminderSentAt = new Date().toISOString();
      }
      saveMeetings(user.tenantId, meetings);
    } catch(e) { console.error(`[MeetingReminder:${user.tenantId}]`, e.message); }
  }
  if (remindersSent > 0) console.log(`[MeetingReminder] נשלחו ${remindersSent} תזכורות אישור אסיפות`);
}

// ── Auto-send cron — runs every minute, checks each tenant's schedule ──
// Helper: execute the actual send logic for a tenant (used by cron + manual resend)
async function doAutoSend(user) {
  const d = loadTenantData(user.tenantId);
  const config = d.config || {};
  const month  = getEffectiveMonth(config);
  const mk     = getMonthKey(config);
  const globalAmount = config.amount || 300;
  const tmpl = config.template || 'שלום {שם}!\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה!';
  let sent = 0;

  for (const tenant of (d.tenants || [])) {
    const key = tenant.id + '_' + month;
    if (d.sentLog[key]) continue; // already paid or reminded — skip
    const amount = tenant.customAmount || globalAmount;
    const debt   = calcTotalDebt(d, tenant.id, mk);
    const total  = amount + debt;
    const portalUrlAuto = tmpl.includes('{לינק_פורטל}')
      ? getOrCreatePortalUrl(user.tenantId, tenant.id, tenant.name)
      : '';
    // extra accounts block (helper יחיד — מקור אמת אחד)
    const { block: accountsBlockAuto } = buildAccountsBlock(d, tenant, month);
    const msg = tmpl
      .replace(/{שם}/g, tenant.name)
      .replace(/{חודש}/g, month)
      .replace(/{סכום}/g, amount)
      .replace(/{חוב_קודם}/g, debt > 0 ? debt : '')
      .replace(/{סה"כ}/g, debt > 0 ? total : amount)
      .replace(/{חשבונות}/g, accountsBlockAuto)
      .replace(/{לינק_פורטל}/g, portalUrlAuto);
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
    // Save lastAutoSend info for UI display
    const nowIso = new Date().toISOString();
    d.config.lastAutoSend = { date: nowIso, sent, month };
    saveTenantData(user.tenantId, { sentLog: d.sentLog, paymentHistory: d.paymentHistory, config: d.config });
    console.log(`[AutoSend] ✅ ${user.email} — sent to ${sent} unpaid tenants for ${month}`);
  } else {
    console.log(`[AutoSend] ${user.email} — no unsent unpaid tenants for ${month}`);
  }
  return { sent, month };
}

async function runAutoSendCron() {
  // Use Israel time (UTC+2 winter / UTC+3 summer) for all schedule comparisons
  const nowUtc = new Date();
  const ilStr = nowUtc.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
  const now = new Date(ilStr);
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

      // Build a Date for the configured send time today
      const scheduledToday = new Date(now);
      scheduledToday.setHours(sendHour, sendMinute, 0, 0);
      const diffMin = (now - scheduledToday) / 60000; // positive = we are past scheduled time

      // Day must match; time window: 0..15 minutes after scheduled time
      if (currentDay !== sendDay)        continue;
      if (diffMin < 0 || diffMin >= 15)  continue;

      // Guard: already auto-sent today? (prevent double-send within the 15-min window)
      const lastAS = config.lastAutoSend || {};
      if (lastAS.date) {
        const lastDate = new Date(lastAS.date);
        if (lastDate.getFullYear() === now.getFullYear() &&
            lastDate.getMonth()    === now.getMonth()    &&
            lastDate.getDate()     === now.getDate()) {
          console.log(`[AutoSend] ${user.email} — already sent today, skipping`);
          continue;
        }
      }

      // Check if there are any unsent tenants
      const month = getEffectiveMonth(config);
      const hasUnsent = (d.tenants || []).some(t => !d.sentLog[t.id + '_' + month]);
      if (!hasUnsent) {
        console.log(`[AutoSend] ${user.email} — all tenants already paid or reminded for ${month}, skipping`);
        continue;
      }

      await doAutoSend(user);
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

// Backup Layer 2 — take a snapshot ~30s after boot (catches missed daily runs
// after a deploy / restart), then the daily cron handles the rest.
setTimeout(() => createBackup('startup'), 30 * 1000);
console.log(`[Backup] Layer 2 active — daily snapshots, keeping ${getBackupKeepDays()} days`);


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
app.get('/vaadpro-start.bat', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="VaadPro-Start.bat"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(VAADPRO_START_BAT);
});

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
      try {
        $ws2 = New-Object -ComObject WScript.Shell
        $s2 = $ws2.CreateShortcut($startupShortcut)
        $s2.TargetPath = $batPath
        $s2.WorkingDirectory = $installDir
        $s2.Description = 'VaadPro Bridge'
        $s2.Save()
      } catch {
        Log ('Startup shortcut skipped (non-ASCII path): ' + $_.Exception.Message)
      }
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
    $desktopPath = [System.Environment]::GetFolderPath('Desktop')
    $shortcutPath = [System.IO.Path]::Combine($desktopPath, 'VaadPro Bridge.lnk')
    try {
      $ws = New-Object -ComObject WScript.Shell
      $s = $ws.CreateShortcut($shortcutPath)
      $s.TargetPath = $batPath
      $s.WorkingDirectory = $installDir
      $s.Description = 'VaadPro Bridge'
      $s.Save()
      Log 'Shortcut created'
    } catch {
      Log ('Desktop shortcut skipped (non-ASCII path): ' + $_.Exception.Message)
      try {
        $fallbackPath = [System.IO.Path]::Combine($desktopPath, 'VaadPro Bridge.bat')
        Set-Content -Path $fallbackPath -Value ('@echo off' + [char]13 + [char]10 + 'cd /d "' + $installDir + '"' + [char]13 + [char]10 + 'start "" "' + $batPath + '"') -Encoding ASCII
        Log 'Fallback .bat shortcut created on Desktop'
      } catch {
        Log ('Fallback shortcut also failed: ' + $_.Exception.Message)
      }
    }

    $status.ForeColor = [System.Drawing.Color]::FromArgb(0, 150, 50)
    $status.Text = 'Installation complete! Starting VaadPro Bridge...'
    $form.Refresh()
    Log 'Installation complete!'
    Start-Sleep -Seconds 2
    $form.Close()
    # Open new CMD with refreshed PATH so Node.js is found
    $bridgeJs = [System.IO.Path]::Combine($installDir, 'bridge.js')
    Start-Process 'cmd' -ArgumentList ('/k node "' + $bridgeJs + '"') -WorkingDirectory $installDir
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

# Start bridge directly
cd "$INSTALL_DIR"
node bridge.js
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

// Serve bridge.js publicly for auto-update in VaadPro-Start.bat
app.get('/api/bridge/bridge-js-public', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="bridge.js"');
  res.setHeader('Content-Type', 'application/javascript');
  res.send(BRIDGE_JS_CONTENT);
});

// Serve bridge.js only (for update without reinstall)
app.get('/api/bridge/bridge-js', authMiddleware, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="bridge.js"');
  res.setHeader('Content-Type', 'application/javascript');
  res.send(BRIDGE_JS_CONTENT);
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

// Helper: קבל/צור portal URL לדייר (לשימוש בשליחת WA)
function getOrCreatePortalUrl(tenantDataId, tenantId, tenantName) {
  const tokens = loadPortalTokens();
  const now = Date.now();
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';
  // נקה פגי תוקף
  Object.keys(tokens).forEach(k => { if (tokens[k].expires < now) delete tokens[k]; });
  // חפש token קיים
  const existing = Object.entries(tokens).find(([, v]) =>
    v.tenantDataId === tenantDataId && v.tenantId === String(tenantId) && v.expires > now
  );
  if (existing) return appUrl + '/tenant-portal.html?token=' + existing[0];
  // צור חדש
  const token = require('uuid').v4().replace(/-/g,'').substring(0,20);
  tokens[token] = {
    tenantDataId,
    tenantId:   String(tenantId),
    tenantName: tenantName || String(tenantId),
    createdAt:  now,
    expires:    now + 365 * 24 * 60 * 60 * 1000
  };
  savePortalTokens(tokens);
  return appUrl + '/tenant-portal.html?token=' + token;
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
    tenantName:   tenant.name || String(tenantId),
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
// GET /api/portal/meetings — tenant views meetings via portal
app.get('/api/portal/meetings', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ ok: false, error: 'חסר token' });
  const tokens = loadPortalTokens();
  const entry  = tokens[token];
  if (!entry || Date.now() > entry.expires) return res.status(401).json({ ok: false, error: 'לינק לא תקין' });
  const meetings = loadMeetings(entry.tenantDataId);
  // Return meetings with confirmation status for this tenant (without other tenants' data)
  const result = meetings.map(m => ({
    id: m.id,
    date: m.date,
    type: m.type,
    attendees: m.attendees,
    protocol: m.protocol,
    decisions: m.decisions,
    createdAt: m.createdAt,
    myConfirmation: (m.confirmations || {})[entry.tenantId] || null
  }));
  res.json({ ok: true, meetings: result });
});

// POST /api/portal/meetings/:id/confirm — tenant confirms meeting
app.post('/api/portal/meetings/:id/confirm', async (req, res) => {
  const { token, type, note } = req.body; // type: 'agree' | 'disagree'
  if (!token) return res.status(401).json({ ok: false });
  const tokens = loadPortalTokens();
  const entry  = tokens[token];
  if (!entry || Date.now() > entry.expires) return res.status(401).json({ ok: false, error: 'לינק לא תקין' });
  const meetings = loadMeetings(entry.tenantDataId);
  const mtg = meetings.find(m => m.id === req.params.id);
  if (!mtg) return res.status(404).json({ ok: false, error: 'אסיפה לא נמצאה' });
  if (!mtg.confirmations) mtg.confirmations = {};
  mtg.confirmations[entry.tenantId] = {
    name: entry.tenantName || entry.tenantId,
    confirmedAt: new Date().toISOString(),
    type: type || 'agree',
    note: note || ''
  };
  saveMeetings(entry.tenantDataId, meetings);

  // אם לא מסכים — שלח התראה לוועד
  if (type === 'disagree') {
    try {
      const d = loadTenantData(entry.tenantDataId);
      const users = loadUsers();
      const user = users.find(u => (u.tenantId || u.id) === entry.tenantDataId);
      const tenantName = entry.tenantName || entry.tenantId;
      const msg = `⚠️ VaadPro — אי-הסכמה לאסיפה\n\nדייר/ת ${tenantName} לא הסכים/ה להחלטות אסיפת ${mtg.date}${note ? '\n\nהערה: ' + note : ''}`;
      if (user && d.config && d.config.vaadPhone) {
        await sendWaMsg(entry.tenantDataId, d.config.vaadPhone, msg);
      } else if (user && user.email) {
        await sendEmailResend(user.email, `אי-הסכמה לאסיפה — ${mtg.date}`, msg.replace(/\n/g,'<br>'));
      }
    } catch(e) { /* התראה נכשלה — לא קריטי */ }
  }

  res.json({ ok: true });
});

// GET /api/meetings/:id/confirmations — ועד רואה מי אישר
app.get('/api/meetings/:id/confirmations', authMiddleware, (req, res) => {
  const meetings = loadMeetings(req.user.tenantId);
  const mtg = meetings.find(m => m.id === req.params.id);
  if (!mtg) return res.status(404).json({ ok: false, error: 'לא נמצא' });
  const d = loadTenantData(req.user.tenantId);
  const tenants = (d.tenants || []).filter(t => t.active !== false);
  const confirmed = mtg.confirmations || {};
  const result = tenants.map(t => ({
    tenantId: String(t.id),
    name: t.name,
    confirmation: confirmed[String(t.id)] || null
  }));
  res.json({ ok: true, confirmations: result, total: tenants.length, confirmedCount: Object.keys(confirmed).length });
});

// ── IMPORTANT: All specific /api/portal/* routes must be declared BEFORE
//    the wildcard GET /api/portal/:token, otherwise Express will match
//    e.g. "tickets" as the :token param and return "לינק לא תקין".

// ── one-time fix: תקן תשלום אפריל לדייר ספציפי ──
app.get('/api/admin/fix-payment', (req, res) => {
  const { token, tenantId, month, paid } = req.query;
  if (!token) return res.status(401).json({ error: 'חסר token' });
  try { jwt.verify(token, JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'token לא תקין' }); }
  const users = loadUsers();
  let fixed = false;
  for (const user of users) {
    if (!user.tenantId) continue;
    try {
      const d = loadTenantData(user.tenantId);
      if (!d.paymentHistory || !d.paymentHistory[tenantId]) continue;
      const rec = d.paymentHistory[tenantId].find(r => r.month === month);
      if (rec) {
        rec.paid = paid !== 'false';
        if (rec.paid && !rec.date) rec.date = '2026-04-29';
        saveTenantData(user.tenantId, { paymentHistory: d.paymentHistory });
        fixed = true;
        break;
      }
    } catch(e) {}
  }
  res.json({ ok: fixed, message: fixed ? `עודכן` : `לא נמצאה רשומה` });
});
// ── one-time fix: מחק רשומות חודש שגויות שנוצרו ע"י BankSync ──
app.get('/api/admin/fix-month', (req, res) => {
  const { token, month } = req.query;
  if (!token) return res.status(401).json({ error: 'חסר token' });
  try { jwt.verify(token, JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'token לא תקין' }); }
  const targetMonth = month || '2026-05';
  const users = loadUsers();
  let fixed = 0;
  for (const user of users) {
    if (!user.tenantId) continue;
    try {
      const d = loadTenantData(user.tenantId);
      if (!d.paymentHistory) continue;
      let changed = false;
      Object.keys(d.paymentHistory).forEach(tid => {
        const before = d.paymentHistory[tid].length;
        d.paymentHistory[tid] = d.paymentHistory[tid].filter(r => r.month !== targetMonth);
        if (d.paymentHistory[tid].length < before) { fixed += before - d.paymentHistory[tid].length; changed = true; }
      });
      if (changed) saveTenantData(user.tenantId, { paymentHistory: d.paymentHistory });
    } catch(e) {}
  }
  res.json({ ok: true, fixed, message: `נמחקו ${fixed} רשומות ${targetMonth}` });
});

app.get('/api/admin/fix-wasent', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'חסר token' });
  try { jwt.verify(token, JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'token לא תקין' }); }
  const users = loadUsers();
  let fixed = 0;
  for (const user of users) {
    if (!user.tenantId) continue;
    try {
      const d = loadTenantData(user.tenantId);
      if (!d.paymentHistory) continue;
      let changed = false;
      Object.keys(d.paymentHistory).forEach(tid => {
        d.paymentHistory[tid].forEach(r => {
          if (r.type === 'wa_sent' && r.paid === true) {
            r.paid = false;
            fixed++;
            changed = true;
          }
        });
      });
      if (changed) saveTenantData(user.tenantId, { paymentHistory: d.paymentHistory });
    } catch(e) {}
  }
  res.json({ ok: true, fixed, message: `תוקנו ${fixed} רשומות wa_sent` });
});

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
  // סנן wa_sent — תזכורות אינן תשלומים ואין להציגן כחוב בפורטל
  const history = ((d.paymentHistory || {})[entry.tenantId] || [])
    .filter(r => r.type !== 'wa_sent')
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

  // ⚠️ Reconcile the current month between the two stores. sentLog is the
  // documented source of truth for the portal's current-month status, but the
  // history list reads `paid` from paymentHistory. These can diverge — e.g. an
  // OLD bank file gets imported, recordPayment writes paid:true into
  // paymentHistory for the current month, yet sentLog for the current month was
  // never set to bank_import. That makes the current month show "ממתין לתשלום"
  // in the card AND "שולם" in the history at the same time.
  // Force the current-month history record to agree with sentLog so the portal
  // never shows two contradictory states for the same month.
  // NOTE: `history` items are still references into d.paymentHistory (filter/slice
  // copy the array, not the objects). Mutating r.paid here is display-only — this
  // is a READ endpoint with no saveTenantData, so nothing persists to disk. Safe,
  // and consistent with the pre-existing current-month mutation below.
  const currentPaidBySentLog = (currentStatus === 'paid');
  for (const r of history) {
    if (r.month === currentMonthKey) {
      r.paid = currentPaidBySentLog;
      if (!currentPaidBySentLog) {
        // Strip stale "paid" metadata so the row renders cleanly as unpaid.
        r.type = currentType || r.type;
        r.amount = r.amount; // keep amount for the unpaid-debt calc
      }
    } else if (r.paid) {
      // ⚠️ Extended reconciliation (Diff 3): historical months too, not just current.
      // A paid:true record with no confirming sentLog entry for that month (the
      // "תמי" case) must NOT paint the month as "שולם" in the portal history.
      // sentLog is the source of truth. Display-only — does not touch the debt calc
      // or disk. (Aggressive here, unlike the conservative closeMonthUnpaid warning,
      // precisely BECAUSE this is display-only and reversible; closeMonthUnpaid writes
      // openingDebt to disk so it only warns. See SKILL.)
      const rm = parseInt(r.month.split('-')[1], 10);
      const rHeb = HEBREW_MONTHS[rm - 1];
      const rSlVal = String((d.sentLog || {})[entry.tenantId + '_' + rHeb] || '');
      const rPaidBySl = rSlVal.startsWith('bank_import') || rSlVal.startsWith('manual_paid');
      if (!rPaidBySl) r.paid = false;
    }
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
    tenant: { name: tenant.name, openingDebt: parseFloat(tenant.openingDebt) || 0, creditBalance: getCreditBalance(d, entry.tenantId),
      extraAccounts: (tenant.extraAccounts || []).map(a => ({
        id: a.id, label: a.label, amount: a.amount, frequency: a.frequency, openingDebt: a.openingDebt || 0, active: a.active !== false
      }))
    },
    building: { name: d.config?.buildingName || '' },
    current: (() => {
      // ⚠️ v2.13.10 — amountDue is computed HERE, server-side, and the portal
      // page renders it verbatim. Previously tenant-portal.html did this math
      // itself and produced "שולם ✅" together with "לתשלום 30 ₪": the surplus
      // was born from THIS month's payment and was then subtracted from this
      // month's own charge again. One source of truth prevents that class of bug.
      const hist   = (d.paymentHistory || {})[entry.tenantId] || [];
      const bal    = calcMonthBalance((d.sentLog || {})[sentKey], getExpectedAmount(hist, currentMonthKey, amount));
      const credit = getCreditBalance(d, entry.tenantId);
      const od     = parseFloat(tenant.openingDebt) || 0;
      // ⚠️ Prior debt = everything owed BEFORE this month. calcTotalDebt already
      // folds in the current month IF it is short-paid (sentLog partial) or IF an
      // unpaid paymentHistory record exists for it — but NOT when the month simply
      // has no record yet. Subtract only what was actually included, or an unpaid
      // month with openingDebt yields priorDebt=0 (caught by test: od=200 → 430).
      const total = calcTotalDebt(d, entry.tenantId, currentMonthKey);
      const currentInTotal =
        (bal.status === 'partial' ? bal.shortfall : 0) +
        (hist.some(r => r.month === currentMonthKey && !r.paid && r.type !== 'wa_sent')
          ? (parseFloat(hist.find(r => r.month === currentMonthKey).amount) || 0) : 0);
      const priorDebt = Math.max(0, total - currentInTotal);
      // The current month is only due if sentLog says it was not fully paid.
      const currentCharge = (bal.status === 'paid') ? 0
                          : (bal.status === 'partial') ? bal.shortfall
                          : amount;
      const amountDue = Math.max(0, currentCharge + priorDebt - credit);
      return {
        monthKey:   currentMonthKey,
        monthLabel: currentMonthName,
        amount,
        status:     currentStatus,
        type:       currentType,
        typeLabel:  typeLabel(currentType),
        payerName:  currentPayerName,
        // ── computed, consume-only ──
        balance:      bal,            // {status,paidAmount,expected,shortfall,credit}
        amountDue:    amountDue,      // what the tenant actually owes right now
        priorDebt:    priorDebt,
        creditBalance: credit,
        openingDebt:  od
      };
    })(),
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
    })),
    extraPaymentHistory: (() => {
      const result = {};
      for (const acc of (tenant.extraAccounts || [])) {
        const phKey = String(entry.tenantId) + '__acc__' + acc.id;
        const recs = ((d.paymentHistory || {})[phKey] || [])
          .sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12);
        // ⚠️ Same reconciliation as the main account (see comment above): the
        // per-account sentLog key is the source of truth for the current month.
        // An old bank import can write paid:true into the account's paymentHistory
        // without the matching sentLog entry — force the current-month record to
        // agree with sentLog so "שולם"/"ממתין" can never contradict each other.
        const accSentKey = phKey + '_' + currentMonthName;
        const accSentVal = String((d.sentLog || {})[accSentKey] || '');
        const accPaidBySentLog = accSentVal.startsWith('manual_paid') || accSentVal.startsWith('bank_import');
        for (const r of recs) {
          if (r.month === currentMonthKey) r.paid = accPaidBySentLog;
        }
        result[acc.id] = recs;
      }
      return result;
    })(),
    // Authoritative current-month paid flag per extra account (from sentLog).
    // The frontend uses THIS — never the raw paymentHistory record — to decide
    // the current-month status badge for each account.
    extraCurrentStatus: (() => {
      const status = {};
      for (const acc of (tenant.extraAccounts || [])) {
        const accSentKey = String(entry.tenantId) + '__acc__' + acc.id + '_' + currentMonthName;
        const v = String((d.sentLog || {})[accSentKey] || '');
        status[acc.id] = (v.startsWith('manual_paid') || v.startsWith('bank_import')) ? 'paid' : 'unpaid';
      }
      return status;
    })(),
    lastBankImport: d.lastBankSyncImport
      ? { timestamp: d.lastBankSyncImport.timestamp, month: d.lastBankSyncImport.month }
      : null
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


// ════════════════════════════════════════════════════════════════════
// MEETINGS API — אסיפות דיירים
// ════════════════════════════════════════════════════════════════════

function meetingsFile(tenantId) {
  return path.join(DATA_DIR, tenantId + '_meetings.json');
}
function loadMeetings(tenantId) {
  const f = meetingsFile(tenantId);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return []; }
}
function saveMeetings(tenantId, meetings) {
  fs.writeFileSync(meetingsFile(tenantId), JSON.stringify(meetings, null, 2));
}
function nextMeetingId(meetings) {
  const nums = meetings.map(m => { const n = parseInt((m.id||'').replace('mtg_','')); return isNaN(n) ? 0 : n; });
  return 'mtg_' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0');
}

// GET /api/meetings
app.get('/api/meetings', authMiddleware, (req, res) => {
  const meetings = loadMeetings(req.user.tenantId);
  res.json({ ok: true, meetings });
});

// POST /api/meetings — create
app.post('/api/meetings', authMiddleware, (req, res) => {
  const { date, type, attendees, protocol, decisions } = req.body;
  if (!date) return res.status(400).json({ ok: false, error: 'תאריך חובה' });
  const meetings = loadMeetings(req.user.tenantId);
  const meeting = {
    id: nextMeetingId(meetings),
    date,
    type: type || 'אסיפה כללית',
    attendees: attendees || [],
    protocol: protocol || '',
    decisions: (decisions || []).map((d, i) => ({
      id: i + 1,
      text: d.text || '',
      dueDate: d.dueDate || '',
      assignee: d.assignee || '',
      status: d.status || 'פתוח'
    })),
    createdAt: new Date().toISOString()
  };
  meetings.unshift(meeting);
  saveMeetings(req.user.tenantId, meetings);
  res.json({ ok: true, meeting });
});

// PUT /api/meetings/:id — update
app.put('/api/meetings/:id', authMiddleware, (req, res) => {
  const meetings = loadMeetings(req.user.tenantId);
  const idx = meetings.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'לא נמצא' });
  const { date, type, attendees, protocol, decisions } = req.body;
  meetings[idx] = {
    ...meetings[idx],
    date: date ?? meetings[idx].date,
    type: type ?? meetings[idx].type,
    attendees: attendees ?? meetings[idx].attendees,
    protocol: protocol ?? meetings[idx].protocol,
    decisions: decisions ? decisions.map((d, i) => ({
      id: d.id || i + 1,
      text: d.text || '',
      dueDate: d.dueDate || '',
      assignee: d.assignee || '',
      status: d.status || 'פתוח'
    })) : meetings[idx].decisions,
    updatedAt: new Date().toISOString()
  };
  saveMeetings(req.user.tenantId, meetings);
  res.json({ ok: true, meeting: meetings[idx] });
});

// PATCH /api/meetings/:id/decision/:decId — update single decision status
app.patch('/api/meetings/:id/decision/:decId', authMiddleware, (req, res) => {
  const meetings = loadMeetings(req.user.tenantId);
  const mtg = meetings.find(m => m.id === req.params.id);
  if (!mtg) return res.status(404).json({ ok: false, error: 'אסיפה לא נמצאה' });
  const dec = (mtg.decisions || []).find(d => String(d.id) === req.params.decId);
  if (!dec) return res.status(404).json({ ok: false, error: 'החלטה לא נמצאה' });
  if (req.body.status) dec.status = req.body.status;
  if (req.body.assignee !== undefined) dec.assignee = req.body.assignee;
  if (req.body.dueDate !== undefined) dec.dueDate = req.body.dueDate;
  saveMeetings(req.user.tenantId, meetings);
  res.json({ ok: true, decision: dec });
});

// DELETE /api/meetings/:id
app.delete('/api/meetings/:id', authMiddleware, (req, res) => {
  let meetings = loadMeetings(req.user.tenantId);
  meetings = meetings.filter(m => m.id !== req.params.id);
  saveMeetings(req.user.tenantId, meetings);
  res.json({ ok: true });
});

// POST /api/meetings/:id/send-summary — שליחה ידנית לדיירים
app.post('/api/meetings/:id/send-summary', authMiddleware, async (req, res) => {
  const { channel } = req.body; // 'whatsapp' | 'email' | 'both'
  const meetings = loadMeetings(req.user.tenantId);
  const mtg = meetings.find(m => m.id === req.params.id);
  if (!mtg) return res.status(404).json({ ok: false, error: 'אסיפה לא נמצאה' });
  const d = loadTenantData(req.user.tenantId);
  const tenants = (d.tenants || []).filter(t => t.active !== false);
  const appUrl = process.env.APP_URL || 'https://vaadpro.org';

  // טען tokens קיימים לכל הדיירים
  const allTokens = loadPortalTokens();
  const now = Date.now();

  // בנה מפה: tenantId → token
  const tokenMap = {};
  Object.entries(allTokens).forEach(([tok, entry]) => {
    if (entry.tenantDataId === req.user.tenantId && entry.expires > now) {
      tokenMap[entry.tenantId] = tok;
    }
  });

  const decisionsText = (mtg.decisions || []).map((dec, i) =>
    `${i+1}. ${dec.text}${dec.dueDate ? ' (יעד: '+dec.dueDate+')' : ''}${dec.assignee ? ' — '+dec.assignee : ''}`
  ).join('\n');

  const results = { whatsapp: 0, email: 0, errors: [] };

  for (const tenant of tenants) {
    try {
      // מצא/צור token לדייר זה
      let tok = tokenMap[String(tenant.id)];
      if (!tok) {
        // אין token קיים — צור חדש
        tok = require('uuid').v4().replace(/-/g,'').substring(0,20);
        allTokens[tok] = {
          tenantDataId: req.user.tenantId,
          tenantId:     String(tenant.id),
          tenantName:   tenant.name || String(tenant.id),
          createdAt:    now,
          expires:      now + 365 * 24 * 60 * 60 * 1000
        };
        tokenMap[String(tenant.id)] = tok;
      }

      const portalLink = `${appUrl}/tenant-portal.html?token=${tok}`;

      const summary =
        `📋 סיכום אסיפת דיירים\n` +
        `תאריך: ${mtg.date}\n` +
        `סוג: ${mtg.type}\n\n` +
        (mtg.protocol ? `📝 פרוטוקול:\n${mtg.protocol}\n\n` : '') +
        (decisionsText ? `✅ החלטות:\n${decisionsText}\n\n` : '') +
        `🔗 לאישור קריאה:\n${portalLink}\n\n` +
        `בברכה, ועד הבית`;

      if ((channel === 'whatsapp' || channel === 'both') && tenant.phone) {
        await sendWaMsg(req.user.tenantId, tenant.phone, summary);
        results.whatsapp++;
      }
      if ((channel === 'email' || channel === 'both') && tenant.email) {
        await sendEmailResend(
          tenant.email,
          `סיכום אסיפת דיירים — ${mtg.date}`,
          summary.replace(/\n/g, '<br>').replace(portalLink, `<a href="${portalLink}">${portalLink}</a>`)
        );
        results.email++;
      }
    } catch(e) { results.errors.push(e.message); }
  }

  // שמור tokens חדשים שנוצרו
  savePortalTokens(allTokens);

  res.json({ ok: true, results });
  // שמור תאריך שליחת הסיכום (לצורך תזכורת אישור אחרי 5 ימים)
  mtg.summarySentAt = new Date().toISOString();
  saveMeetings(req.user.tenantId, meetings);
});

// ── סוף MEETINGS API ──────────────────────────────────────────────


// ── Start ────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════
// BANK SYNC API
// ════════════════════════════════════════════════════════════════════

// ── Multer — memory storage ────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── API key auth middleware ────────────────────────────────────────
function bankSyncAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ ok: false, error: 'Missing x-api-key header' });
  const users = loadUsers();
  const user  = users.find(u => {
    const d = loadTenantData(u.tenantId || u.id);
    return d.config && d.config.bankSyncApiKey === apiKey;
  });
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid API key' });
  req.user = { tenantId: user.tenantId || user.id };
  next();
}

// ── applyPaymentToDebt ─────────────────────────────────────────────
// Applies a payment amount against a tenant's openingDebt first,
// then returns how much (if any) remains as credit for the current month.
// Mutates tenant.openingDebt in-place. Returns { debtReduced, creditForMonth }.
// ⚠️ NO LIVE CALLERS as of Fix #0 (v2.13.15). It was previously called from the
// Agent import path (analyzeBankRowsServer); that call was removed so accrual lives
// ONLY in closeMonthUnpaid. Kept intentionally — the "payment applies to prior debt
// first" logic is needed by the Stage 3/4 partial-payment work. Do NOT re-wire it into
// any import path without re-opening the Agent/manual-divergence question.
function applyPaymentToDebt(tenant, amount) {
  const debt = Math.max(0, parseFloat(tenant.openingDebt) || 0);
  if (debt === 0) return { debtReduced: 0, creditForMonth: amount };
  if (amount >= debt) {
    tenant.openingDebt = 0;
    return { debtReduced: debt, creditForMonth: amount - debt };
  }
  tenant.openingDebt = Math.round((debt - amount) * 100) / 100;
  return { debtReduced: amount, creditForMonth: 0 };
}

// ── analyzeBankRows (server-side port of client logic) ─────────────
function analyzeBankRowsServer(rows, mapping, tenants, sentLog, monthKey, config) {
  const iName   = parseInt(mapping.colName   ?? -1);
  const iAmount = parseInt(mapping.colAmount ?? -1);
  const iDate   = parseInt(mapping.colDate   ?? -1);
  const iNote   = parseInt(mapping.colNote   ?? -1);
  const ta      = mapping.bankAmount ? parseFloat(mapping.bankAmount) : null;
  const tol     = parseFloat(mapping.bankTolerance ?? 5);
  const filterByAmount = ta !== null && !isNaN(ta) && ta > 0;
  const min = filterByAmount ? ta - tol : -Infinity;
  const max = filterByAmount ? ta + tol :  Infinity;

  const dataRows = rows.slice(1);
  const mr = [];

  dataRows.forEach((row, rowIdx) => {
    let matchAmount = null;
    if (iAmount >= 0) {
      const cell = row[iAmount];
      if (cell !== null && cell !== '' && cell !== undefined) {
        const n = parseFloat(String(cell).replace(/[,\s₪]/g, ''));
        if (!isNaN(n) && n > 0) {
          if (filterByAmount) { if (n >= min && n <= max) matchAmount = n; }
          else matchAmount = n;
        }
      }
    } else {
      row.forEach(cell => {
        if (matchAmount !== null || (!cell && cell !== 0)) return;
        const n = parseFloat(String(cell).replace(/[,\s₪]/g, ''));
        if (isNaN(n) || n <= 0 || n < 10 || n > 500000) return;
        if (n >= 1900 && n <= 2100) return;
        if (Number.isInteger(n) && n <= 31) return;
        if (filterByAmount) { if (n >= min && n <= max) matchAmount = n; }
        else matchAmount = n;
      });
    }
    if (matchAmount !== null) {
      mr.push({
        row, amount: matchAmount, rowIdx,
        nameVal: iName >= 0 ? String(row[iName] || '') : row.join(' '),
        dateVal: iDate >= 0 ? String(row[iDate] || '') : '',
      });
    }
  });

  const MONTHS_HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  let em;
  if (monthKey) {
    const [, m] = monthKey.split('-');
    em = MONTHS_HE[parseInt(m) - 1];
  } else {
    // getMonthKey returns YYYY-MM, convert to Hebrew month name
    const mk = getMonthKey(config);
    const [, mm] = mk.split('-');
    em = MONTHS_HE[parseInt(mm) - 1];
  }

  function kwMatches(kws, rt) {
    return kws.some(k => {
      if (!k || k.length < 2) return false;
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(?:^|[\\s,/(-])' + esc + '(?=[\\s,/)-]|$)').test(rt);
    });
  }

  const matched = [], unmatched = [];
  const newSentLog = Object.assign({}, sentLog);
  const newPaymentHistory = {}; // extra accounts payment history additions
  // Deep-clone tenants so we can mutate openingDebt safely
  const updatedTenants = tenants.map(t => Object.assign({}, t));

  updatedTenants.forEach(tenant => {
    const kw = tenant.keywords
      ? tenant.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
      : [];
    const ps = tenant.phone.replace(/\D/g, '').slice(-7);
    const nameParts = tenant.name.trim().toLowerCase().split(/\s+/).filter(p => p.length > 1);
    const seenRowIdx = new Set();
    const tenantMatches = [];

    mr.forEach(m => {
      if (seenRowIdx.has(m.rowIdx)) return;
      const rt = (m.nameVal || m.row.join(' ')).toLowerCase();
      const rtFull = m.row.join(' ').toLowerCase();
      let type = null;
      if (kw.length && kwMatches(kw, rt))                          type = 'keyword';
      if (!type && ps && rtFull.replace(/\D/g,'').includes(ps))   type = 'phone';
      if (!type && nameParts.length >= 2 && nameParts.every(p => rt.includes(p))) type = 'name';
      if (type) { seenRowIdx.add(m.rowIdx); tenantMatches.push({ amount: m.amount, matchType: type, payerName: m.nameVal }); }
    });

    if (tenantMatches.length > 0) {
      const totalAmount = tenantMatches.reduce((s, m) => s + m.amount, 0);
      const payerName   = tenantMatches[0].payerName || '';
      // ── Fix #0 (v2.13.15): do NOT net the payment against openingDebt here. ──
      // Previously this called applyPaymentToDebt(tenant, totalAmount), which mutated
      // tenant.openingDebt at IMPORT time and was persisted to disk (saveTenantData ...
      // tenants: updatedTenants). The MANUAL bank-import path (browser analyzeBankRows
      // -> POST /api/data) never did this — it only sets sentLog. So the same bank file
      // produced different openingDebt depending on the path (Agent vs manual), and the
      // Agent-side netting double-counted once closeMonthUnpaid also accrued the shortfall.
      // Accrual now lives EXCLUSIVELY in closeMonthUnpaid (the single disk-writing debt
      // path), so both import paths are identical: they set sentLog and nothing else.
      // The response shape is unchanged (matched/unmatched/month); the Agent only reads
      // counts + month, never debtReduced.
      // Always mark sentLog on bank match — even if payment only covered old debt.
      // Bug #7 fix: old guard `if (creditForMonth > 0)` caused AutoSend to fire on tenants who already paid.
      newSentLog[tenant.id + '_' + em] = `bank_import_${new Date().toISOString()}_${totalAmount}_payer_${payerName}`;
      matched.push({ tenantId: tenant.id, name: tenant.name, amount: totalAmount, matchType: tenantMatches[0].matchType, debtReduced: false });
    } else {
      unmatched.push({ tenantId: tenant.id, name: tenant.name });
    }

    // ── זיהוי חשבונות נוספים ──────────────────────────────────
    // בודק שורות שלא שויכו לחשבון הראשי — לפי matchKeywords של כל חשבון נוסף
    const extraAccounts = (tenant.extraAccounts || []).filter(a => a.active !== false);
    if (extraAccounts.length) {
      const usedRowIdxForMain = new Set(seenRowIdx); // שורות שכבר שויכו לחשבון הראשי
      extraAccounts.forEach(acc => {
        if (!acc.matchKeywords || !acc.matchKeywords.trim()) return;
        const accKw = acc.matchKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        if (!accKw.length) return;
        // בדוק אם כבר שולם החודש
        const slKey = String(tenant.id) + '__acc__' + acc.id + '_' + em;
        if (newSentLog[slKey] && (
          String(newSentLog[slKey]).startsWith('manual_paid') ||
          String(newSentLog[slKey]).startsWith('bank_import')
        )) return; // כבר שולם
        // חפש שורה מתאימה
        const accMatches = [];
        mr.forEach(m => {
          if (usedRowIdxForMain.has(m.rowIdx)) return; // שורה שכבר שויכה לחשבון ראשי
          const rt = (m.nameVal || m.row.join(' ')).toLowerCase();
          if (kwMatches(accKw, rt)) {
            accMatches.push({ amount: m.amount, payerName: m.nameVal, rowIdx: m.rowIdx });
          }
        });
        if (accMatches.length > 0) {
          const totalPaid = accMatches.reduce((s, m) => s + m.amount, 0);
          const payerName = accMatches[0].payerName || '';
          newSentLog[slKey] = `bank_import_${new Date().toISOString()}_${totalPaid}_payer_${payerName}`;
          // עדכן paymentHistory לחשבון הנוסף
          const phKey = String(tenant.id) + '__acc__' + acc.id;
          if (!newPaymentHistory[phKey]) newPaymentHistory[phKey] = [];
          newPaymentHistory[phKey].push({
            month: monthKey || getMonthKey(config),
            paid: true,
            amount: acc.amount || 0,
            paidAmount: totalPaid,
            date: new Date().toISOString().split('T')[0],
            type: 'bank_import',
            name: tenant.name,
            payerName
          });
          // סמן שורות ששויכו כדי שלא ישויכו שוב
          accMatches.forEach(m => usedRowIdxForMain.add(m.rowIdx));
          matched.push({
            tenantId: tenant.id,
            name: `${tenant.name} (${acc.label})`,
            amount: totalPaid,
            matchType: 'extra_account',
            accountId: acc.id,
            accountLabel: acc.label
          });
        }
      });
    }
  }); // end updatedTenants.forEach

  return { matched, unmatched, newSentLog, newPaymentHistory, updatedTenants, month: em };
}

// ── GET /api/last-bank-import ─────────────────────────────────────
app.get('/api/last-bank-import', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  res.json({ ok: true, result: d.lastBankSyncImport || null });
});

// ── GET /api/bank-mapping ──────────────────────────────────────────
app.get('/api/bank-mapping', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  res.json({ ok: true, mapping: d.bankMapping || null });
});

// ── POST /api/bank-mapping ─────────────────────────────────────────
app.post('/api/bank-mapping', authMiddleware, (req, res) => {
  const { colName, colAmount, colDate, colNote, bankAmount, bankTolerance } = req.body;
  const d = loadTenantData(req.user.tenantId);
  if (!d.config.bankSyncApiKey) {
    d.config.bankSyncApiKey = uuidv4();
  }
  const mapping = { colName, colAmount, colDate, colNote, bankAmount, bankTolerance };
  saveTenantData(req.user.tenantId, { bankMapping: mapping, config: d.config });
  res.json({ ok: true, mapping, apiKey: d.config.bankSyncApiKey });
});

// ── POST /api/import-bank ──────────────────────────────────────────
app.post('/api/import-bank', bankSyncAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const d = loadTenantData(req.user.tenantId);
    if (!d.bankMapping) return res.status(400).json({ ok: false, error: 'No bank mapping saved. Open VaadPro and click BankSync button first.' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const monthKey = req.body.monthKey || null;

    const { matched, unmatched, newSentLog, newPaymentHistory, updatedTenants, month } = analyzeBankRowsServer(
      rows, d.bankMapping, d.tenants || [], d.sentLog || {}, monthKey, d.config
    );

    // רשום paymentHistory לדיירים רגילים שזוהו
    const tenantDataForHistory = { paymentHistory: Object.assign({}, d.paymentHistory || {}) };
    const importMonthKey = monthKey || (() => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0'); })();
    matched.forEach(m => {
      if (String(m.tenantId).includes('__acc__')) return; // extraAccounts מטופלים בנפרד
      const slKey = String(m.tenantId) + '_' + month; // month = שם חודש בעברית
      const slVal = String(newSentLog[slKey] || '');
      let payerName = '', paidAmount = null;
      const payerMatch = slVal.match(/_payer_(.+)$/);
      if (payerMatch) payerName = payerMatch[1];
      const amtMatch = slVal.match(/bank_import_[^_]+_([\d.]+)_/);
      if (amtMatch) paidAmount = parseFloat(amtMatch[1]);
      const tenant = (d.tenants || []).find(t => String(t.id) === String(m.tenantId));
      const amount = (tenant && tenant.customAmount) || (d.config && d.config.amount) || 300;
      recordPayment(tenantDataForHistory, String(m.tenantId), importMonthKey, 'bank', amount, m.name, payerName, paidAmount);
    });

    // מיזוג paymentHistory של חשבונות נוספים עם הקיים
    const mergedPaymentHistory = tenantDataForHistory.paymentHistory;
    for (const [key, records] of Object.entries(newPaymentHistory)) {
      if (!mergedPaymentHistory[key]) mergedPaymentHistory[key] = [];
      mergedPaymentHistory[key] = mergedPaymentHistory[key].concat(records);
    }

    const importResult = {
      timestamp: new Date().toISOString(),
      month,
      matched: matched.length,
      unmatched: unmatched.length,
      matchedTenants: matched,
      unmatchedTenants: unmatched,
    };
    // Fix #0 (v2.13.15): tenants are NO LONGER written from this route. Since the
    // openingDebt netting was removed above, updatedTenants is an unmodified clone —
    // persisting it would be a no-op that risks clobbering a concurrent tenant edit.
    // Accrual is deferred to closeMonthUnpaid. We now write ONLY sentLog + paymentHistory
    // + the import receipt, exactly like the manual path's footprint (sentLog only, plus
    // the server-side paymentHistory sync).
    saveTenantData(req.user.tenantId, { sentLog: newSentLog, paymentHistory: mergedPaymentHistory, lastBankSyncImport: importResult });

    res.json({ ok: true, month, matched: matched.length, unmatched: unmatched.length, matchedTenants: matched, unmatchedTenants: unmatched });
  } catch (err) {
    console.error('[import-bank]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ════════════════════════════════════════════════════════════════
// MULTI-ACCOUNT FEATURE (v2.10)
// ════════════════════════════════════════════════════════════════
// Design principle: ADDITIVE ONLY.
// Existing tenants without accounts[] continue to work exactly as before.
// New accounts[] live alongside the existing openingDebt/customAmount fields.
// paymentHistory for extra accounts uses key: tenantId + '__acc__' + accountId
// sentLog for extra accounts uses key: tenantId + '__acc__' + accountId + '_' + month
// ════════════════════════════════════════════════════════════════

// ── Account Templates (config-level) ──────────────────────────
// GET /api/account-templates — returns building-level account template list
app.get('/api/account-templates', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  res.json({ ok: true, templates: d.accountTemplates || [] });
});

// POST /api/account-templates — save building-level account templates
app.post('/api/account-templates', authMiddleware, (req, res) => {
  const { templates } = req.body;
  if (!Array.isArray(templates)) return res.json({ ok: false, error: 'templates must be array' });
  // Validate each template
  for (const t of templates) {
    if (!t.id || !t.label) return res.json({ ok: false, error: 'כל תבנית חייבת id ו-label' });
    if (!['fixed', 'formula'].includes(t.type)) return res.json({ ok: false, error: 'סוג חשבון לא תקין: ' + t.type });
    if (!['monthly', 'quarterly', 'yearly'].includes(t.frequency)) return res.json({ ok: false, error: 'תדירות לא תקינה: ' + t.frequency });
  }
  saveTenantData(req.user.tenantId, { accountTemplates: templates });
  res.json({ ok: true });
});

// ── Per-Tenant Account Overrides ──────────────────────────────
// GET /api/tenant-accounts/:tenantId — returns this tenant's account list
app.get('/api/tenant-accounts/:tenantId', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  const tid = req.params.tenantId;
  const tenant = (d.tenants || []).find(t => String(t.id) === String(tid));
  if (!tenant) return res.json({ ok: false, error: 'דייר לא נמצא' });
  const accounts = tenant.extraAccounts || [];
  // Enrich with current debt per account
  const enriched = accounts.map(acc => {
    const phKey = String(tid) + '__acc__' + acc.id;
    const history = (d.paymentHistory || {})[phKey] || [];
    const historyDebt = history.filter(r => !r.paid).reduce((s, r) => s + (r.amount || 0), 0);
    const openingDebt = parseFloat(acc.openingDebt) || 0;
    const totalDebt = Math.max(0, historyDebt + openingDebt);
    return { ...acc, totalDebt, historyDebt };
  });
  res.json({ ok: true, accounts: enriched, owner: tenant.owner || {}, tenant: tenant.tenant || {} });
});

// POST /api/tenant-accounts/:tenantId — save tenant's extra accounts
app.post('/api/tenant-accounts/:tenantId', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  const tid = req.params.tenantId;
  const tenantIdx = (d.tenants || []).findIndex(t => String(t.id) === String(tid));
  if (tenantIdx < 0) return res.json({ ok: false, error: 'דייר לא נמצא' });
  const { accounts } = req.body;
  if (!Array.isArray(accounts)) return res.json({ ok: false, error: 'accounts must be array' });
  // Preserve existing openingDebt values — only update amount/label fields
  const existing = d.tenants[tenantIdx].extraAccounts || [];
  const merged = accounts.map(acc => {
    const prev = existing.find(e => e.id === acc.id);
    return {
      id:          acc.id,
      label:       acc.label,
      type:        acc.type || 'fixed',
      frequency:   acc.frequency || 'monthly',
      amount:      parseFloat(acc.amount) || 0,
      openingDebt: prev ? (parseFloat(acc.openingDebt) ?? parseFloat(prev.openingDebt) ?? 0) : (parseFloat(acc.openingDebt) || 0),
      matchKeywords: acc.matchKeywords || '',
      formulaNote: acc.formulaNote || '',
      payer:       (acc.payer === 'owner' || acc.payer === 'tenant') ? acc.payer : (prev && prev.payer) || 'owner', // שלב 1: מי משלם
      active:      acc.active !== false, // default true
    };
  });
  d.tenants[tenantIdx].extraAccounts = merged;
  // שלב 1: שמירת סלוטי בעלים/שוכר (אם נשלחו) — שדות שם/טלפון/אימייל לכל סלוט
  const cleanSlot = (o) => {
    if (!o || typeof o !== 'object') return undefined;
    return {
      name:  String(o.name  || '').trim(),
      phone: String(o.phone || '').trim().replace(/\D/g, ''),
      email: String(o.email || '').trim(),
    };
  };
  if (req.body.owner  !== undefined) d.tenants[tenantIdx].owner  = cleanSlot(req.body.owner);
  if (req.body.tenant !== undefined) d.tenants[tenantIdx].tenant = cleanSlot(req.body.tenant);
  saveTenantData(req.user.tenantId, { tenants: d.tenants });
  res.json({ ok: true });
});

// POST /api/mark-account-paid/:tenantId/:accountId — manual payment for extra account
app.post('/api/mark-account-paid/:tenantId/:accountId', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  const tid = String(req.params.tenantId);
  const accId = req.params.accountId;
  const tenant = (d.tenants || []).find(t => String(t.id) === tid);
  if (!tenant) return res.json({ ok: false, error: 'דייר לא נמצא' });
  const acc = (tenant.extraAccounts || []).find(a => a.id === accId);
  if (!acc) return res.json({ ok: false, error: 'חשבון לא נמצא' });

  const mk = getMonthKey(d.config);
  const { paidAmount } = req.body;
  const paid = parseFloat(paidAmount) || acc.amount || 0;
  const phKey = tid + '__acc__' + accId;
  if (!d.paymentHistory) d.paymentHistory = {};
  if (!d.paymentHistory[phKey]) d.paymentHistory[phKey] = [];

  // Deduplicate: don't overwrite if already paid this month
  const existing = d.paymentHistory[phKey].findIndex(r => r.month === mk);
  const record = {
    month: mk, paid: true, amount: acc.amount || 0,
    paidAmount: paid, date: new Date().toISOString().split('T')[0],
    type: 'manual', name: tenant.name
  };
  // Also update sentLog for this account+month
  const slKey = tid + '__acc__' + accId + '_' + getEffectiveMonth(d.config);
  d.sentLog = d.sentLog || {};
  d.sentLog[slKey] = 'manual_paid_' + new Date().toISOString() + '_amount_' + paid;

  if (existing >= 0) {
    if (d.paymentHistory[phKey][existing].paid) return res.json({ ok: true, alreadyPaid: true });
    d.paymentHistory[phKey][existing] = record;
  } else {
    d.paymentHistory[phKey].push(record);
  }
  saveTenantData(req.user.tenantId, { paymentHistory: d.paymentHistory, sentLog: d.sentLog });
  res.json({ ok: true });
});

// POST /api/mark-account-unpaid/:tenantId/:accountId — undo manual payment
app.post('/api/mark-account-unpaid/:tenantId/:accountId', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  const tid = String(req.params.tenantId);
  const accId = req.params.accountId;
  const mk = getMonthKey(d.config);
  const em = getEffectiveMonth(d.config);
  const phKey = tid + '__acc__' + accId;
  if (d.paymentHistory && d.paymentHistory[phKey]) {
    d.paymentHistory[phKey] = d.paymentHistory[phKey].filter(r => r.month !== mk);
  }
  const slKey = tid + '__acc__' + accId + '_' + em;
  if (d.sentLog) delete d.sentLog[slKey];
  saveTenantData(req.user.tenantId, { paymentHistory: d.paymentHistory, sentLog: d.sentLog });
  res.json({ ok: true });
});

// GET /api/accounts-status — returns payment status of all extra accounts for current month
// Used by app.html to display per-account paid/unpaid in the tenant list
app.get('/api/accounts-status', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  const mk = getMonthKey(d.config);
  const em = getEffectiveMonth(d.config);
  const result = {};
  for (const tenant of (d.tenants || [])) {
    const tid = String(tenant.id);
    const accounts = tenant.extraAccounts || [];
    if (!accounts.length) continue;
    result[tid] = accounts.map(acc => {
      const phKey = tid + '__acc__' + acc.id;
      const slKey = tid + '__acc__' + acc.id + '_' + em;
      const history = (d.paymentHistory || {})[phKey] || [];
      const paidThisMonth = history.some(r => r.month === mk && r.paid)
                         || String(d.sentLog[slKey] || '').startsWith('manual_paid')
                         || String(d.sentLog[slKey] || '').startsWith('bank_import');
      const historyDebt = history.filter(r => !r.paid).reduce((s, r) => s + (r.amount || 0), 0);
      const openingDebt = parseFloat(acc.openingDebt) || 0;
      const totalDebt   = Math.max(0, historyDebt + openingDebt);
      return {
        id: acc.id, label: acc.label, amount: acc.amount,
        frequency: acc.frequency, active: acc.active !== false,
        paidThisMonth, totalDebt, historyDebt, openingDebt
      };
    });
  }
  res.json({ ok: true, status: result });
});

// ── closeMonthUnpaid extension for extra accounts ─────────────
// Called from within closeMonthUnpaid() — processes extraAccounts per tenant
// Returns number of accounts closed
function closeExtraAccountsUnpaid(d, tenant, prevKey) {
  let closed = 0;
  const tid = String(tenant.id);
  const accounts = tenant.extraAccounts || [];
  if (!accounts.length) return 0;

  for (const acc of accounts) {
    if (acc.active === false) continue;
    // Check frequency: only charge if this month is a billing month
    const [year, month] = prevKey.split('-').map(Number);
    if (acc.frequency === 'quarterly' && (month % 3 !== 0)) continue; // bill on 3,6,9,12
    if (acc.frequency === 'yearly'    && month !== 1) continue;       // bill on January

    const phKey = tid + '__acc__' + acc.id;
    if (!d.paymentHistory[phKey]) d.paymentHistory[phKey] = [];
    const amount = parseFloat(acc.amount) || 0;
    if (amount <= 0) continue;

    const existing = d.paymentHistory[phKey].find(r => r.month === prevKey);
    if (existing) {
      if (!existing.paid) {
        // Unpaid — accumulate to account's openingDebt
        acc.openingDebt = Math.round(
          (Math.max(0, parseFloat(acc.openingDebt) || 0) + amount) * 100
        ) / 100;
        d.paymentHistory[phKey] = d.paymentHistory[phKey].filter(r => r.month !== prevKey);
        closed++;
      } else {
        // Paid — check for overpayment credit
        const paidAmt = parseFloat(existing.paidAmount ?? existing.amount ?? amount);
        const overpay = Math.round((paidAmt - amount) * 100) / 100;
        if (overpay > 0) {
          acc.openingDebt = Math.round(
            ((parseFloat(acc.openingDebt) || 0) - overpay) * 100
          ) / 100;
        }
      }
    } else {
      // No record — unpaid, accumulate
      acc.openingDebt = Math.round(
        (Math.max(0, parseFloat(acc.openingDebt) || 0) + amount) * 100
      ) / 100;
      closed++;
    }
  }
  return closed;
}

// ── Extra accounts monthly close ─────────────────────────────
// Runs on the 1st alongside the original scheduleDailyCron.
// Only touches extraAccounts[].openingDebt — never touches tenant.openingDebt.
async function runMaintenanceCronWithAccounts() {
  // Only close extra accounts on the 1st of the month
  const now = new Date();
  if (now.getDate() !== 1) return;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey  = prevDate.getFullYear() + '-' + String(prevDate.getMonth() + 1).padStart(2, '0');
  const users = loadUsers();
  let totalClosed = 0;
  for (const user of users) {
    if (!user.tenantId) continue;
    try {
      const d = loadTenantData(user.tenantId);
      if (!d.tenants || !d.tenants.length) continue;
      if (!d.paymentHistory) d.paymentHistory = {};
      let changed = false;
      for (const tenant of d.tenants) {
        const n = closeExtraAccountsUnpaid(d, tenant, prevKey);
        if (n > 0) { changed = true; totalClosed += n; }
      }
      if (changed) saveTenantData(user.tenantId, { tenants: d.tenants, paymentHistory: d.paymentHistory });
    } catch(e) {
      console.error(`[closeExtraAccounts:${user.tenantId}]`, e.message);
    }
  }
  if (totalClosed > 0) console.log(`[closeExtraAccounts] נצברו ${totalClosed} חובות חשבונות נוספים לחודש ${prevKey}`);
}

// Run extra-accounts cron daily at 08:05 (5 min after original maintenance cron)
// so it always runs after the main cron has finished.
function scheduleDailyCronWithAccounts() {
  const now  = new Date();
  const next = new Date();
  next.setHours(8, 5, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    runMaintenanceCronWithAccounts();
    setInterval(runMaintenanceCronWithAccounts, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`[ExtraAccountsCron] יופעל ב-${next.toLocaleTimeString('he-IL')}`);
}
// Note: scheduleDailyCron() was already called above — the new one runs additionally
// to handle the extra accounts layer. Both are safe to run together because
// the original only touches tenant.openingDebt and the new one only touches acc.openingDebt.
scheduleDailyCronWithAccounts();

// ── POST /api/ai-improve ─────────────────────────────────────────
// Anthropic Claude proxy — ANTHROPIC_API_KEY stays server-side only
app.post('/api/ai-improve', (req, res, next) => {
  // Accept regular user token (Authorization: Bearer ...) OR admin token (x-admin-token)
  const userToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const adminToken = (req.headers['x-admin-token'] || '').replace('Bearer ', '').trim();
  if (userToken) {
    try { jwt.verify(userToken, JWT_SECRET); return next(); } catch(e) {}
  }
  if (adminToken) {
    try {
      const decoded = jwt.verify(adminToken, ADMIN_JWT_SECRET);
      if (decoded.isAdmin) return next();
    } catch(e) {}
  }
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured on server' });
  const { system, user } = req.body;
  if (!user) return res.json({ ok: false, error: 'missing user message' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: system || '',
        messages: [{ role: 'user', content: user }]
      })
    });
    const data = await r.json();
    const result = data?.content?.[0]?.text?.trim();
    if (result) return res.json({ ok: true, result });
    const errDetail = data?.error?.message || JSON.stringify(data).slice(0, 200);
    console.error('[ai-improve] Anthropic bad response:', errDetail);
    return res.json({ ok: false, error: 'Claude: ' + errDetail });
  } catch (e) {
    console.error('[ai-improve] error:', e.message);
    return res.json({ ok: false, error: e.message });
  }
});

// ── Auto-reconnect existing WA sessions on server startup (Railway restart) ──
// בלי זה: אחרי כל deploy כל ה-sessions נשארים disconnected בזיכרון,
// connection='open' לא נורה, ו-lastConnectedAt לא מתעדכן → לקוחות תקועים ב"ממתינים".
function reconnectExistingSessions() {
  if (WA_MODE !== 'server') return;
  let dirs = [];
  try { dirs = fs.readdirSync(WA_SESSIONS_DIR); } catch(e) { return; }
  const valid = dirs.filter(d => {
    try {
      const sd = path.join(WA_SESSIONS_DIR, d);
      if (!fs.statSync(sd).isDirectory()) return false;
      // session תקין = יש קובץ creds.json
      return fs.existsSync(path.join(sd, 'creds.json'));
    } catch(e) { return false; }
  });
  console.log(`[WA] startup reconnect — found ${valid.length} saved session(s)`);
  valid.forEach((tenantId, i) => {
    // השהיה מדורגת כדי לא להעמיס את הזיכרון/רשת בבת אחת
    setTimeout(() => {
      console.log(`[WA] reconnecting saved session: ${tenantId}`);
      try { initWa(tenantId); } catch(e) { console.error(`[WA] reconnect ${tenantId} failed:`, e.message); }
    }, i * 4000);
  });
}

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   VaadPro v2.13.15 – SaaS Server        ║');
  console.log('║   http://localhost:' + PORT + '             ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  const modeLabel = WA_MODE === 'server' ? '🚀 Server (Baileys on Railway)' : WA_MODE === 'cloud' ? '☁️  Cloud (WA Bridge)' : '💻 Local (legacy)';
  console.log('Mode:      ', modeLabel);
  console.log('Admin URL:  /admin');
  console.log('');
  if (WA_MODE === 'server') {
    console.log('WhatsApp: Baileys runs on Railway — customers scan QR in browser');
  } else if (WA_MODE === 'cloud') {
    console.log('WhatsApp: cloud mode – waiting for WA Bridge connections');
    console.log('Bridge secret:', BRIDGE_SECRET);
  } else {
    console.log('WhatsApp: local mode (legacy)');
  }
  console.log('');
  // הפעל reconnect ל-sessions קיימים אחרי שהשרת עלה
  setTimeout(reconnectExistingSessions, 2000);
});
