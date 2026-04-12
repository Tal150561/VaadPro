# VaadPro v2.5.9 — הוראות תפעול מלאות

## כתובות

| שימוש | כתובת |
|-------|-------|
| אפליקציה ללקוח | https://vaadpro.org |
| פאנל ניהול | https://vaadpro.org/admin |
| Render (hosting) | https://render.com |

---

## Deploy לגרסה חדשה

### קבצים בחבילה

| קובץ | יעד בפרויקט |
|------|------------|
| server.js | שורש הפרויקט / |
| public/app.html | תיקיית public/ |
| public/admin.html | תיקיית public/ |

### פקודות (Windows)

```bat
copy server.js "...aadpro-v1.3aadpro\server.js"
copy publicpp.html "...aadpro-v1.3aadpro\publicpp.html"
copy publicdmin.html "...aadpro-v1.3aadpro\publicdmin.html"

cd "...aadpro-v1.3aadpro"
git add server.js publicpp.html publicdmin.html
git commit -m "v2.4.0"
git push
```

---

## התקנה ראשונה (Fresh Install)

### דרישות מקדימות
- Node.js 18+
- Git
- חשבון Railway
- חשבון Namecheap עם הדומיין vaadpro.org

### שלבים

1. **Clone הפרויקט:**
```bash
git clone <repo-url> vaadpro
cd vaadpro
npm install
```

2. **הגדר משתני סביבה ב-Railway** (ראה טבלה למטה)

3. **הגדר DNS ב-Namecheap** (ראה טבלה למטה)

4. **push לGit → Railway יבנה אוטומטית**

---

## Render Environment Variables

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
| CNAME | @ | (your Render domain, e.g. vaadpro.onrender.com) |
| TXT | _railway-verify | railway-verify=eee938899ec35198320978e7ad788ec... |
| TXT | resend._domainkey | (מ-Resend Dashboard) |
| TXT | _dmarc | v=DMARC1; p=none; |
| TXT | mail | v=spf1 include:amazonses.com ~all |

Mail Settings → Custom MX:
| MX | mail | feedback-smtp.eu-west-1.amazonses.com | 10 |

---

## Bridge — התקנה אצל לקוח

### Windows — התקנה אוטומטית
1. כנס לאפליקציה → הגדרות → **"הורד VaadPro-Setup"**
2. לחץ ימני על הקובץ → Properties → סמן **Unblock** → Apply → OK
3. לחץ פעמיים על הקובץ
4. הכנס את קוד ההתקנה מהאפליקציה (תקף 30 דקות)
5. לחץ **Install** — מתקין הכל אוטומטית (~2-3 דקות)
6. Bridge יפתח אוטומטית בסיום

### Mac — התקנה אוטומטית
1. כנס לאפליקציה → הגדרות → **"הורד VaadPro-Setup (Mac)"**
2. פתח Terminal וכתוב:
```bash
chmod +x ~/Downloads/VaadPro-Setup.sh && ~/Downloads/VaadPro-Setup.sh
```
3. הכנס את קוד ההתקנה מהאפליקציה
4. Bridge יפתח אוטומטית בסיום

### הפעלה יומית
- **Windows:** לחץ פעמיים על קיצור הדרך **"VaadPro Bridge"** בדסקטופ
- **Mac:** לחץ פעמיים על **"VaadPro Bridge.command"** בדסקטופ
- אל תסגור את החלון השחור!

### config.json (נוצר אוטומטית בהתקנה)
```json
{
  "cloudUrl": "https://vaadpro.org",
  "bridgeSecret": "...",
  "tenantId": "..."
}
```

---

## פתרון בעיות

### "מתחבר..." לא מסתיים
- ודא ש-start.bat פועל ורואה "✅ ווטסאפ מחובר"
- בדוק שconfig.json מצביע ל-cloudUrl הנכון
- F12 → Console:
  ```js
  fetch('/api/status').then(r=>r.json()).then(console.log)
  ```
  - `status=ready` → רענן דף (Ctrl+Shift+R)
  - `401/403` → התנתק והתחבר מחדש
  - `404` → Railway URL השתנה, עדכן DNS

