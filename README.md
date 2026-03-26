# 🏢 VaadPro v1.2 – SaaS לניהול ועד הבית

פלטפורמת SaaS לניהול ועדי בית מרובים — כל בניין מנוהל בנפרד עם login משלו.

---

## 🚀 התקנה מהירה

```bash
npm install
npm start
# → http://localhost:3002
```

---

## 🏗️ מבנה הפרויקט

```
vaadpro/
├── server.js              ← שרת multi-tenant (Express + WhatsApp + JWT)
├── package.json
├── public/
│   ├── index.html         ← Landing page + Login/Register
│   └── app.html           ← האפליקציה המלאה (עטופה ב-auth)
└── data/
    ├── _users.json        ← רשימת חשבונות (email, hash, tenantId, plan)
    └── {tenantId}.json    ← נתונים לכל בניין בנפרד
```

---

## 🔐 ניהול לקוחות (Admin API)

כל קריאה דורשת header: `x-admin-key: vaadpro-admin-2025`

### הצג כל הלקוחות
```bash
curl http://localhost:3002/api/admin/tenants \
  -H "x-admin-key: vaadpro-admin-2025"
```

### שנה plan של לקוח (אחרי קבלת תשלום)
```bash
curl -X POST http://localhost:3002/api/admin/set-plan \
  -H "x-admin-key: vaadpro-admin-2025" \
  -H "Content-Type: application/json" \
  -d '{"email":"customer@example.com","plan":"advanced"}'
```

**Plans:** `trial` | `basic` | `advanced` | `premium`

---

## 💰 זרימת עסקי — שלב ראשון (ידני)

1. לקוח נרשם → מקבל 30 יום ניסיון חינם
2. אחרי 30 יום → מקבל הודעת "תקופת הניסיון הסתיימה"
3. לקוח משלם לך (bit / PayPal / Tranzila)
4. אתה מריץ `set-plan` ← הלקוח פעיל שוב

**לעתיד:** שילוב Stripe/Tranzila לחיוב אוטומטי.

---

## ⚙️ משתני סביבה (אופציונלי)

```bash
PORT=3002                          # פורט השרת
JWT_SECRET=your-secret-here        # סוד לחתימת JWT
ADMIN_KEY=your-admin-key-here      # מפתח Admin
```

צור קובץ `.env` בתיקיית הפרויקט:
```
PORT=3002
JWT_SECRET=change-me-in-production-!@#$
ADMIN_KEY=my-secret-admin-key
```

---

## 🌐 Deploy ל-Production (Railway.app)

1. צור חשבון ב-[railway.app](https://railway.app)
2. חבר את ה-repo שלך
3. הוסף משתני סביבה (PORT, JWT_SECRET, ADMIN_KEY)
4. הוסף volume לתיקיית `data/` ו-`.wwebjs_auth/`
5. Railway יתן לך URL ציבורי → זה ה-URL של VaadPro

---

## 🔄 ההבדל מ-vaad-habayit (הגרסה הפנימית)

| | vaad-habayit | VaadPro |
|--|--|--|
| **בניינים** | 1 | ∞ |
| **Login** | אין | ✅ email + password |
| **נתונים** | data.json אחד | קובץ נפרד לכל בניין |
| **WhatsApp** | instance אחד | instance נפרד לכל בניין |
| **פורט** | 3000 | 3002 |
| **מיועד ל** | שימוש אישי | SaaS מסחרי |

---

*VaadPro v1.2 — Built with ❤️*
