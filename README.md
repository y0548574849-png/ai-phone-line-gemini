# קו טלפון AI — ימות המשיח + Gemini

מערכת Node.js לקבלת הקלטות קול מימות המשיח, עיבודן ב-Google Gemini והשמעת תשובה קולית למתקשר.

## הפעלה

הגדרו ב-Render:

- `GEMINI_API_KEYS` — מפתח Gemini
- `YEMOT_API_KEY` — טוקן ימות המשיח
- `DASHBOARD_PASSWORD` — סיסמת Dashboard
- `PUBLIC_BASE_URL` — כתובת השירות ב-Render
- `GEMINI_MODELS` — ברירת מחדל: `gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite`

השרת מגדיר אוטומטית את שלוחה 1 ל-`/yemot` בעת האתחול.

Dashboard: כתובת השירות הראשית.
Health: `/health`.

## אבטחה

אין לשמור מפתחות API ב-GitHub. השתמשו ב-Render Environment Variables.

## ללא Supabase

בגרסה זו היסטוריית השיחות נשמרת בזיכרון של השרת בלבד, ולכן אינה שורדת Restart/Deploy. ניתן להוסיף Supabase בעתיד.
