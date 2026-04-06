# VaadPro v1.9.0 — הוראות תפעול מלאות

## כתובות

| שימוש | כתובת |
|-------|-------|
| אפליקציה ללקוח | https://vaadpro.org |
| פאנל ניהול | https://vaadpro.org/admin |
| גיבוי Railway | https://deqzamlr.up.railway.app |

---

## Deploy

### קבצים בחבילה

| קובץ | יעד בפרויקט |
|------|------------|
| server.js | שורש הפרויקט / |
| public/app.html | תיקיית public/ |
| public/admin.html | תיקיית public/ |

### פקודות

```bash
copy server.js "...\vaadpro-v1.3\vaadpro\server.js"
copy public\app.html "...\vaadpro-v1.3\vaadpro\public\app.html"
copy public\admin.html "...\vaadpro-v1.3\vaadpro\public\admin.html"

cd "...\vaadpro-v1.3\vaadpro"
git add server.js public\app.html public\admin.html
git commit -m "v1.9.0"
git push
```

---

## Railway Variables

| משתנה | ערך |
|-------|-----|
| JWT_SECRET | מחרוזת אקראית 64+ תווים |
| WA_MODE | cloud |
| BRIDGE_SECRET | מחרוזת אקראית 64+ תווים |
| ADMIN_EMAIL | vaadpro15@gmail.com |
| ADMIN_PASSWORD | סיסמה חזקה |
| RESEND_API_KEY | re_xxxxxxxxxx |
| SMTP_FROM | VaadPro <noreply@vaadpro.org> |
| APP_URL | https://vaadpro.org |

---

## DNS (Namecheap — Advanced DNS)

| Type | Host | Value |
|------|------|-------|
| CNAME | @ | deqzamlr.up.railway.app. |
| TXT | _railway | railway-verify=... |
| TXT | resend._domainkey | (מ-Resend Dashboard) |
| TXT | _dmarc | v=DMARC1; p=none; |
| TXT | mail | v=spf1 include:amazonses.com ~all |

Mail Settings → Custom MX:
| MX | mail | feedback-smtp.eu-west-1.amazonses.com | 10 |

---

## Bridge — הפעלה יומית

1. הפעל VaadPro-Start.bat
2. אל תסגור את החלון השחור
3. פתח https://vaadpro.org ובדוק "מחובר ✅"

### config.json של Bridge

```json
{
  "cloudUrl": "https://vaadpro.org",
  "bridgeSecret": "...",
  "tenantId": "..."
}
```

אם Railway מחדש URL — עדכן cloudUrl זמנית לכתובת החדשה עד שDNS יתעדכן.

---

## תפעול בעיות

### "מתחבר..." לא מסתיים
- ודא שVaadPro-Start.bat פועל ורואה "✅ ווטסאפ מחובר"
- בדוק שconfig.json מצביע ל-cloudUrl הנכון
- נסה: F12 → Console: `fetch('/api/status').then(r=>r.json()).then(console.log)`
  - אם status=ready → רענן דף (Ctrl+Shift+R)
  - אם 401/403 → התנתק והתחבר מחדש (JWT פג תוקף)
  - אם 404 → ה-URL של Railway השתנה, עדכן DNS

### Bridge לא מתחבר לשרת
- בדוק שcloudUrl ב-config.json מדויק
- בדוק ב-Railway → Deploy Logs — האם רואה `status=ready`?
- ודא שBRIDGE_SECRET ב-Railway זהה ל-bridgeSecret ב-config.json

### אפליקציה מחזירה 404
- Railway יצר URL חדש — עדכן CNAME ב-Namecheap
- או שה-deploy נכשל — בדוק Railway → Build Logs

### Bad MAC / Session error בחלון Bridge
- זה רעש נורמלי של WhatsApp — לא מצביע על בעיה
- אם הגרסה החדשה (v1.9.0+) — השגיאות מוחבאות אוטומטית
- אם עדיין מופיע — הלקוח מריץ bridge.js ישן, צריך להוריד Bridge מחדש

### ווטסאפ מנותק — "לחץ לסריקת QR"
- פתח חלון הBridge
- לחץ "חיבור ווטסאפ" באפליקציה
- סרוק QR עם הטלפון

### שם "חבר" מופיע בכרטיס השיתוף
- סיבה: JWT ישן לפני v1.9.0 שלא כולל fullName
- פתרון: התנתק והתחבר מחדש — JWT חדש ייווצר עם השם

### חודש לא מתעדכן (מרץ במקום אפריל)
- עבור להגדרות → בחר חודש פעיל ידנית

### SmartScreen חוסם את VaadPro-Start.bat
- לחץ ימני על הקובץ המקורי → Properties
- תיבה בתחתית: "This file came from another computer" → סמן Unblock
- לחץ Apply → OK

### mailto: פותח Outlook ולא Gmail
- Windows Settings → Apps → Default apps → Mail → בחר Chrome
- ב-Chrome: Settings → Privacy → Site settings → Handlers → אפשר mail.google.com
- לחלופין: השתמש בכפתור "📋 העתק הודעה" והדבק ידנית

---

## מה חדש ב-v1.9.0

- תוקן קובץ app.html שהיה קטוע (init() לא נקרא)
- תוקן JWT — fullName נשמר ב-token
- Bad MAC noise מוחבא אוטומטית ב-Bridge
- כרטיס שיתוף: עריכת הודעה + העתק + אפס
- שם המשתמש ושם הבניין נקראים מה-JWT

---

## Admin Panel

### כניסה
https://vaadpro.org/admin (ADMIN_EMAIL + ADMIN_PASSWORD)

### תפקידים
| תפקיד | הרשאות |
|-------|-------|
| super | הכל + ניהול אדמינים |
| admin | צפייה + שליחה + מחיקת לקוחות + שינוי plan |
| viewer | קריאה בלבד |

### ניהול לקוחות
- Dashboard → רשימת לקוחות + סטטוס Bridge
- "ממתין להתקנה" — לקוחות שלא התחברו 30+ ימים
- Plan modal — שינוי plan + הארכת trial