### Bridge לא מתחבר
- בדוק cloudUrl ב-config.json
- Railway → Deploy Logs → חפש `status=ready`
- ודא BRIDGE_SECRET זהה בשני הצדדים

### ווטסאפ מנותק — "לחץ לסריקת QR"
- פתח חלון Bridge → לחץ "חיבור ווטסאפ" → סרוק QR

### Bad MAC / Session error
- רעש נורמלי — מוחבא אוטומטית מ-v1.9.0+
- אם עדיין מופיע → מחק את תיקיית VaadPro-Bridge והתקן מחדש

### שגיאת ERR_REQUIRE_ESM בחלון Bridge
- גרסת baileys לא תואמת
- פתרון: מחק `C:\Users\...\Documents\VaadPro-Bridge` והרץ Setup מחדש
- אם חוזר: עדכן node_modules.zip ב-GitHub Release והרץ:
  `https://vaadpro.org/api/admin/init-modules?secret=BRIDGE_SECRET`

### node_modules.zip — עדכון אחרי שינוי תלויות
1. בנה node_modules חדש עם הגרסאות הנכונות
2. העלה ל-GitHub Release `v1.0-modules`
3. אלץ הורדה מחדש בשרת:
   `https://vaadpro.org/api/admin/init-modules?secret=BRIDGE_SECRET`

### אפליקציה מחזירה 404
- Railway יצר URL חדש → עדכן CNAME ב-Namecheap
- או deploy נכשל → Railway → Build Logs

### שם "חבר" בכרטיס שיתוף
- התנתק והתחבר מחדש (JWT ישן ללא fullName)

### SmartScreen חוסם BAT
- לחץ ימני → Properties → Unblock → Apply → OK

### mailto פותח Outlook במקום Gmail
- Windows Settings → Apps → Default apps → Mail → Chrome
- Chrome → Settings → Handlers → אפשר mail.google.com

---

## Admin Panel

### כניסה
`https://vaadpro.org/admin` ← ADMIN_EMAIL + ADMIN_PASSWORD

### תפקידים
| תפקיד | הרשאות |
|-------|-------|
| super ⭐ | הכל + ניהול אדמינים |
| admin 👤 | צפייה + שליחה + מחיקה + שינוי plan |
| viewer 👁️ | קריאה בלבד |

### ניהול לקוחות
- Dashboard → רשימת לקוחות + סטטוס Bridge
- "ממתין להתקנה" — לקוחות שלא התחברו 30+ ימים
- Plan modal — שינוי plan + הארכת trial

---

## Changelog

### v2.2.3
- תוקן: חודש אוטומטי = חודש נוכחי תמיד (בוטלה לוגיקת "לפני ה-10")
- פושט UI חודש — select פשוט במקום כפתורי אוטומטי/ידני
- תוקן: קבצי install.bat / start.bat באנגלית בלבד (encoding fix)

### v2.4.0
- שכחתי סיסמה — איפוס דרך מייל (לינק תקף שעה)
- דף כניסה/הרשמה חדש (index.html) עם לינק שכחתי סיסמה
- איפוס סיסמה ידני מ-Admin Panel
- תיקון לופ מסך שחור בהתנתקות
- מיילים HTML — לוגו + עיצוב + שורות תקינות
- HTML אוטומטי כשיש תגי HTML בתבנית
- המרת ירידות שורה ל-br אוטומטית

### v2.5.9
- baileys נועל ל-6.5.0 (6.7+ הפכה ESM-only ושברה התקנות)
- Mac setup.sh — אותה לוגיקה חזקה כמו Windows: PATH reload, fallback, בדיקת node_modules
- npm install מציג פלט גלוי (הסרת >nul / 2>&1)
- CRM status שינוי מסנכרן ל-leads table מיידית
- Bulletin messages נשמרות בשרת (לא אובדות ברענון)
- רשימת "ממתין להתקנה" מתרעננת אוטומטית כל 30 שניות
- סטטוס ליד מתעדכן בטבלה מיד אחרי שינוי ב-CRM

