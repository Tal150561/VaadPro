# 🚀 VaadPro – מדריך העלאה לענן (Railway)

---

## שלב 1 — צור חשבון GitHub והעלה את הקוד

1. צור חשבון ב-https://github.com (אם אין לך)
2. צור Repository חדש בשם `vaadpro`
3. פתח CMD בתיקיית הפרויקט והרץ:

```bash
git init
git add .
git commit -m "VaadPro v1.0"
git remote add origin https://github.com/YOUR_USERNAME/vaadpro.git
git push -u origin main
```

---

## שלב 2 — פתח חשבון Railway

1. עבור ל-https://railway.app
2. לחץ **"Start a New Project"**
3. בחר **"Deploy from GitHub repo"**
4. בחר את ה-repo `vaadpro`

---

## שלב 3 — הוסף Volume לנתונים

ב-Railway, הקבצים נמחקים בכל deploy אלא אם יש Volume:

1. לחץ על הפרויקט שלך
2. לחץ **"Add Volume"**
3. Mount path: `/app/data`
4. חזור על זה עבור: `/app/.wwebjs_auth`

---

## שלב 4 — הגדר משתני סביבה

ב-Railway ← Settings ← Variables, הוסף:

```
WA_MODE=cloud
JWT_SECRET=כתוב-כאן-מחרוזת-אקראית-ארוכה-לפחות-32-תווים
ADMIN_KEY=הסיסמה-הסודית-שלך-לניהול
BRIDGE_SECRET=סוד-לחיבור-ה-bridge-שמור-אותו
```

לייצור מחרוזת אקראית — הרץ בCMD:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## שלב 5 — קבל את ה-URL

אחרי ה-deploy, Railway ייתן לך URL כמו:
```
https://vaadpro-production.up.railway.app
```

זה ה-URL של VaadPro! שמור אותו.

---

## שלב 6 — הפעל WA Bridge על המחשב שלך

1. פתח CMD בתיקיית הפרויקט
2. ראה קודם מה ה-TENANT_ID שלך — אחרי הרשמה ב-VaadPro:

```bash
# קבל את ה-TENANT_ID (פעם אחת):
curl https://your-app.railway.app/api/admin/tenants \
  -H "x-admin-key: YOUR_ADMIN_KEY"
```

3. הפעל את ה-Bridge:

```bash
# Windows CMD:
set CLOUD_URL=https://your-app.railway.app
set BRIDGE_SECRET=הסוד-שהגדרת
set TENANT_ID=ה-tenant-id-שלך
node wa-bridge.js

# או צור קובץ bridge.bat:
```

**bridge.bat (לWindows):**
```bat
@echo off
set CLOUD_URL=https://your-app.railway.app
set BRIDGE_SECRET=הסוד-שהגדרת
set TENANT_ID=ה-tenant-id-שלך
node wa-bridge.js
pause
```

4. סרוק QR בווטסאפ — מעכשיו הכל עובד!

---

## 🔄 שגרת עבודה יומית

```
1. פתח bridge.bat (פעם אחת כשמתחיל לעבוד)
2. לקוחות מתחברים ל-https://your-app.railway.app
3. הם שולחים הודעות → Bridge מקבל ושולח בווטסאפ שלך
```

---

## 💰 עלויות Railway

| שימוש | עלות |
|-------|------|
| Hobby plan | $5/חודש |
| Usage בפועל (~1GB RAM, ~5GB storage) | ~$3-8/חודש |
| **סה"כ צפוי** | **~$8-13/חודש** |

עם 10 לקוחות ב-99₪ = ~990₪/חודש הכנסה לעומת ~50₪ עלות ☁️

---

## 🆘 בעיות נפוצות

| בעיה | פתרון |
|------|-------|
| `Cannot find module` | הרץ `npm install` |
| נתונים נמחקים | ודא Volume מוגדר ב-Railway |
| WA לא מתחבר | ודא BRIDGE_SECRET זהה בשני הצדדים |
| 401 Unauthorized | ודא JWT_SECRET זהה לפני ואחרי deploy |
