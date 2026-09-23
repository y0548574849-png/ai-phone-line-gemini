import fs from 'fs';
const source = fs.readFileSync('./server.js', 'utf8');
const start = source.indexOf("app.get('/',");
const end = source.indexOf('\n\nasync function configureYemot', start);
let fixed = source;
if (start >= 0 && end > start) {
  fixed = source.slice(0, start) + "app.get('/', (req, res) => res.type('html').send('<!doctype html><html lang=\"he\" dir=\"rtl\"><meta charset=\"utf-8\"><title>קו AI</title><body style=\"font-family:Arial;max-width:900px;margin:40px auto;padding:20px\"><h1>מרכז בקרה — קו AI</h1><p>השרת פעיל.</p><p><a href=\"/health\">בדיקת Health</a></p></body></html>'));" + source.slice(end);
}
fs.writeFileSync('./server-runtime.mjs', fixed, 'utf8');
await import('./server-runtime.mjs');
