# VaadPro v2.9.0 — הוראות תפעול מלאות

## כתובות

| שימוש | כתובת |
|-------|-------|
| אפליקציה ללקוח | https://vaadpro.org |
| פאנל ניהול | https://vaadpro.org/admin |
| Hosting | Railway (railway.app) |

---

## Deploy לגרסה חדשה

### קבצים בחבילה

| קובץ | יעד בפרויקט |
|------|------------|
| server.js | שורש הפרויקט / |
| public/app.html | תיקיית public/ |
| public/tenant-portal.html | תיקיית public/ |
| public/admin.html | תיקיית public/ |

### פקודות (Windows)

```bat
git add server.js public/app.html public/tenant-portal.html
git commit -m "v2.9.0"
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

## Railway Environment Variables

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
| CNAME | @ | (Railway domain) |
| TXT | _railway-verify | railway-verify=... |
| TXT | resend._domainkey | (מ-Resend Dashboard) |
| TXT | _dmarc | v=DMARC1; p=none; |
| TXT | mail | v=spf1 include:amazonses.com ~all |

---

## Bridge — התקנה אצל לקוח

### Windows — התקנה אוטומטית
1. כנס לאפליקציה → הגדרות → **"הורד VaadPro-Setup"**
2. לחץ ימני → Properties → סמן **Unblock** → Apply → OK
3. לחץ פעמיים על הקובץ
4. הכנס את קוד ההתקנה מהאפליקציה (תקף 30 דקות)
5. לחץ **Install** — מתקין הכל אוטומטית (~2-3 דקות)

### Mac — התקנה אוטומטית
1. כנס לאפליקציה → הגדרות → **"הורד VaadPro-Setup (Mac)"**
2. פתח Terminal:
```bash
chmod +x ~/Downloads/VaadPro-Setup.sh && ~/Downloads/VaadPro-Setup.sh
```

### הפעלה יומית
- **Windows:** לחץ פעמיים על קיצור הדרך **"VaadPro Bridge"** בדסקטופ
- **Mac:** לחץ פעמיים על **"VaadPro Bridge.command"** בדסקטופ

---

## מודול אסיפות דיירים (חדש ב-v2.9.0)

### יצירת אסיפה — ועד הבית
1. כנס לטאב **📋 אסיפות** (תחת ניהול נכס)
2. לחץ **➕ אסיפה חדשה**
3. מלא: תאריך, סוג, משתתפים (מופרדים בפסיק), פרוטוקול
4. הוסף החלטות: טקסט + תאריך יעד + אחראי + סטטוס
5. לחץ **💾 שמור**

### שליחת סיכום לדיירים
1. בטבלת האסיפות לחץ **📤 שלח סיכום**
2. בחר ערוץ: וואטסאפ + מייל / וואטסאפ בלבד / מייל בלבד
3. לחץ **שלח** — כל דייר מקבל הודעה אישית עם לינק לפורטל שלו

**מבנה ההודעה שנשלחת:**
```
📋 סיכום אסיפת דיירים
תאריך: 01/06/2025
סוג: אסיפה כללית

📝 פרוטוקול:
[טקסט הפרוטוקול]

✅ החלטות:
1. [החלטה] (יעד: DD/MM/YYYY) — [אחראי]

🔗 לאישור קריאה:
https://vaadpro.org/tenant-portal.html?token=...

בברכה, ועד הבית
```

### אישור דיירים — פורטל הדייר
1. הדייר לוחץ על הלינק האישי בהודעה
2. עובר לטאב **📋 אסיפות**
3. קורא פרוטוקול + החלטות
4. לוחץ אחד מ:
   - **✅ מסכים/ה** — נרשם כאישור
   - **❌ לא מסכים/ה** → חלון הערה → ועד מקבל התראה
5. ניתן לשנות תגובה בכל עת

### מעקב אישורים — ועד הבית
1. בטבלת האסיפות לחץ **👥 אישורים**
2. רואים:
   - ✅ אישרו — שם + סוג + תאריך ושעה
   - ⏳ טרם אישרו — שמות בלבד
3. **תזכורת אוטומטית:** 5 ימים אחרי שליחת הסיכום — וואטסאפ/מייל אוטומטי למי שטרם אישר

### ניהול נכס (תחזוקה + תקלות)
- טאב **🏢 ניהול נכס** כולל שני sub-tabs:
  - **🏗️ תחזוקה** — משימות תחזוקה מחזוריות
  - **🔨 תקלות** — דיווח ומעקב תקלות

---

## פתרון בעיות

### Bridge לא מתחבר
- בדוק cloudUrl ב-config.json
- Railway → Deploy Logs → חפש `status=ready`
- ודא BRIDGE_SECRET זהה בשני הצדדים

### ווטסאפ מנותק
- פתח חלון Bridge → לחץ "חיבור ווטסאפ" → סרוק QR

### שגיאת ERR_REQUIRE_ESM בחלון Bridge
- מחק `C:\Users\...\Documents\VaadPro-Bridge` והרץ Setup מחדש

### אסיפה לא מופיעה בפורטל דייר
- ודא שהקובץ tenant-portal.html עודכן לגרסה החדשה
- בדוק Network בF12 — קריאה ל-`/api/portal/meetings?token=...` צריכה להחזיר 200

### דייר לא מקבל לינק אישי
- ודא ששלחת סיכום דרך **📤 שלח סיכום** (לא ידנית)
- הלינק נוצר אוטומטית בשליחה

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

---

## Changelog

### v2.9.0 (נוכחי)
- 📋 **מודול אסיפות דיירים מלא:**
  - יצירה/עריכה/מחיקה של אסיפות עם פרוטוקול + החלטות
  - שליחת סיכום אוטומטית עם לינק אישי לכל דייר
  - פורטל דייר: צפייה + אישור / אי-הסכמה עם הערה
  - מעקב אישורים לועד: מי אישר, מתי, סוג תגובה
  - תזכורת אוטומטית אחרי 5 ימים למי שלא אישר
  - התראה לועד על אי-הסכמת דייר
- 🏢 **ניהול נכס:** תחזוקה + תקלות אוחדו לטאב אחד עם sub-tabs

### v2.8.2
- BankSync Agent v1.2 (Playwright, אוצר החייל)
- openingDebt per tenant + calcTotalDebt()
- closeMonthUnpaid() ב-1 לחודש
- placeholders {חוב_קודם}/{סה"כ} בתבנית
- תיקון Invalid Date

### v2.5.9
- baileys נועל ל-6.5.0
- Mac setup.sh משופר
- Bulletin messages נשמרות בשרת

### v2.4.0
- שכחתי סיסמה — איפוס דרך מייל
- HTML email עם לוגו ועיצוב

### v2.2.0
- מערכת Plans: trial/basic/advanced/premium
- טאבים נעולים עם popup שדרוג

### v2.1.0
- מודול תחזוקת בניין
- Cron אוטומטי ב-08:00

### v2.0.0
- DNS פעיל: vaadpro.org → Railway
