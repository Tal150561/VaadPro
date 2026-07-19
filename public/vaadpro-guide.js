/* ============================================================================
 * VaadPro — מדריך משתמש מובנה (Single Source of Truth)
 * ----------------------------------------------------------------------------
 * קובץ אחד שמכיל את כל תוכן המדריך + חלון עזרה עצמאי (CSS משלו).
 *
 * הטמעה ב-app.html:  הוסף לפני </body> את השורה:
 *     <script src="vaadpro-guide.js"></script>
 *   זהו. המודול:
 *     • דורס את window.showHelp(topic) — כל כפתורי ה-? הקיימים יפתחו את הסקשן המלא.
 *     • מזריק כפתור "📖 מדריך" לכותרת (אם קיימת) או צף בפינה.
 *
 * API גלובלי (window.VaadProGuide):
 *     .open(id)        – פותח את החלון על סקשן מסוים (id או alias של showHelp)
 *     .openFull()      – פותח את החלון מההתחלה (מדריך מלא)
 *     .mount(elId)     – משבץ את המדריך המלא בתוך אלמנט (לעמוד עצמאי)
 *     .sections        – מערך הסקשנים (לבדיקות/תוספות)
 *
 * הוספת פיצ'ר עתידי = הוספת אובייקט אחד למערך SECTIONS (ראה הערה למטה).
 * ========================================================================== */