### v2.5.8
- VaadPro-Setup EXE (Inno Setup) — ניסיון, נדרשת חתימה דיגיטלית
- VaadPro-Setup.bat — תיקון npm via node path ישיר
- VaadPro-Start.bat — שימוש בנתיב מלא לNode.js
- Bridge messages באנגלית
- Win/Mac OS selector בהגדרות
- Mac setup.sh
- Onboarding wizard מעודכן

### v2.5.4
- תיקון VaadPro-Setup — כתיבת PS1 לקובץ במקום inline (פותר Missing })
- לוג קובץ על הדסקטופ: VaadPro-Setup-Log.txt
- כפתור סגירה ב-QR modal
- Onboarding wizard — 4 שלבים + כפתור מדריך בheader
- דף תמחור — pricing.html + redirect מ-Trial פג
- מגבלות תוכנית: Basic=20, Advanced=50, Premium=ללא הגבלה
- מייל ברוכים הבאים מעודכן עם הוראות VaadPro-Setup

### v2.5.0
- 🚀 מתקין חדש — VaadPro-Setup.bat
  - קוד התקנה 6 ספרות מהאפליקציה (תקף 30 דקות)
  - חלון גרפי PowerShell — הכנסת קוד + Install
  - מוריד bridge.js + config.json אוטומטית
  - מתקין Node.js אוטומטית אם חסר
  - יוצר קיצור דרך על הדסקטופ
  - הורדה ישירה מ-vaadpro.org/vaadpro-setup.bat
- עדכון הוראות התקנה בהגדרות
- עדכון פתרון בעיות + עזרה

### v2.4.4
- הורדת Node.js אוטומטית ב-VaadPro-Start.bat
- Heartbeat timeout — מנותק אחרי 3 דקות

### v2.4.2
- VaadPro-Start.bat / VaadPro-Start.sh נוספו ל-ZIP של Bridge
- הוראות התקנה מעודכנות בהגדרות + עברית/Mac
- Unblock הוראות מפורטות
- קיצור דרך אוטומטי על הדסקטופ
- Heartbeat timeout — מסמן "מנותק" אחרי 3 דקות ללא Bridge

### v2.4.1
- Bridge heartbeat timeout auto-disconnect (3 דקות)

### v2.4.0
- שכחתי סיסמה — איפוס דרך מייל
- דף כניסה/הרשמה חדש (index.html)
- איפוס סיסמה ידני מ-Admin
- תיקון לופ מסך שחור בהתנתקות
- HTML email עם לוגו ועיצוב
- המרת ירידות שורה ל-br אוטומטית

### v2.2.2
- תוקן: install.bat ו-start.bat שנוצרים בהורדת Bridge — ללא עברית

### v2.2.1
- תוקן: שמירת נמענים בתחזוקה (type mismatch — number vs string)
- תוקן: שליחת WA/מייל מתחזוקה לא עבדה

### v2.2.0
- מערכת Plans מלאה: trial/basic/advanced/premium/unlimited
- טאבים נעולים 🔒 עם popup שדרוג
- מגבלת דיירים לפי plan עם הודעת שגיאה ברורה
- Plan badge בסרגל הניווט
- Override ידני מגבלת דיירים ב-Admin

### v2.1.2
- תוקן: modal תחזוקה לא נפתח (שגיאת CSS display)
- תוקן: שגיאות syntax ב-JavaScript של מודול תחזוקה

### v2.1.0
- 🏗️ מודול תחזוקת בניין חדש
  - רשימת ברירת מחדל (מעלית, מטפים, גנרטור ועוד 7 משימות)
  - חישוב תאריך הבא אוטומטי אחרי "בוצע"
  - ימי התראה מותאמים אישית
  - שליחה ידנית + Cron אוטומטי ב-08:00
  - Badge אדום בטאב כשיש משימות דחופות

### v2.0.0
- DNS פעיל: vaadpro.org → Railway ✅
- Railway URL: 1kj5dpgk.up.railway.app
- חבילה מלאה (לא רק עדכונים)

### v1.9.0
- תוקן app.html (init() לא נקרא)
- JWT כולל fullName
- Bad MAC מוחבא ב-Bridge
- כרטיס שיתוף עם עריכה + העתק + אפס

