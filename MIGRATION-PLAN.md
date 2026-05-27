# VaadPro — Baileys on Railway Migration Plan
## v2.10.11 → v2.10.12

### Goal
Move WhatsApp from local Bridge (whatsapp-web.js + Puppeteer on customer machine)
to Baileys running directly on Railway. Customer only scans a QR code in the app — no local install.

### Rollback
```
git checkout v2.10.11-before-baileys-migration
git push --force
```
Or via GitHub: Releases → v2.10.11-before-baileys-migration → redeploy.

---

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Remove whatsapp-web.js/puppeteer, add baileys@6.5.0 + @hapi/boom + pino |
| `server.js` | Replace initWa()+Puppeteer with initBaileysForTenant() using Baileys |

## Files NOT Changed (zero touch)
- `public/app.html` — QR display logic already works
- `public/admin.html`
- `public/tenant-portal.html`
- All debt/payment/sentLog logic
- All bank import logic
- All ticket logic

---

## New WA_MODE: 'server'

Add env var on Railway: `WA_MODE=server`

| Mode | Behavior |
|------|----------|
| `local` | OLD: whatsapp-web.js + Puppeteer (remove after migration) |
| `cloud` | OLD: external Bridge polling (keep for backward compat) |
| `server` | NEW: Baileys runs inside Railway, sessions in /app/data/wa_sessions/ |

---

## Session Storage

Sessions stored at: `/app/data/wa_sessions/{tenantId}/`
This is inside the Railway Volume (DATA_DIR) — survives redeploys.

---

## Key Decisions

1. **Lazy init**: Baileys starts only when customer clicks "Connect WhatsApp" — not at server startup
2. **Throttle**: 1200ms delay between messages already exists in send-all and doAutoSend — keep as-is
3. **Reconnect**: On Railway restart, Baileys auto-reconnects from saved session (no QR needed)
4. **Logged out**: If customer disconnects from phone → status='disconnected' → UI shows "scan again"
5. **No Puppeteer**: Removes ~400MB from deploy, faster cold starts

---

## Checklist

### Before deploy
- [ ] `git tag v2.10.11-before-baileys-migration && git push --tags` ✅ DONE
- [ ] Copy new package.json + server.js to repo
- [ ] `node --check server.js` locally
- [ ] Commit: "v2.10.12 — Baileys on Railway (no local Bridge)"

### Railway
- [ ] Add env var: `WA_MODE=server`
- [ ] Verify Volume is mounted at `/app/data`
- [ ] Watch deploy logs — first deploy installs new packages (~2 min)

### After deploy
- [ ] Login to vaadpro.org → Settings → Connect WhatsApp
- [ ] QR appears in browser (no Bridge needed)
- [ ] Scan with phone → status = 🟢 Connected
- [ ] Send test message to one tenant
- [ ] Verify AutoSend still works (check cron logs)

### If something breaks
- [ ] Railway → Deployments → previous deploy → Redeploy
- [ ] OR: `git revert HEAD && git push`