(function () {
  if (window.VaadProGuide) return;

  var VERSION = '2.13';

  /* ---- מיפוי נושאי showHelp הישנים -> מזהי סקשנים ---- */
  var ALIAS = {
    wa: 'whatsapp', whatsapp: 'whatsapp',
    banksync: 'payments', messages: 'payments', payments: 'payments',
    tenants: 'tenants', reports: 'reports', trends: 'trends',
    bulletin: 'bulletin', settings: 'settings',
    property: 'property', maintenance: 'property', tickets: 'property',
    meetings: 'meetings', troubleshoot: 'troubleshoot', portal: 'portal'
  };

  /* ---- קבוצות לתפריט הצד ---- */
  var GROUPS = [
    { title: 'התחלה',          ids: ['intro', 'quickstart', 'login', 'home', 'whatsapp'] },
    { title: 'ניהול שוטף',     ids: ['tenants', 'payments', 'reports', 'trends', 'bulletin'] },
    { title: 'הגדרות ותחזוקה', ids: ['settings', 'property', 'meetings', 'troubleshoot'] },
    { title: 'סביבת הדיירים',  ids: ['portal'] },
    { title: 'תפעול שוטף',     ids: ['routine', 'faq'] }
  ];

  /* =========================================================================
   * SECTIONS — מקור האמת היחיד.
   * כל אובייקט: { id, tab, icon, title, body }
   *   id    – מזהה ייחודי (חייב להתאים למפתח switchTab כדי שכפתור ? ימופה אליו)
   *   tab   – מפתח הטאב במערכת (null אם אין טאב ישיר)
   *   icon  – אימוג'י
   *   title – כותרת
   *   body  – HTML
   * >>> פיצ'ר חדש? הוסף כאן אובייקט אחד + הוסף את ה-id לקבוצה ב-GROUPS. <<<
   * ======================================================================= */
  var SECTIONS = [
  {
    id: 'intro', tab: null, icon: '👋', title: 'ברוכים הבאים ל-VaadPro',
    body:
      '<p class="vpg-lead">VaadPro היא מערכת לניהול ועד בית (או כל ארגון גובה תשלומים) — מהדפדפן, ללא התקנה. המערכת עוזרת לנהל דיירים, לגבות תשלומים חודשיים, לזהות מי שילם מתוך קובץ הבנק, לשלוח תזכורות ב-WhatsApp ובמייל, להפיק דוחות הוצאות, לנהל תחזוקה ותקלות, ולתעד אסיפות דיירים.</p>' +
      '<div class="vpg-cards">' +
        '<div class="vpg-fcard"><div class="ic">👥</div><b>ניהול דיירים</b><span>רשימה, פרטי קשר, חשבונות וחובות.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">💳</div><b>גביית תשלומים</b><span>זיהוי משלמים אוטומטי מקובץ הבנק.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">💬</div><b>תזכורות אוטומטיות</b><span>WhatsApp ומייל, ידני או בתזמון.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">📊</div><b>דוחות ומגמות</b><span>ניתוח הוצאות והשוואת תקופות.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">🏗️</div><b>תחזוקה ותקלות</b><span>משימות תקופתיות ותיעוד תקלות.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">📋</div><b>אסיפות דיירים</b><span>הזמנות, אישורי הגעה וסיכומים.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">🔗</div><b>פורטל דיירים</b><span>כל דייר רואה את מצב התשלומים שלו.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">🛡️</div><b>גיבוי אוטומטי</b><span>הנתונים מגובים יומית בשרת ובמייל.</span></div>' +
      '</div>' +
      '<div class="vpg-box ok"><div class="bt">✅ ללא התקנה</div>הכול עובד מהדפדפן. גם חיבור ה-WhatsApp נעשה בסריקת ברקוד פעם אחת — ללא הורדת תוכנה וללא צורך שהמחשב יהיה דלוק.</div>' +
      '<div class="vpg-box tip"><div class="bt">💡 כפתורי העזרה במערכת</div>בכל מסך יש כפתור <code>?</code> ליד הכותרת — לחיצה עליו פותחת את הפרק הרלוונטי במדריך זה.</div>'
  },
  {
    id: 'quickstart', tab: null, icon: '🚀', title: 'התחלה מהירה ב-4 שלבים',
    body:
      '<p>בכניסה הראשונה נפתח אוטומטית אשף "מדריך התחלה מהירה". אפשר לעקוב אחריו, או לבצע ידנית את ארבעת השלבים:</p>' +
      '<ol class="vpg-steps">' +
        '<li><strong>הוסיפו דיירים</strong> — טאב 👥 דיירים ← "הוסף דייר", או ייבאו מאקסל. הגדירו לכל דייר <strong>מילות חיפוש לבנק</strong>.</li>' +
        '<li><strong>הגדירו תשלום חודשי</strong> — טאב ⚙️ הגדרות ← סכום חודשי, יום שליחה ושעה.</li>' +
        '<li><strong>חברו ווטסאפ</strong> — כפתור "חיבור ווטסאפ" בכותרת ← סרקו ברקוד ← מחובר.</li>' +
        '<li><strong>שלחו תזכורת ראשונה</strong> — טאב 💳 תשלומים ← "WA לכולם". מומלץ לשלוח קודם לדייר בודד לבדיקה.</li>' +
      '</ol>'
  },
  {
    id: 'login', tab: null, icon: '🔑', title: 'התחברות, הרשמה ואיפוס סיסמה',
    body:
      '<div class="vpg-path">מסך פתיחה · לפני הכניסה למערכת</div>' +
      '<h3>הרשמה (ועד חדש)</h3>' +
      '<ol class="vpg-steps">' +
        '<li>עברו ללשונית "הרשמה".</li>' +
        '<li>מלאו <strong>כתובת הבניין</strong> (חובה — עם השלמה אוטומטית), שם בניין (אופציונלי), פרטי קשר, טלפון, מייל וסיסמה.</li>' +
        '<li>לחצו "הרשמה חינמית" — מתחיל ניסיון בן 30 יום.</li>' +
      '</ol>' +
      '<h3>כניסה</h3>' +
      '<p>הזינו מייל וסיסמה ולחצו "כניסה". המערכת זוכרת אתכם בדרך כלל.</p>' +
      '<h3>שכחתי סיסמה</h3>' +
      '<ol class="vpg-steps">' +
        '<li>במסך הכניסה לחצו "שכחתי סיסמה".</li>' +
        '<li>הזינו מייל — יישלח קישור.</li>' +
        '<li>בקישור הגדירו סיסמה חדשה (לפחות 6 תווים) ואשרו שנית.</li>' +
      '</ol>' +
      '<div class="vpg-box warn"><div class="bt">⚠️ המייל לא הגיע?</div>בדקו בספאם. הקישור תקף לזמן מוגבל — אם פג, בקשו חדש.</div>'
  },
  {
    id: 'home', tab: null, icon: '🏠', title: 'מסך הבית והכותרת',
    body:
      '<div class="vpg-path">העליון של כל מסך · גלוי תמיד</div>' +
      '<h3>הכותרת</h3>' +
      '<ul><li><strong>לוגו ושם הבניין</strong> — בצד ימין.</li>' +
      '<li><strong>תג חיבור ווטסאפ</strong> — בצד שמאל, מציג מצב חיבור; לחיצה פותחת/מתחילה חיבור.</li></ul>' +
      '<h3>פס הסטטיסטיקה</h3>' +
      '<table class="vpg-t"><tr><th>מדד</th><th>משמעות</th></tr>' +
      '<tr><td>דיירים רשומים</td><td>מספר הדיירים במערכת.</td></tr>' +
      '<tr><td>שילמו החודש</td><td>כמה סומנו כמשלמים.</td></tr>' +
      '<tr><td>ממתינים</td><td>כמה טרם שילמו.</td></tr>' +
      '<tr><td>סה"כ לגבייה</td><td>הסכום הצפוי לחודש.</td></tr></table>' +
      '<h3>שורת הטאבים</h3><p>תפריט ראשי לכל מסכי המערכת — כל טאב מתואר בפרק נפרד במדריך זה.</p>'
  },
  {
    id: 'whatsapp', tab: 'settings', icon: '📱', title: 'חיבור ווטסאפ',
    body:
      '<div class="vpg-path">כפתור בכותרת · וגם בטאב הגדרות</div>' +
      '<p>החיבור נעשה <strong>פעם אחת</strong> בסריקת ברקוד — ללא התקנה.</p>' +
      '<h3>חיבור ראשוני</h3>' +
      '<ol class="vpg-steps">' +
        '<li>לחצו "חיבור ווטסאפ" (תג הכותרת או כרטיס ההגדרות).</li>' +
        '<li>יופיע ברקוד QR. בטלפון: WhatsApp ← מכשירים מקושרים ← קישור מכשיר.</li>' +
        '<li>סרקו את הברקוד.</li>' +
        '<li>התג יהפוך ל-🟢 מחובר.</li>' +
      '</ol>' +
      '<div class="vpg-box ok"><div class="bt">✅ עובד גם כשהמחשב כבוי</div>ה-WhatsApp מחובר מהשרת. לאחר החיבור הראשוני התזכורות יישלחו גם כשהמחשב סגור.</div>' +
      '<h3>אם התנתק</h3><p>לחצו שוב "חיבור ווטסאפ" וסרקו ברקוד חדש. הנתונים נשמרים.</p>' +
      '<h3>החלפת מספר</h3><p>הגדרות ← "החלפת מספר WhatsApp" ← "נתק WhatsApp" ← "חיבור ווטסאפ" ← סרקו עם המספר החדש.</p>' +
      '<div class="vpg-box warn"><div class="bt">⚠️ הברקוד נעלם / "לא ניתן לקשר מכשירים כעת"?</div>סרקו מהר אחרי שהברקוד מופיע. בחסימה זמנית מצד WhatsApp — המתינו 1–3 שעות ובדקו ב"מכשירים מקושרים" שאין חיבורים ישנים מיותרים.</div>'
  },
  {
    id: 'tenants', tab: 'tenants', icon: '👥', title: 'טאב דיירים',
    body:
      '<div class="vpg-path">טאב ראשי · ניהול רשימת הדיירים</div>' +
      '<p class="vpg-lead">הבסיס של המערכת. כל דייר מייצג נכס (דירה/יחידה) עם פרטי קשר, סכום חודשי וחשבונות.</p>' +
      '<h3>הוספת דייר</h3>' +
      '<table class="vpg-t"><tr><th>שדה</th><th>חובה?</th><th>הסבר</th></tr>' +
      '<tr><td>תווית נכס</td><td>אופציונלי</td><td>"דירה 4" / "נחלה 12". ריק = שם איש הקשר.</td></tr>' +
      '<tr><td>שם מלא</td><td>✅</td><td>רצוי כפי שמופיע בבנק.</td></tr>' +
      '<tr><td>טלפון</td><td>✅</td><td>10 ספרות, <code>0501234567</code>.</td></tr>' +
      '<tr><td>אימייל</td><td>אופציונלי</td><td>לשליחת הודעות/דוחות במייל.</td></tr>' +
      '<tr><td>מילות חיפוש</td><td>מומלץ מאוד</td><td>ביטויים שמזהים את הדייר בקובץ הבנק.</td></tr>' +
      '<tr><td>סכום אישי ₪</td><td>אופציונלי</td><td>סכום שונה מברירת המחדל.</td></tr>' +
      '<tr><td>חוב פתוח ₪</td><td>אופציונלי</td><td>חוב קודם; ערך שלילי = זכות לדייר.</td></tr></table>' +
      '<div class="vpg-box danger"><div class="bt">🔑 מילות חיפוש — הכי חשוב!</div>הזינו מילים שמזהות את הדייר בקובץ הבנק, למשל <code>כהן י, העברה 052</code>. מפריד = <strong>פסיק</strong>. כך יזוהה תשלום גם אם שילמו בן/בת הזוג או חשבון אחר. <strong>בלי מילות חיפוש — אין זיהוי תשלום בייבוא בנק.</strong></div>' +
      '<div class="vpg-box tip"><div class="bt">💡 דיוק</div>השתמשו בביטוי שלם, למשל <code>דירה 3</code>, כדי שלא יתאים בטעות ל"דירה 30".</div>' +
      '<h3>ייבוא דיירים מאקסל</h3>' +
      '<table class="vpg-t"><tr><th>שם ✅</th><th>טלפון ✅</th><th>מייל</th><th>מילות_חיפוש</th></tr>' +
      '<tr><td>ישראל כהן</td><td>0501234567</td><td>israel@email.com</td><td>כהן י, דירה 3</td></tr></table>' +
      '<ul><li>שורה ראשונה = כותרות. שם וטלפון חובה.</li><li>טלפון זהה לא ייווסף פעמיים.</li></ul>' +
      '<h3>עריכה וייצוא</h3>' +
      '<ul><li><strong>✏️ עריכה</strong> — עדכון כל פרט בשורת הדייר.</li>' +
      '<li><strong>שיוך חשבונות</strong> — אם הוגדרו חשבונות נוספים, שייכו אותם לדייר וציינו משלם (בעלים/שוכר).</li>' +
      '<li><strong>📤 ייצוא לאקסל</strong> — כולל מספר דירה שזוהה אוטומטית ממילות החיפוש.</li></ul>'
  },
  {
    id: 'payments', tab: 'payments', icon: '💳', title: 'טאב תשלומים',
    body:
      '<div class="vpg-path">טאב ראשי · גבייה, זיהוי משלמים ותזכורות</div>' +
      '<p class="vpg-lead">הלב התפעולי: שליחת תזכורות, ייבוא קובץ הבנק לזיהוי מי שילם, ומעקב סטטוס חודשי.</p>' +
      '<h3>שליחת תזכורות</h3>' +
      '<div class="vpg-cards">' +
        '<div class="vpg-fcard"><b>💬 WA לכולם</b><span>תזכורת לכל הדיירים.</span></div>' +
        '<div class="vpg-fcard"><b>💬 WA רק לממתינים</b><span>רק למי שלא שילם.</span></div>' +
        '<div class="vpg-fcard"><b>🔗 שלח פורטל לנבחרים</b><span>קישור אישי לפורטל.</span></div>' +
        '<div class="vpg-fcard"><b>🔄 אפס סטטוס</b><span>איפוס סימוני נשלח/שולם.</span></div>' +
      '</div>' +
      '<div class="vpg-box tip"><div class="bt">💡 בדיקה לפני שליחה המונית</div>שלחו קודם לדייר בודד (כפתור ליד שמו) כדי לוודא שהתבנית תקינה.</div>' +
      '<h3>ייבוא קובץ בנק — זיהוי מי שילם</h3>' +
      '<ol class="vpg-steps">' +
        '<li>גררו קובץ Excel/CSV של תנועות מהבנק.</li>' +
        '<li><strong>מיפוי עמודות</strong> — בחרו שם/תיאור, סכום, תאריך, הערות.</li>' +
        '<li>"💾 שמור מבנה לעתיד" — המיפוי ייטען אוטומטית בפעם הבאה.</li>' +
        '<li>הזינו <strong>סכום</strong> ו<strong>סבילות (±₪)</strong>, או השאירו ריק לזיהוי לפי שם.</li>' +
        '<li>בחרו את <strong>החודש</strong> של התשלומים.</li>' +
        '<li>"🔍 זהה משלמים".</li>' +
      '</ol>' +
      '<div class="vpg-box warn"><div class="bt">⚠️ לא מזוהה אף דייר?</div>בדרך כלל חסרות מילות חיפוש או שאינן תואמות לשם בבנק. תקנו בטאב "דיירים".</div>' +
      '<h4>🔗 BankSync Agent (אוטומטי — אופציונלי)</h4>' +
      '<p>כלי שמותקן על המחשב, מתחבר לבנק ושולח תנועות ל-VaadPro אוטומטית. הלחצן "🔗 BankSync" במסך המיפוי מפיק מפתח API. בלי הכלי — ממשיכים ידנית כרגיל.</p>' +
      '<h3>סטטוס תשלומים החודש</h3>' +
      '<ul><li>טבלת שילם / ממתין / נשלחה תזכורת לכל דייר.</li>' +
      '<li>אפשר <strong>לסמן/לבטל תשלום ידנית</strong> (למשל מזומן).</li>' +
      '<li>"📊 ייצא מעקב שנתי לאקסל" — טבלת כל החודשים מול כל הדיירים.</li></ul>' +
      '<h3>תשלום חלקי</h3>' +
      '<p>אם דייר שילם <strong>פחות</strong> מהסכום החודשי (למשל 150 ₪ מתוך 230 ₪), המערכת מזהה זאת אוטומטית:</p>' +
      '<ul><li>הסטטוס יוצג כ<strong>"שולם חלקית"</strong> עם פירוט <span class="vpg-var">שולם / נדרש</span>.</li>' +
      '<li>ההפרש (<strong>היתרה</strong>) נספר כחוב פתוח מיד, ומופיע בעמודת החוב.</li>' +
      '<li>הדייר <strong>ימשיך לקבל תזכורות</strong> על היתרה עד להשלמת התשלום (בעזרת המשתנה <span class="vpg-var">{יתרה}</span> בתבנית).</li>' +
      '<li>בסגירת החודש (ה-1 בכל חודש) היתרה שלא שולמה <strong>מצטברת לחוב המצטבר</strong> של הדייר — בדיוק כמו חודש שלא שולם כלל.</li></ul>' +
      '<div class="vpg-box tip"><div class="bt">💡 עודף תשלום</div>אם דייר שילם <strong>יותר</strong> מהנדרש, העודף נשמר כ<strong>יתרת זכות</strong> ומקוזז אוטומטית מהחודש הבא.</div>'
  },
  {
    id: 'reports', tab: 'reports', icon: '📊', title: 'טאב דוחות הוצאות',
    body:
      '<div class="vpg-path">טאב ראשי · ניתוח הוצאות הבניין לדיירים</div>' +
      '<p class="vpg-lead">הופכים את תנועות הבנק לדוח הוצאות מסודר לפי קטגוריות — לשליחה לדיירים בשקיפות.</p>' +
      '<ol class="vpg-steps">' +
        '<li><strong>טען קובץ בנק</strong> — Excel/CSV, כל הבנקים נתמכים.</li>' +
        '<li><strong>זהה עמודות</strong> — תאריך, תיאור, חיוב ← "שמור מבנה".</li>' +
        '<li><strong>בחר טווח תאריכים</strong> ← "נתח הוצאות" (סיווג אוטומטי לקטגוריות).</li>' +
        '<li><strong>סמן הוצאות לכלול</strong> והוסף הערה לכל שורה. שורות שיק/המחאה מסומנות ב-✏️.</li>' +
        '<li><strong>שמור דוח למגמות</strong> ונסח הודעה לשליחה.</li>' +
      '</ol>' +
      '<div class="vpg-box tip"><div class="bt">💡 הערות נשמרות רק לאחר "💾 שמור דוח"</div>הקלדת הערה ושליחת הודעה בלבד — לא שומרת אותה. שמרו דוח כדי לשמר פירוט.</div>' +
      '<h3>גרפים וייצוא</h3>' +
      '<ul><li>"📊 גרף קטגוריות" — עוגה/עמודות + ייצוא PNG.</li>' +
      '<li>דוח HTML מלא עם גרפים מופק מטאב "ניתוח מגמות" — נפתח בכל דפדפן וניתן להדפסה ל-PDF.</li></ul>'
  },
  {
    id: 'trends', tab: 'trends', icon: '📈', title: 'טאב ניתוח מגמות',
    body:
      '<div class="vpg-path">טאב ראשי · השוואת הוצאות בין תקופות</div>' +
      '<p class="vpg-lead">לאחר שמירת כמה דוחות, הטאב משווה ביניהם ומציג מגמות לאורך זמן.</p>' +
      '<h3>דוחות שמורים</h3><p>רשימת הדוחות ששמרתם בטאב "דוחות הוצאות".</p>' +
      '<h3>ניתוח השוואתי</h3>' +
      '<ul><li>בחרו תקופת בסיס ותקופה להשוואה, ורזולוציה: חודשי/רבעוני/שנתי.</li>' +
      '<li>טבלה לכל קטגוריה: סכומים, שינוי ₪ ו-%, מגמה. הרחבת קטגוריה (▸) מציגה פירוט שתי התקופות זו מול זו.</li>' +
      '<li>גרף השוואה וגרף ציר זמן.</li></ul>' +
      '<h3>ייצוא</h3>' +
      '<div class="vpg-cards">' +
        '<div class="vpg-fcard"><b>📥 ייצא לאקסל</b><span>כולל גיליון "פירוט שורות".</span></div>' +
        '<div class="vpg-fcard"><b>📊 ייצא דוח מלא</b><span>HTML עצמאי עם גרפים, ניתן להדפסה ל-PDF.</span></div>' +
      '</div>'
  },
  {
    id: 'bulletin', tab: 'bulletin', icon: '📣', title: 'טאב הודעות ועד הבית',
    body:
      '<div class="vpg-path">טאב ראשי · הודעות כלליות לדיירים</div>' +
      '<p class="vpg-lead">לשליחת עדכונים, הזמנות והתראות (לא תזכורות תשלום) ב-WhatsApp או מייל.</p>' +
      '<ol class="vpg-steps">' +
        '<li>הזינו נושא (אופציונלי) ותוכן.</li>' +
        '<li>בחרו ערוץ: 💬 WhatsApp או 📧 מייל.</li>' +
        '<li>בחרו דיירים ← שלחו.</li>' +
      '</ol>' +
      '<h4>שליחה במייל</h4><p>מופיעים שדות נוספים: נושא המייל וצירוף קובץ (PDF/Excel/Word/תמונה).</p>' +
      '<div class="vpg-box warn"><div class="bt">⚠️ מייל</div>נשלח רק לדיירים שהוגדר להם מייל.</div>' +
      '<h3>משתנים והיסטוריה</h3>' +
      '<ul><li>משתנים: <span class="vpg-var">{שם}</span> <span class="vpg-var">{תאריך}</span> — יוחלפו אוטומטית.</li>' +
      '<li>כל ההודעות שנשלחו מתועדות בתחתית הטאב.</li></ul>'
  },
  {
    id: 'settings', tab: 'settings', icon: '⚙️', title: 'טאב הגדרות',
    body:
      '<div class="vpg-path">טאב ראשי · הגדרת המערכת והתאמה אישית</div>' +
      '<p class="vpg-lead">מרכז השליטה: סכום גבייה, תזמון, תבנית הודעה, גיבוי ועוד. ההגדרות נשמרות אוטומטית.</p>' +
      '<h3>הגדרות תשלום ותזמון</h3>' +
      '<table class="vpg-t"><tr><th>הגדרה</th><th>הסבר</th></tr>' +
      '<tr><td>סכום חודשי (₪)</td><td>הסכום הנגבה מכל דייר; משמש גם לזיהוי תשלומים בבנק.</td></tr>' +
      '<tr><td>יום בחודש לשליחה</td><td>יום התזכורת האוטומטית (1–28).</td></tr>' +
      '<tr><td>שעת שליחה</td><td>שעת התזכורת האוטומטית.</td></tr>' +
      '<tr><td>חודש לשליחה</td><td><strong>אוטומטי</strong> (מומלץ): עד ה-10 = חודש קודם, אחריו = נוכחי. או בחירה ידנית.</td></tr></table>' +
      '<div class="vpg-box tip"><div class="bt">🔁 שלח עכשיו</div>מפעיל את השליחה מיד, בלי להמתין למועד המתוזמן.</div>' +
      '<h3>סוג הארגון ומונחים</h3><p>בחירת ועד בית / קיבוץ משנה מונחים בממשק. ב"הגדרות מתקדמות" אפשר להתאים מונחים. אין השפעה על תבנית ה-WhatsApp או חישוב החוב.</p>' +
      '<h3>תבנית הודעה</h3>' +
      '<p>נוסח תזכורת התשלום. משתנים שיוחלפו לכל דייר:</p>' +
      '<p><span class="vpg-var">{שם}</span><span class="vpg-var">{חודש}</span><span class="vpg-var">{סכום}</span>' +
      '<span class="vpg-var">{חוב_קודם}</span><span class="vpg-var">{סה"כ}</span>' +
      '<span class="vpg-var">{יתרה}</span>' +
      '<span class="vpg-var">{חשבונות}</span><span class="vpg-var">{לינק_פורטל}</span></p>' +
      '<ul><li>{חוב_קודם} ו-{סה"כ} — רק אם יש חוב פתוח.</li>' +
      '<li>{יתרה} — רק אם הדייר שילם <strong>חלקית</strong> החודש; מציג את היתרה שנותרה להשלמה.</li>' +
      '<li>{חשבונות} — רק אם יש חשבונות נוספים פתוחים.</li>' +
      '<li>{לינק_פורטל} — קישור אישי לפורטל הדייר.</li></ul>' +
      '<div class="vpg-box tip"><div class="bt">✨ שיפור עם AI</div>הקלידו הנחיה ("יותר נחמד" / "קצר ב-50%") ולחצו "שפר עם AI". אל תשכחו "💾 שמור תבנית".</div>' +
      '<h3>חשבונות נוספים</h3><p>הגדרת חשבונות מעבר לדמי הוועד (קרן שיפוצים, חניה...). לאחר שמירה — שייכו לדיירים וציינו משלם (בעלים/שוכר).</p>' +
      '<h3>גיבוי ושחזור</h3>' +
      '<ul><li><strong>💾 הורד גיבוי</strong> — שומר את כל הנתונים לקובץ. מומלץ חודשית.</li>' +
      '<li><strong>📂 שחזר מגיבוי</strong> — טוען נתונים מקובץ.</li></ul>' +
      '<div class="vpg-box danger"><div class="bt">⚠️ שחזור מוחק את הקיים</div>גבו תחילה! (המערכת יוצרת גיבוי בטיחות אוטומטי לפני כל שחזור.)</div>' +
      '<div class="vpg-box ok"><div class="bt">🛡️ גיבוי אוטומטי</div>גיבוי יומי בשרת + עותק למייל — רשת ביטחון נוספת.</div>' +
      '<h3>שיתוף VaadPro</h3><p>שליחת הזמנה לחבר שמנהל ועד בית — 30 יום ניסיון חינם.</p>'
  },
  {
    id: 'property', tab: 'property', icon: '🏢', title: 'טאב ניהול נכס',
    body:
      '<div class="vpg-path">טאב ראשי · תחזוקה ותקלות</div>' +
      '<p class="vpg-lead">ניהול הצד הפיזי של הבניין, בשתי תת-לשוניות: תחזוקה ותקלות.</p>' +
      '<h3>🏗️ תחזוקה</h3>' +
      '<ul><li><strong>➕ הוסף משימה</strong> — שם, אייקון, תדירות (חודשי–שנתי), ביצוע אחרון, ימי התראה.</li>' +
      '<li><strong>📋 טען רשימה מוצעת</strong> — משימות תחזוקה נפוצות כנקודת פתיחה.</li>' +
      '<li>הטבלה מציגה סטטוס, ביצוע אחרון ותאריך הבא. משימות שהגיע זמנן מודגשות.</li></ul>' +
      '<h3>🔨 תקלות</h3>' +
      '<ul><li><strong>+ תקלה חדשה</strong> — תיאור, קטגוריה, עדיפות (דחוף/רגיל).</li>' +
      '<li>סטטוסים: פתוח · בטיפול · ממתין לחומרים · נקבע תור · נסגר · לא רלוונטי.</li>' +
      '<li>סינון לפי סטטוס, עדיפות וקטגוריה.</li></ul>' +
      '<div class="vpg-box tip"><div class="bt">💡 קשר לפורטל</div>דיירים יכולים לדווח תקלות מהפורטל, והן יופיעו כאן אוטומטית.</div>'
  },
  {
    id: 'meetings', tab: 'meetings', icon: '📋', title: 'טאב אסיפות',
    body:
      '<div class="vpg-path">טאב ראשי · אסיפות דיירים</div>' +
      '<p class="vpg-lead">ניהול אסיפות מהזמנה ועד סיכום, כולל מעקב אישורי הגעה.</p>' +
      '<ol class="vpg-steps">' +
        '<li>"➕ אסיפה חדשה" — נושא, תאריך, שעה, מיקום.</li>' +
        '<li>שלחו הזמנה (WhatsApp/מייל); דיירים מאשרים דרך הפורטל.</li>' +
        '<li>עקבו אחר 👥 אישורי קריאה והגעה.</li>' +
        '<li>לאחר האסיפה — "📤 שלח סיכום אסיפה".</li>' +
      '</ol>' +
      '<div class="vpg-box tip"><div class="bt">💡 אישורי הגעה</div>בפורטל כל דייר לוחץ "מסכים/ה" או "לא מסכים/ה", וניתן לשנות. הסטטוס מתעדכן כאן בזמן אמת.</div>'
  },
  {
    id: 'troubleshoot', tab: 'troubleshoot', icon: '🔧', title: 'טאב פתרון בעיות',
    body:
      '<div class="vpg-path">טאב ראשי · מאגר תקלות נפוצות</div>' +
      '<ul><li>הקלידו בחיפוש כדי לסנן (ווטסאפ / בנק / מייל...).</li>' +
      '<li>לחצו על שאלה לפתיחת הפתרון.</li>' +
      '<li>"📄 פתח מדריך מלא" — פותח את כל המאגר בחלון להדפסה ל-PDF.</li></ul>' +
      '<p>הנושאים: חיבור/התנתקות WhatsApp, ברקוד QR, שליחת הודעות, ייבוא בנק וזיהוי משלמים, ייבוא דיירים, מיילים וקבצים מצורפים, גרפים בדוחות, ושגיאות חיבור. תקציר מהיר בפרק "שאלות נפוצות".</p>'
  },
  {
    id: 'portal', tab: null, icon: '🔗', title: 'פורטל הדיירים',
    body:
      '<div class="vpg-path">מסך נפרד · מה הדייר רואה</div>' +
      '<p class="vpg-lead">לכל דייר קישור אישי לפורטל (נשלח ב-WhatsApp/מייל, או דרך <span class="vpg-var">{לינק_פורטל}</span>). פתוח ללא סיסמה ומציג רק את המידע שלו.</p>' +
      '<div class="vpg-cards">' +
        '<div class="vpg-fcard"><div class="ic">💳</div><b>תשלומים</b><span>מצב תשלומים, חוב והיסטוריה.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">🔨</div><b>תקלות</b><span>דיווח ומעקב תקלות.</span></div>' +
        '<div class="vpg-fcard"><div class="ic">📋</div><b>אסיפות</b><span>צפייה ואישור/אי-אישור הגעה.</span></div>' +
      '</div>' +
      '<div class="vpg-box tip"><div class="bt">💡 שקיפות</div>הפורטל מצמצם פניות טלפוניות — הדייר רואה בעצמו את מצבו.</div>' +
      '<div class="vpg-box warn"><div class="bt">⚠️ "לינק לא תקין"</div>ייתכן שהקישור התיישן או הועתק חלקית — שלחו קישור חדש מטאב "תשלומים".</div>'
  },
  {
    id: 'routine', tab: null, icon: '🗓️', title: 'שגרת עבודה חודשית מומלצת',
    body:
      '<div class="vpg-path">תפעול שוטף</div>' +
      '<ol class="vpg-steps">' +
        '<li><strong>תחילת החודש — תזכורות.</strong> אוטומטי אם הוגדר תזמון, אחרת "WA לכולם".</li>' +
        '<li><strong>אמצע/סוף החודש — ייבוא בנק.</strong> "זהה משלמים" יסמן מי שילם.</li>' +
        '<li><strong>מעקב ממתינים.</strong> "WA רק לממתינים" + סימון מזומן ידני.</li>' +
        '<li><strong>שקיפות הוצאות.</strong> הפיקו דוח ושלחו לדיירים.</li>' +
        '<li><strong>תחזוקה ותקלות.</strong> בדקו משימות מתקרבות ותקלות פתוחות.</li>' +
        '<li><strong>גיבוי.</strong> "💾 הורד גיבוי" אחת לחודש.</li>' +
      '</ol>' +
      '<table class="vpg-t"><tr><th>אוטומטי</th><th>פירוט</th></tr>' +
      '<tr><td>תזכורות מתוזמנות</td><td>ביום ובשעה שהוגדרו, גם כשהמחשב כבוי.</td></tr>' +
      '<tr><td>סגירת חודש</td><td>ב-1 בחודש חוב לא משולם מתגלגל ל"חוב פתוח".</td></tr>' +
      '<tr><td>גיבוי יומי</td><td>בשרת + עותק במייל.</td></tr></table>'
  },
  {
    id: 'faq', tab: null, icon: '❓', title: 'שאלות נפוצות ופתרון תקלות',
    body:
      '<h3>WhatsApp</h3>' +
      '<h4>הסטטוס "לא מחובר"</h4><p>לחצו על תג החיבור ← "חיבור ווטסאפ" ← סרקו ברקוד חדש.</p>' +
      '<h4>הודעות לא נשלחות</h4><p>ודאו 🟢 "מחובר"; אחרת חברו מחדש.</p>' +
      '<h3>ייבוא קובץ בנק</h3>' +
      '<h4>אפס משלמים זוהו</h4><p>חסרות מילות חיפוש או שאינן תואמות לשם בבנק. בדקו גם מיפוי עמודות וחודש.</p>' +
      '<h4>דייר זוהה אך לא שילם</h4><p>מילות החיפוש רחבות מדי — צמצמו לביטוי ייחודי ובטלו סימון ידנית.</p>' +
      '<h3>דיירים ומיילים</h3>' +
      '<h4>כפילויות בייבוא אקסל</h4><p>אותו פורמט טלפון (05X…); טלפון זהה לא יתווסף פעמיים.</p>' +
      '<h4>"טלפון לא תקין"</h4><p>10 ספרות בפורמט ישראלי <code>0501234567</code>.</p>' +
      '<h4>מיילים לא מגיעים</h4><p>ודאו מייל תקין לדייר; בדקו ספאם.</p>' +
      '<h3>כללי</h3>' +
      '<h4>חזרה למסך הכניסה</h4><p>ההתחברות פגה — התחברו שוב. הנתונים שמורים.</p>' +
      '<h4>איטי / לא נטען</h4><p>רעננו (Ctrl+R); נסו דפדפן אחר או בדקו אינטרנט.</p>' +
      '<div class="vpg-box tip"><div class="bt">📄 מאגר מלא</div>טאב "פתרון בעיות" כולל מאגר רחב עם חיפוש. תמיכה: <a href="mailto:vaadpro15@gmail.com">vaadpro15@gmail.com</a>.</div>'
  }
  ];

  /* ---- אינדקס מהיר ---- */
  var BY_ID = {};
  SECTIONS.forEach(function (s) { BY_ID[s.id] = s; });

  /* =========================================================================
   * CSS — מוזרק פעם אחת, ממוקד תחת .vpg-root כדי לא להתנגש עם האפליקציה
   * ======================================================================= */
  var CSS = '' +
  '.vpg-root{--vpg-blue:#2563eb;--vpg-navy:#1e3a5f;--vpg-ink:#1f2937;--vpg-ink2:#4b5563;--vpg-ink3:#6b7280;--vpg-line:#e5e7eb;--vpg-card:#fff;direction:rtl;}' +
  '.vpg-overlay{position:fixed;inset:0;background:rgba(15,27,48,.55);z-index:99999;display:none;}' +
  '.vpg-overlay.show{display:block;}' +
  '.vpg-shell{position:absolute;inset:3vh 3vw;background:#f4f6fb;border-radius:16px;overflow:hidden;display:flex;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:Heebo,-apple-system,Segoe UI,Arial,sans-serif;color:var(--vpg-ink);}' +
  '.vpg-side{width:270px;flex-shrink:0;background:#0f1b30;color:#cbd5e1;overflow-y:auto;}' +
  '.vpg-side .b{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid #1e293b;position:sticky;top:0;background:#0f1b30;}' +
  '.vpg-side .b h3{margin:0;font-size:1.05rem;font-weight:800;color:#fff;}.vpg-side .b h3 span{color:#3b82f6;}' +
  '.vpg-side .b small{color:#64748b;font-size:.68rem;display:block;}' +
  '.vpg-srch{padding:12px 14px 4px;position:sticky;top:60px;background:#0f1b30;}' +
  '.vpg-srch input{width:100%;padding:8px 11px;border-radius:8px;border:1px solid #334155;background:#172338;color:#e2e8f0;font-family:inherit;font-size:.83rem;}' +
  '.vpg-srch input::placeholder{color:#64748b;}' +
  '.vpg-nav{padding:8px 10px;}' +
  '.vpg-nav .g{font-size:.66rem;letter-spacing:.07em;color:#475569;margin:14px 10px 5px;font-weight:700;text-transform:uppercase;}' +
  '.vpg-nav a{display:block;color:#94a3b8;padding:6px 12px;border-radius:7px;font-size:.84rem;cursor:pointer;border-right:3px solid transparent;text-decoration:none;}' +
  '.vpg-nav a:hover{background:#172338;color:#e2e8f0;}' +
  '.vpg-nav a.on{background:rgba(37,99,235,.18);color:#fff;border-right-color:#3b82f6;font-weight:600;}' +
  '.vpg-main{flex:1;overflow-y:auto;position:relative;}' +
  '.vpg-top{position:sticky;top:0;background:linear-gradient(135deg,#1e3a5f,#2563eb);color:#fff;padding:14px 26px;display:flex;align-items:center;justify-content:space-between;z-index:5;}' +
  '.vpg-top h2{margin:0;font-size:1.15rem;font-weight:800;}' +
  '.vpg-x{background:rgba(255,255,255,.15);border:none;color:#fff;width:34px;height:34px;border-radius:9px;font-size:1.1rem;cursor:pointer;}' +
  '.vpg-x:hover{background:rgba(255,255,255,.3);}' +
  '.vpg-content{padding:26px 34px 80px;max-width:820px;}' +
  '.vpg-content section{scroll-margin-top:70px;margin-bottom:10px;}' +
  '.vpg-content h2.sh{font-size:1.5rem;font-weight:800;color:var(--vpg-navy);margin:30px 0 6px;padding-bottom:9px;border-bottom:3px solid var(--vpg-line);display:flex;gap:9px;align-items:center;}' +
  '.vpg-content h3{font-size:1.12rem;font-weight:700;color:var(--vpg-blue);margin:20px 0 5px;}' +
  '.vpg-content h4{font-size:.98rem;font-weight:700;margin:14px 0 3px;}' +
  '.vpg-content p{margin:7px 0;line-height:1.7;}.vpg-content ul,.vpg-content ol{padding-right:22px;line-height:1.7;}' +
  '.vpg-lead{font-size:1.02rem;color:var(--vpg-ink2);}' +
  '.vpg-path{font-size:.76rem;color:var(--vpg-ink3);background:#eef1f6;display:inline-block;padding:3px 11px;border-radius:20px;margin-bottom:8px;}' +
  '.vpg-content code{background:#eef2ff;color:#3730a3;padding:1px 6px;border-radius:5px;font-size:.86em;font-family:Courier New,monospace;direction:ltr;display:inline-block;}' +
  '.vpg-var{display:inline-block;background:#0f1b30;color:#7dd3fc;border-radius:6px;padding:2px 8px;font-size:.82rem;margin:2px;direction:ltr;font-family:monospace;}' +
  '.vpg-box{border-radius:11px;padding:12px 16px;margin:14px 0;border:1px solid;font-size:.92rem;}' +
  '.vpg-box .bt{font-weight:700;margin-bottom:2px;}' +
  '.vpg-box.tip{background:#eff6ff;border-color:#bfdbfe;color:#1e40af;}' +
  '.vpg-box.warn{background:#fffbeb;border-color:#fde68a;color:#92400e;}' +
  '.vpg-box.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}' +
  '.vpg-box.ok{background:#ecfdf5;border-color:#a7f3d0;color:#065f46;}' +
  '.vpg-steps{counter-reset:vst;list-style:none;padding:0;margin:12px 0;}' +
  '.vpg-steps>li{counter-increment:vst;position:relative;padding:9px 44px 9px 12px;margin:7px 0;background:var(--vpg-card);border:1px solid var(--vpg-line);border-radius:10px;line-height:1.6;}' +
  '.vpg-steps>li::before{content:counter(vst);position:absolute;right:11px;top:10px;width:25px;height:25px;background:var(--vpg-blue);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.8rem;}' +
  '.vpg-t{width:100%;border-collapse:collapse;margin:12px 0;font-size:.88rem;background:var(--vpg-card);border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);}' +
  '.vpg-t th{background:var(--vpg-navy);color:#fff;text-align:right;padding:8px 12px;font-weight:600;}' +
  '.vpg-t td{padding:8px 12px;border-top:1px solid var(--vpg-line);vertical-align:top;}' +
  '.vpg-t tr:nth-child(even) td{background:#fafbfe;}' +
  '.vpg-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin:14px 0;}' +
  '.vpg-fcard{background:var(--vpg-card);border:1px solid var(--vpg-line);border-radius:11px;padding:13px 14px;}' +
  '.vpg-fcard .ic{font-size:1.4rem;}.vpg-fcard b{display:block;margin:5px 0 2px;color:var(--vpg-navy);}.vpg-fcard span{font-size:.83rem;color:var(--vpg-ink2);}' +
  '.vpg-empty{display:none;padding:40px;text-align:center;color:var(--vpg-ink3);}' +
  '.vpg-fab{position:fixed;bottom:20px;left:20px;z-index:9998;background:#2563eb;color:#fff;border:none;border-radius:30px;padding:11px 18px;font-family:Heebo,sans-serif;font-size:.9rem;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,.45);display:flex;align-items:center;gap:7px;}' +
  '.vpg-fab:hover{background:#1d4ed8;}' +
  '.vpg-sidebtn{display:none;}' +
  '@media(max-width:760px){.vpg-shell{inset:0;border-radius:0;}.vpg-side{position:absolute;inset:0 auto 0 0;right:0;transform:translateX(100%);transition:.25s;z-index:8;width:80%;}.vpg-side.open{transform:translateX(0);}.vpg-sidebtn{display:inline-flex;background:rgba(255,255,255,.15);border:none;color:#fff;width:34px;height:34px;border-radius:9px;font-size:1.1rem;cursor:pointer;margin-left:8px;}.vpg-content{padding:18px 16px 70px;}}';

  /* =========================================================================
   * בניית ה-HTML של המדריך (משותף לחלון ולעמוד עצמאי)
   * ======================================================================= */
  function buildToc() {
    var html = '';
    GROUPS.forEach(function (g) {
      html += '<div class="g">' + g.title + '</div>';
      g.ids.forEach(function (id) {
        var s = BY_ID[id];
        if (s) html += '<a data-goto="' + id + '">' + s.icon + ' ' + s.title + '</a>';
      });
    });
    return html;
  }
  function buildContent() {
    var html = '';
    GROUPS.forEach(function (g) {
      g.ids.forEach(function (id) {
        var s = BY_ID[id];
        if (!s) return;
        html += '<section id="vpg-sec-' + s.id + '"><h2 class="sh">' + s.icon + ' ' + s.title + '</h2>' + s.body + '</section>';
      });
    });
    return html;
  }

  /* =========================================================================
   * חלון העזרה (overlay) — נבנה פעם אחת, lazy
   * ======================================================================= */
  var root, overlay, sideEl, navEl, contentEl, mainEl, titleEl, searchEl, emptyEl, built = false;

  function ensureCss() {
    if (document.getElementById('vpg-css')) return;
    var st = document.createElement('style');
    st.id = 'vpg-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function buildOverlay() {
    if (built) return;
    ensureCss();
    root = document.createElement('div');
    root.className = 'vpg-root';
    root.innerHTML =
      '<div class="vpg-overlay" id="vpgOverlay">' +
        '<div class="vpg-shell">' +
          '<aside class="vpg-side" id="vpgSide">' +
            '<div class="b"><div><h3>Vaad<span>Pro</span></h3><small>מדריך למשתמש · גרסה ' + VERSION + '</small></div></div>' +
            '<div class="vpg-srch"><input type="text" id="vpgSearch" placeholder="🔍 חיפוש במדריך..."></div>' +
            '<nav class="vpg-nav" id="vpgNav">' + buildToc() + '</nav>' +
          '</aside>' +
          '<div class="vpg-main" id="vpgMain">' +
            '<div class="vpg-top"><h2 id="vpgTitle">📖 מדריך VaadPro</h2><div>' +
              '<button class="vpg-sidebtn" id="vpgSideBtn">☰</button>' +
              '<button class="vpg-x" id="vpgClose">✕</button></div></div>' +
            '<div class="vpg-content" id="vpgContent">' + buildContent() +
              '<div class="vpg-empty" id="vpgEmpty">לא נמצאו תוצאות. נסו מילה אחרת.</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    overlay   = document.getElementById('vpgOverlay');
    sideEl    = document.getElementById('vpgSide');
    navEl     = document.getElementById('vpgNav');
    contentEl = document.getElementById('vpgContent');
    mainEl    = document.getElementById('vpgMain');
    titleEl   = document.getElementById('vpgTitle');
    searchEl  = document.getElementById('vpgSearch');
    emptyEl   = document.getElementById('vpgEmpty');

    document.getElementById('vpgClose').onclick = close;
    document.getElementById('vpgSideBtn').onclick = function () { sideEl.classList.toggle('open'); };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('show')) close(); });

    navEl.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-goto]'); if (!a) return;
      gotoSection(a.getAttribute('data-goto'));
      sideEl.classList.remove('open');
    });
    searchEl.addEventListener('input', runSearch);
    mainEl.addEventListener('scroll', spy);
    built = true;
  }

  function gotoSection(id) {
    var el = document.getElementById('vpg-sec-' + id);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function spy() {
    var y = mainEl.scrollTop + 90, cur = null;
    SECTIONS.forEach(function (s) {
      var el = document.getElementById('vpg-sec-' + s.id);
      if (el && el.offsetTop <= y) cur = s.id;
    });
    navEl.querySelectorAll('a').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-goto') === cur);
    });
  }
  function runSearch() {
    var q = (searchEl.value || '').trim().toLowerCase(), any = false;
    SECTIONS.forEach(function (s) {
      var el = document.getElementById('vpg-sec-' + s.id); if (!el) return;
      var hit = !q || el.textContent.toLowerCase().indexOf(q) !== -1;
      el.style.display = hit ? '' : 'none';
      if (hit) any = true;
      var a = navEl.querySelector('a[data-goto="' + s.id + '"]');
      if (a) a.style.opacity = hit ? '1' : '.3';
    });
    emptyEl.style.display = any ? 'none' : 'block';
  }

  function open(topic) {
    buildOverlay();
    var id = ALIAS[topic] || (BY_ID[topic] ? topic : null);
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
    if (id) {
      titleEl.textContent = (BY_ID[id].icon || '📖') + ' ' + BY_ID[id].title;
      setTimeout(function () { gotoSection(id); }, 40);
    } else {
      titleEl.textContent = '📖 מדריך VaadPro';
      mainEl.scrollTop = 0;
    }
  }
  function openFull() { buildOverlay(); overlay.classList.add('show'); document.body.style.overflow = 'hidden'; titleEl.textContent = '📖 מדריך VaadPro'; mainEl.scrollTop = 0; }
  function close() { if (overlay) { overlay.classList.remove('show'); document.body.style.overflow = ''; } }

  /* mount — שיבוץ המדריך המלא בתוך עמוד עצמאי (לא overlay) */
  function mount(elId) {
    ensureCss();
    var host = document.getElementById(elId); if (!host) return;
    host.classList.add('vpg-root');
    host.innerHTML =
      '<div style="display:flex;min-height:100vh;">' +
        '<aside class="vpg-side" style="position:sticky;top:0;height:100vh;">' +
          '<div class="b"><div><h3>Vaad<span>Pro</span></h3><small>מדריך למשתמש · גרסה ' + VERSION + '</small></div></div>' +
          '<div class="vpg-srch"><input type="text" id="vpgSearchM" placeholder="🔍 חיפוש..."></div>' +
          '<nav class="vpg-nav" id="vpgNavM">' + buildToc() + '</nav>' +
        '</aside>' +
        '<div class="vpg-main" id="vpgMainM" style="background:#f4f6fb;">' +
          '<div class="vpg-content">' + buildContent() + '<div class="vpg-empty" id="vpgEmptyM">לא נמצאו תוצאות.</div></div>' +
        '</div>' +
      '</div>';
    var navM = document.getElementById('vpgNavM'), srchM = document.getElementById('vpgSearchM'), emptyM = document.getElementById('vpgEmptyM');
    navM.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-goto]'); if (!a) return;
      var el = document.getElementById('vpg-sec-' + a.getAttribute('data-goto'));
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth' });
    });
    srchM.addEventListener('input', function () {
      var q = srchM.value.trim().toLowerCase(), any = false;
      SECTIONS.forEach(function (s) {
        var el = document.getElementById('vpg-sec-' + s.id); if (!el) return;
        var hit = !q || el.textContent.toLowerCase().indexOf(q) !== -1;
        el.style.display = hit ? '' : 'none'; if (hit) any = true;
        var a = navM.querySelector('a[data-goto="' + s.id + '"]'); if (a) a.style.opacity = hit ? '1' : '.3';
      });
      emptyM.style.display = any ? 'none' : 'block';
    });
  }

  /* =========================================================================
   * הזרקת כפתור "📖 מדריך" — לכותרת אם נמצאת, אחרת כפתור צף
   * ======================================================================= */
  function injectButton() {
    if (document.getElementById('vpgOpenBtn')) return;
    var header = document.querySelector('header .header-inner') || document.querySelector('header');
    var btn = document.createElement('button');
    btn.id = 'vpgOpenBtn';
    btn.type = 'button';
    btn.textContent = '📖 מדריך';
    btn.onclick = function () { openFull(); };
    if (header) {
      btn.style.cssText = 'background:rgba(37,99,235,.12);color:#2563eb;border:1px solid rgba(37,99,235,.3);border-radius:8px;padding:6px 12px;font-family:inherit;font-size:.82rem;font-weight:700;cursor:pointer;margin-inline:8px;';
      header.appendChild(btn);
    } else {
      btn.className = 'vpg-fab';
      ensureCss();
      document.body.appendChild(btn);
    }
  }

  /* =========================================================================
   * חיבור: דריסת showHelp + הזרקת כפתור + חשיפת API
   * ======================================================================= */
  // שמירת ה-showHelp הישן (לא חובה, לתאימות לאחור)
  var _legacyShowHelp = window.showHelp;
  window.showHelp = function (topic) { open(topic); };

  window.VaadProGuide = {
    version: VERSION,
    sections: SECTIONS,
    open: open,
    openFull: openFull,
    close: close,
    mount: mount,
    _legacyShowHelp: _legacyShowHelp
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }
})();
