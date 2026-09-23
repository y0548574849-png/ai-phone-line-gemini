import express from 'express';
import { YemotRouter, ExitError } from 'yemot-router2';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(x => x.trim()).filter(Boolean);
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(x => x.trim()).filter(Boolean);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '1234';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 55000);
const PER_MODEL_TIMEOUT_MS = Number(process.env.PER_MODEL_TIMEOUT_MS || 20000);
const YEMOT_TOKEN = (process.env.YEMOT_API_KEY || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const aiClients = GEMINI_KEYS.map(k => new GoogleGenerativeAI(k));
const modelCooldown = new Map();
const calls = new Map();
const conversations = [];
const logs = [];

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  logs.push(line); if (logs.length > 300) logs.shift();
  console.log(line);
}
function timeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => t = setTimeout(() => reject(Object.assign(new Error('timeout'), {status:408})), ms))]).finally(() => clearTimeout(t));
}
function clean(text) {
  return String(text || '').replace(/[\\*#_~`\[\]()<>]/g, ' ').replace(/[."“”‘’']/g, ' ').replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}
async function gemini(parts) {
  if (!aiClients.length) throw new Error('GEMINI_API_KEYS is missing');
  let last;
  for (const model of MODELS) for (let i = 0; i < aiClients.length; i++) {
    const key = `${model}:${i}`;
    if ((modelCooldown.get(key) || 0) > Date.now()) continue;
    try {
      const m = aiClients[i].getGenerativeModel({ model });
      const result = await timeout(m.generateContent({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json' } }), PER_MODEL_TIMEOUT_MS);
      modelCooldown.delete(key);
      return result.response.text();
    } catch (e) {
      last = e;
      if (e.status === 429 || /quota|429/i.test(e.message || '')) modelCooldown.set(key, Date.now() + 3600000);
      log('WARN', `${model} failed: ${e.message || e}`);
    }
  }
  throw last || new Error('No Gemini model available');
}
async function downloadRecording(recordPath) {
  const path = recordPath.startsWith('ivr2:') ? recordPath : `ivr2:${recordPath}`;
  if (!YEMOT_TOKEN) throw new Error('YEMOT_API_KEY is missing');
  const url = `https://www.call2all.co.il/ym/api/DownloadFile?token=${encodeURIComponent(YEMOT_TOKEN)}&path=${encodeURIComponent(path)}`;
  const r = await timeout(fetch(url), REQUEST_TIMEOUT_MS);
  if (!r.ok) throw new Error(`DownloadFile HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function askAudio(audio, history) {
  const historyText = history.length ? `\nהיסטוריית השיחה:\n${history.map((x,i)=>`סבב ${i+1}: מתקשר: ${x.user} | תשובה: ${x.reply}`).join('\n')}` : '';
  const instruction = `אתה עוזר קולי בטלפון. האזן להקלטה, הבן את השאלה וענה בעברית קצרה, ברורה וטבעית להקראה. אין Markdown, קישורים, כוכביות או סימנים מיותרים. שמור על שפה נקייה ומתאימה לציבור דתי. אין לתת תוכן מיני או אירוטי, פורנוגרפיה, עירום מיני, הימורים, סמים, פגיעה עצמית או אלימות גרפית. אם הנושא האסור הוא מרכז השאלה, החזר בדיוק: היי עצור הקו מסונן ולא ניתן לדבר איתו על תוכן שאינו מתאים לערכי הצניעות והחינוך. החזר JSON בלבד עם transcript ו-reply.${historyText}`;
  const raw = await gemini([{ inlineData: { mimeType: process.env.YEMOT_AUDIO_MIME_TYPE || 'audio/wav', data: audio.toString('base64') } }, { text: instruction }]);
  try {
    const s = raw.replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim();
    const x = JSON.parse(s); return { transcript: clean(x.transcript || 'הקלטה קולית'), reply: clean(x.reply || '') };
  } catch { return { transcript: 'הקלטה קולית', reply: clean(raw) }; }
}

const router = YemotRouter({ printLog: true, defaults: { removeInvalidChars: true }, uncaughtErrorHandler: e => log('ERROR', e?.message || e) });
router.all('/yemot', async call => {
  const callId = String(call?.callId || call?.values?.ApiCallId || Date.now());
  const phone = String(call?.values?.ApiPhone || call?.req?.query?.ApiPhone || 'לא מזוהה');
  const history = [];
  calls.set(callId, { callId, phone, startedAt: new Date().toISOString(), status: 'פעיל' });
  try {
    let first = true;
    while (true) {
      const prompt = first ? (process.env.WELCOME_MESSAGE || 'שלום וברוכים הבאים לקו הבינה המלאכותית. אמרו את שאלתכם ולסיום הקישו סולמית') : 'אמרו שאלה נוספת ולסיום הקישו סולמית או כוכבית ליציאה';
      first = false;
      const recordPath = await call.read([{ type: 'text', data: clean(prompt) }], 'record', { min_length: 1, no_confirm_menu: true });
      if (!recordPath || recordPath === 'None') return call.id_list_message([{ type: 'text', data: 'תודה רבה ולהתראות' }]);
      const audio = await downloadRecording(recordPath);
      if (audio.length < 500) { await call.id_list_message([{ type:'text', data:'לא שמעתי שאלה אנא נסו שוב' }], { prependToNextAction:true }); continue; }
      calls.get(callId).status = 'מעבד בינה מלאכותית';
      let answer;
      try { answer = await askAudio(audio, history); } catch (e) { log('ERROR', e.message || e); answer = { transcript:'', reply: e.status === 408 ? 'מצטערים לקח יותר מדי זמן לענות נסו שוב' : 'מצטערים הייתה תקלה בעיבוד השאלה נסו שוב' }; }
      history.push({ user: answer.transcript, reply: answer.reply });
      conversations.push({ time:new Date().toISOString(), phone, callId, user:answer.transcript, gemini:answer.reply });
      if (conversations.length > 1000) conversations.shift();
      await call.id_list_message([{ type:'text', data: answer.reply || 'מצטערים לא הצלחתי לענות' }], { prependToNextAction:true });
    }
  } finally { calls.delete(callId); }
});
app.use('/', router);

function auth(req,res,next){ if ((req.headers['x-dashboard-key'] || req.query.key) !== DASHBOARD_PASSWORD) return res.status(401).json({error:'Unauthorized'}); next(); }
app.get('/health',(req,res)=>res.json({ok:true,status:'online',models:MODELS,activeCalls:calls.size}));
app.post('/api/verify-auth',(req,res)=>res.status(req.body?.password===DASHBOARD_PASSWORD?200:401).json({ok:req.body?.password===DASHBOARD_PASSWORD}));
app.get('/api/conversations',auth,(req,res)=>res.json({conversations,activeCalls:[...calls.values()],totalMessages:conversations.length,totalCallers:new Set(conversations.map(x=>x.phone)).size,models:MODELS}));
app.get('/api/logs',auth,(req,res)=>res.json({logs}));
app.post('/api/test-ai',auth,async(req,res)=>{try{const text=await gemini([{text:req.body?.prompt||'אמור שלום בקצרה'}]);res.json({ok:true,response:text});}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.get('/',(req,res)=>res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>מרכז בקרה</title><style>body{font-family:Arial;max-width:1000px;margin:40px auto;padding:20px;background:#f5f5f5}.card{background:white;padding:20px;margin:12px 0;border-radius:12px}textarea,input,button{font:inherit;padding:10px;margin:5px}button{cursor:pointer}.chat{border-top:1px solid #ddd;padding:10px}</style><div class="card"><h1>מרכז בקרה — קו AI</h1><input id="p" type="password" placeholder="סיסמה"><button onclick="login()">כניסה</button><span id="s"></span></div><div id="main" style="display:none"><div class="card"><b id="stats"></b></div><div class="card"><textarea id="q" rows="3" cols="60" placeholder="בדיקת AI"></textarea><button onclick="test()">בדיקה</button><pre id="out"></pre></div><div class="card"><h2>שיחות</h2><div id="list"></div></div></div><script>let k='';async function login(){let r=await fetch('/api/verify-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})});if(r.ok){k=p.value;main.style.display='block';load()}else s.textContent=' סיסמה שגויה'}async function load(){let r=await fetch('/api/conversations',{headers:{'x-dashboard-key':k}}),d=await r.json();stats.textContent=`${d.totalMessages} הודעות | ${d.totalCallers} מתקשרים | ${d.activeCalls.length} שיחות פעילות`;list.innerHTML=d.conversations.slice().reverse().slice(0,30).map(x=>`<div class="chat"><b>${x.phone}</b><br>מתקשר: ${x.user}<br>AI: ${x.gemini}</div>`).join('')||'אין שיחות';}async function test(){let r=await fetch('/api/test-ai',{method:'POST',headers:{'Content-Type':'application/json','x-dashboard-key':k},body:JSON.stringify({prompt:q.value})});out.textContent=JSON.stringify(await r.json(),null,2)}setInterval(()=>{if(k)load()},5000)</script></html>`));

async function configureYemot(){
  if (!YEMOT_TOKEN || !PUBLIC_BASE_URL) return log('WARN','YEMOT_API_KEY or PUBLIC_BASE_URL missing; automatic IVR setup skipped');
  const qs = new URLSearchParams({token:YEMOT_TOKEN,path:'ivr2:/1',type:'api',api_link:`${PUBLIC_BASE_URL}/yemot`,api_wait:'yes',api_wait_play:'yes',api_wait_answer_music_on_hold:'yes',api_wait_answer_music_on_hold_different:'M0000',api_timeout:'60',tts_rate:'2',rate:'2'});
  try { const r=await fetch(`https://www.call2all.co.il/ym/api/UpdateExtension?${qs}`); log(r.ok?'INFO':'ERROR',`Yemot extension setup: HTTP ${r.status}`); } catch(e){log('ERROR',`Yemot setup failed: ${e.message}`)}
}

const port=process.env.PORT||3000;
app.listen(port,()=>{log('INFO',`Server listening on ${port}`);configureYemot()});
process.on('unhandledRejection',e=>{if(!(e instanceof ExitError))log('ERROR',e?.message||e)});
process.on('uncaughtException',e=>{if(!(e instanceof ExitError))log('ERROR',e?.message||e)});
