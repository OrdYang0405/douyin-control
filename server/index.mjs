/**
 * 星辰语音 · 本地复刻后端（零依赖）
 *
 * 设计原则：接口路径与参数**照抄原系统**，这样他们的桌面采集端（弹幕助手）
 * 只要把 platforms.json 里的回调域名改成这里，就能直接给我方喂弹幕。
 *
 *   POST /socket/index/bullet            弹幕上报（原客户端直连）
 *   GET  /socket/xiecheng_login/needLogin 登录态探针（客户端会问）
 *   POST /api/v1.token/build             登录换 token
 *   GET  /api/v1.member/tmymember        租户信息（登录态探针）
 *   GET  /api/v1.member/stream           直播位列表
 *   POST /api/v1.liveapi/addStream       新建直播位 → 返回 live_id
 *   POST /api/v1.liveapi/editStream      改名 / 开播 / 关播 / 续期
 *   POST /api/v1.liveapi/delStream       删除直播位
 *   POST /api/v1.liveapi/makeAudio       文本→语音（TTS）
 *   GET  /api/v1.live/getBullet          弹幕分页
 *   GET  /api/live/events?live_id=       实时弹幕 SSE（本地控制台用）
 *   GET  /                               控制台页面
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { speak, voices as listVoices, DEFAULT_VOICE } from './speak.mjs';
import { save as saveTtsConfig, masked as maskedTtsConfig } from './tts-config.mjs';
import { attachDouyin } from './douyin.mjs';
import { scheduler } from './voice-schedule.mjs';
import { composeScript, maybeInterjection } from './speak-script.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'db.json');
const MEDIA = path.join(ROOT, 'media');
const PORT = Number(process.env.PORT || 8080);
const SELF = process.env.PUBLIC_BASE || `http://127.0.0.1:${PORT}`;
fs.mkdirSync(MEDIA, { recursive: true });

/* ---------------------------------- 存储 ---------------------------------- */

/** 预热默认话术：覆盖直播间最常说的开场/促单/答疑，提前合成好才能秒出 */
const DEFAULT_WARMUP = [
  '欢迎来到直播间，点点关注不迷路。',
  '这款今天到手价很划算，喜欢的家人赶紧拍。',
  '下方小黄车一号链接，点进去就能下单。',
  '全国包邮，今天拍明天就发货。',
  '数量不多了，卖完就恢复原价。',
  '有问题打在公屏上，我一个一个回答。',
  '质量大家可以放心，七天无理由退换。',
  '感谢家人们的支持，喜欢的抓紧时间。',
];

const seed = () => ({
  tenants: [{
    id: 1, product: '星辰语音（本地复刻）', beian_number: '冀ICP备2025107457号',
    hour_price: '0.40', mycode: 'LOCAL001', app_version: '1.0.0',
    app_uplog: '本地复刻版', httphost: '127.0.0.1',
  }],
  users: [],
  tokens: {},
  streams: [],
  bullets: [],
  kami: [],
  seq: { user: 0, stream: 0, bullet: 0 },
});

let db;
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { db = seed(); }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
  }, 300);
}
const nextId = (k) => ++db.seq[k];

if (!db.users.length) {
  // 首次启动建一个可登录账号：admin / admin123
  db.users.push({
    id: nextId('user'), tenant: 1, username: 'admin',
    pass: sha('admin123'), minutes: 600, created: now(),
  });
  save();
}
if (!db.kami.length) {
  ['KAMI-TRIAL-30', 'KAMI-60', 'KAMI-300'].forEach((code, i) => {
    db.kami.push({ code, minutes: [30, 60, 300][i], used: null });
  });
  save();
}

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function rid(n = 8) { return crypto.randomBytes(n).toString('hex'); }
function genLiveId() {
  const used = new Set(db.streams.map((s) => s.live_id));
  let v;
  do { v = String(100000 + Math.floor(Math.random() * 899999)); } while (used.has(v));
  return v;
}

/* ---------------------------------- 工具 ---------------------------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}
const ok = (res, data = []) => send(res, 200, { code: 200, msg: 'ok', time: Math.floor(Date.now() / 1000), data });
const fail = (res, code, msg) => send(res, 200, { code, msg, time: Math.floor(Date.now() / 1000), data: null });

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      raw = raw.replace(/^\uFEFF/, '').trim();
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        try { return resolve(JSON.parse(raw || '{}')); } catch { /* 落到表单解析 */ }
      }
      const out = {};
      for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
      if (!Object.keys(out).length && raw.startsWith('{')) {
        try { return resolve(JSON.parse(raw)); } catch { /* ignore */ }
      }
      resolve(out);
    });
  });
}

function auth(req) {
  const t = String(req.headers.authorization || req.headers['x-token'] || '').replace(/^Bearer\s+/i, '').trim();
  const uid = db.tokens[t];
  if (!uid) return null;
  return db.users.find((u) => u.id === uid) || null;
}

/* -------------------------------- TTS 队列 -------------------------------- */

const ttsQueue = [];
let ttsBusy = false;

function enqueueSpeech(stream, bullet) {
  if (!stream || stream.speakMode === 'off') return;
  const text = renderSpeech(stream, bullet);
  if (!text) return;
  ttsQueue.push({ stream, bullet, text });
  if (ttsQueue.length > 30) ttsQueue.splice(0, ttsQueue.length - 30);
  drainTTS();
}

function renderSpeech(stream, b) {
  // 改写层：把弹幕变成「像人说的话」，而不是逐字复读
  const script = composeScript({
    nickname: b.nickname || '',
    content: b.content || '',
    template: stream.template || '',
    script: stream.refScript || '',            // 参考话术（对应原系统的 content 字段）
    role: stream.__lastRole || 'single',
  });
  if (stream.speakMode === 'keyword') {
    const kws = String(stream.keywords || '').split(/[,，\s]+/).filter(Boolean);
    if (!kws.some((k) => (b.content || '').includes(k))) return '';
  }
  // 插入随机语气词（模拟 sui­yyin_zhu / suiyyin_fu）
  const inter = maybeInterjection(stream.__lastRole || 'single');
  const text = (inter ? `${inter}，${script}` : script).slice(0, 260);
  return text;
}

async function drainTTS() {
  if (ttsBusy || !ttsQueue.length) return;
  ttsBusy = true;
  const job = ttsQueue.shift();
  try {
    // 双人对播：按 hostVoice / assistantVoice / zhu_baifenbi 决定这句话用谁的声音
    const picked = scheduler.pick(job.stream, job.text);
    job.stream.__lastRole = picked.role;
    let voice = picked.voice || job.stream.voice || DEFAULT_VOICE;

    // A+C 混合策略（预生成 + 缓存命中）：
    //   1) 先查克隆缓存：命中就直接放克隆音色（真本人声音）
    //   2) 未命中：用 Edge 即时出声，同时后台生成克隆版存起来
    //   3) 下一个相似请求就能命中缓存，越跑越像本人
    let engineHint = '';
    const cloneKey = String(voice).startsWith('clone:') ? sha(job.text + '|' + voice).slice(0, 16) : '';
    if (cloneKey && fs.existsSync(path.join(MEDIA, cloneKey + '.wav'))) {
      // 命中克隆缓存：这才是「真本人声音」
      engineHint = 'clone';
      broadcast(job.stream.live_id, {
        kind: 'speech', text: job.text, url: `/media/${cloneKey}.wav`,
        bulletId: job.bullet.id, role: picked.role, voice, engineHint,
      });
    } else {
      if (cloneKey) {
        // 未命中：Edge 即时顶上，克隆后台生成（不阻塞）
        engineHint = 'clone-pending';
        prefetchClone(job, voice, picked);
        voice = quickFallbackVoice(voice, picked.role);
      }
      const key = sha(job.text + '|' + voice).slice(0, 16);
      const base = path.join(MEDIA, key);
      let ext = 'mp3';
      if (fs.existsSync(base + '.mp3')) ext = 'mp3';
      else if (fs.existsSync(base + '.wav')) ext = 'wav';
      else {
        const r = await speak({ text: job.text, voice, base });
        ext = r.ext;
      }
      broadcast(job.stream.live_id, {
        kind: 'speech', text: job.text, url: `/media/${key}.${ext}`,
        bulletId: job.bullet.id, role: picked.role, voice, engineHint,
      });
    }
  } catch (e) {
    broadcast(job.stream.live_id, { kind: 'tts-error', text: job.text, error: String(e.message || e) });
  } finally {
    ttsBusy = false;
    // 句间停顿（对应原系统的 suitingdun）：避免一句接一句像机器报菜名
    const gap = Number(job?.stream?.pauseMs ?? 400) + Math.floor(Math.random() * 500);
    setTimeout(drainTTS, Math.max(120, gap));
  }
}

/** 克隆音色对应的「同性别快速替身」，用于即时出声 */
function quickFallbackVoice(cloneVoice, role) {
  // 按角色给不同性别，避免主播助播同声
  if (role === 'host') return 'edge:zh-CN-YunxiNeural';      // 男
  if (role === 'assistant') return 'edge:zh-CN-XiaoxiaoNeural'; // 女
  return 'edge:zh-CN-XiaoxiaoNeural';
}

/** 后台生成克隆音频；完成后直接推给前端播放（观众听到真正的克隆声音） */
const cloneJobs = new Set();
function prefetchClone(job, cloneVoice, picked) {
  const key = sha(job.text + '|' + cloneVoice).slice(0, 16);
  const base = path.join(MEDIA, key);
  if (fs.existsSync(base + '.wav') || cloneJobs.has(key)) return;
  cloneJobs.add(key);
  speak({ text: job.text, voice: cloneVoice, base })
    .then(() => {
      broadcast(job.stream.live_id, {
        kind: 'clone-ready',
        text: job.text,
        url: `/media/${key}.wav`,
        role: picked.role,
        voice: cloneVoice,
      });
    })
    .catch((e) => {
      broadcast(job.stream.live_id, {
        kind: 'sys',
        text: `克隆失败，继续用云端音色：${String(e.message || e).slice(0, 80)}`,
      });
    })
    .finally(() => cloneJobs.delete(key));
}

/* ---------------------------------- SSE ---------------------------------- */

const rooms = new Map(); // live_id -> Set<res>

/** 抖音直连会话：streamId -> handle */
const douyinLinks = new Map();
function stopDouyin(streamId) {
  const h = douyinLinks.get(streamId);
  if (h) {
    h.stop();
    douyinLinks.delete(streamId);
  }
}

/** 一条弹幕落库 + 推送 + 触发语音（HTTP 上报与抖音直连共用） */
function ingest(stream, { type = '1', nickname = '', content = '', platform = '' }) {
  const item = {
    id: nextId('bullet'), live_id: stream.live_id, type: String(type || '1'),
    nickname, content, platform, created: now(),
  };
  db.bullets.push(item);
  if (db.bullets.length > 5000) db.bullets.splice(0, db.bullets.length - 5000);
  stream.bullets = (stream.bullets || 0) + 1;
  save();
  broadcast(stream.live_id, { kind: 'bullet', ...item });
  enqueueSpeech(stream, item);
  return item;
}function broadcast(liveId, obj) {
  const set = rooms.get(String(liveId));
  if (!set) return;
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of set) { try { res.write(payload); } catch {} }
}

/* --------------------------------- 路由 ---------------------------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, SELF);
  let p = u.pathname;
  // 兼容两种写法：原系统是 /api/v1.member/xxx（点号），前端有时写成 /api/v1/member/xxx（斜杠）
  if (/^\/api\/v\d+\//.test(p)) p = p.replace(/^\/api\/(v\d+)\//, '/api/$1.');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    /* ---------- 静态 ---------- */
    if (p === '/' || p === '/console') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'console.html')), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/media/')) {
      const f = path.join(MEDIA, path.basename(p));
      if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      const mime = f.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
      return send(res, 200, fs.readFileSync(f), mime);
    }

    /* ---------- 原客户端接口 ---------- */
    if (p === '/socket/index/bullet' && req.method === 'POST') {
      const b = await body(req);
      if (!b.live_id) return fail(res, 404, '参数为空');
      const stream = db.streams.find((s) => String(s.live_id) === String(b.live_id));
      if (!stream) return fail(res, 404, '直播间标识错误');
      ingest(stream, {
        type: b.type, nickname: b.nickname || '', content: b.content || '', platform: b.platformKey || '',
      });
      return ok(res);
    }
    if (p === '/socket/xiecheng_login/needLogin') return ok(res);
    if (p === '/socket/httpapi/checkApp') return ok(res);
    if (p === '/socket/httpapi/httpaddLog') return ok(res);

    /* ---------- 账号 ---------- */
    if (p === '/api/v1.token/build' && req.method === 'POST') {
      const b = await body(req);
      const user = db.users.find((x) => x.username === b.username);
      if (!user) return fail(res, 401, '账号不存在');
      if (user.pass !== sha(b.password || '')) return fail(res, 401, '密码错误');
      const token = rid(16);
      db.tokens[token] = user.id;
      save();
      return ok(res, { access_token: token, minutes: user.minutes, username: user.username });
    }
    if (p === '/api/v1.member/reg' && req.method === 'POST') {
      const b = await body(req);
      if (!b.username || String(b.username).length < 2) return fail(res, 401, '账号最少2位');
      if (String(b.password || '').length < 6) return fail(res, 401, '密码最少6位');
      if (db.users.some((x) => x.username === b.username)) return fail(res, 401, '账号已存在');
      const user = { id: nextId('user'), tenant: 1, username: b.username, pass: sha(b.password), minutes: 30, created: now() };
      db.users.push(user); save();
      return ok(res, { id: user.id });
    }

    /* ---------- 租户 ---------- */
    if (p === '/api/v1.member/tmymember') {
      const tenant = db.tenants.find((t) => String(t.id) === String(u.searchParams.get('merchid') || 1)) || db.tenants[0];
      const me = auth(req);
      return ok(res, {
        member: me ? [{ id: me.id, username: me.username, minutes: me.minutes }] : [],
        home: { ...tenant, site_logo: '', fulllogo: '' },
      });
    }

    /* ---------- 直播位 ---------- */
    if (p === '/api/v1.member/stream' || p === '/api/v1.liveapi/appStream') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      return ok(res, db.streams.filter((s) => s.user === me.id));
    }
    if (p === '/api/v1.liveapi/addStream' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      const s = {
        id: nextId('stream'), user: me.id, name: b.name || b.txt || '直播任务',
        live_id: genLiveId(), running: false, minutes: 0, bullets: 0,
        speakMode: 'keyword', voice: DEFAULT_VOICE,
        hostVoice: '', assistantVoice: '', zhu_baifenbi: 30,
        template: '{nickname}说：{content}', keywords: '价格,多少钱,怎么买,链接',
        created: now(),
      };
      db.streams.push(s); save();
      return ok(res, s);
    }
    if (p === '/api/v1.liveapi/editStream' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      const s = db.streams.find((x) => x.user === me.id && String(x.id) === String(b.id));
      if (!s) return fail(res, 404, '直播位不存在');
      if (b.name) s.name = b.name;
      if (b.action === 'start') { s.running = true; s.started = now(); }
      if (b.action === 'stop') { s.running = false; stopDouyin(Number(s.id)); }
      if (b.minutes) s.minutes = Number(s.minutes) + Number(b.minutes);
      if ('speakMode' in b) s.speakMode = b.speakMode;
      if ('voice' in b) s.voice = b.voice;
      if ('template' in b) s.template = b.template;
      if ('keywords' in b) s.keywords = b.keywords;
      if ('hostVoice' in b) s.hostVoice = b.hostVoice;
      if ('assistantVoice' in b) s.assistantVoice = b.assistantVoice;
      if ('zhu_baifenbi' in b) s.zhu_baifenbi = Number(b.zhu_baifenbi) || 0;
      save();
      return ok(res, s);
    }
    if (p === '/api/v1.liveapi/delStream' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      const i = db.streams.findIndex((x) => x.user === me.id && String(x.id) === String(b.id));
      if (i < 0) return fail(res, 404, '直播位不存在');
      stopDouyin(Number(b.id));
      db.streams.splice(i, 1); save();
      return ok(res);
    }
    if (p === '/api/v1.live/opent' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      const s = db.streams.find((x) => x.user === me.id && String(x.id) === String(b.id));
      if (!s) return fail(res, 404, '直播位不存在');
      s.running = true; s.started = now(); save();
      return ok(res, s);
    }

    /* ---------- 抖音直连（不需要桌面客户端） ---------- */
    if (p === '/api/v1.liveapi/attachDouyin' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      const s = db.streams.find((x) => x.user === me.id && String(x.id) === String(b.id));
      if (!s) return fail(res, 404, '直播位不存在');
      if (!b.room) return fail(res, 404, '请填直播间地址或房间号');
      stopDouyin(s.id);
      const h = attachDouyin({
        room: b.room,
        onBullets: (list) => list.forEach((m) => ingest(s, m)),
        onState: (state, extra) => {
          const text = `抖音直连 ${state}${extra ? ' ' + JSON.stringify(extra) : ''}`;
          broadcast(s.live_id, { kind: 'sys', text });
          console.log(`[douyin:${s.live_id}]`, text);
        },
      });
      douyinLinks.set(s.id, h);
      s.douyinRoom = b.room;
      save();
      return ok(res, { room: b.room });
    }
    if (p === '/api/v1.liveapi/detachDouyin' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      stopDouyin(Number(b.id));
      return ok(res);
    }

    /* ---------- 弹幕 ---------- */
    if (p === '/api/v1.live/getBullet') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const liveId = u.searchParams.get('live_id') || u.searchParams.get('task_id');
      const page = Number(u.searchParams.get('page') || 1);
      const limit = Math.min(200, Number(u.searchParams.get('limit') || 50));
      const list = db.bullets.filter((b) => String(b.live_id) === String(liveId)).reverse();
      return ok(res, { list: list.slice((page - 1) * limit, page * limit), total: list.length });
    }

    /* ---------- 语音 ---------- */
    // 预热克隆音色：把常用话术提前合成好，直播时才能秒出真人声
    if (p === '/api/v1.liveapi/warmupClone' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      const s = db.streams.find((x) => x.user === me.id && String(x.id) === String(b.id));
      if (!s) return fail(res, 404, '直播位不存在');
      const voice = s.hostVoice || s.voice || DEFAULT_VOICE;
      if (!String(voice).startsWith('clone:')) return fail(res, 404, '当前音色不是克隆音色');
      const lines = (b.lines && b.lines.length) ? b.lines : DEFAULT_WARMUP;
      let done = 0;
      (async () => {
        for (const line of lines) {
          const base = path.join(MEDIA, sha(line + '|' + voice).slice(0, 16));
          if (fs.existsSync(base + '.wav')) { done++; continue; }
          try {
            await speak({ text: line, voice, base });
            done++;
            broadcast(s.live_id, { kind: 'sys', text: `预热 ${done}/${lines.length}：${line.slice(0, 16)}…` });
          } catch (e) {
            broadcast(s.live_id, { kind: 'sys', text: `预热失败：${String(e.message || e).slice(0, 60)}` });
          }
        }
        broadcast(s.live_id, { kind: 'sys', text: `预热完成 ${done}/${lines.length}，克隆音色已可秒出` });
      })();
      return ok(res, { queued: lines.length });
    }
    if (p === '/api/v1.liveapi/makeAudio' && req.method === 'POST') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      const b = await body(req);
      const text = String(b.text || '').trim();
      if (!text) return fail(res, 404, '文本不能为空');
      const voice = b.voice || DEFAULT_VOICE;
      const key = sha(text + '|' + voice).slice(0, 16);
      const base = path.join(MEDIA, key);
      try {
        let ext = fs.existsSync(base + '.mp3') ? 'mp3' : fs.existsSync(base + '.wav') ? 'wav' : '';
        if (!ext) {
          const r = await speak({ text, voice, base });
          ext = r.ext;
        }
        return ok(res, { url: `/media/${key}.${ext}`, size: fs.statSync(base + '.' + ext).size });
      } catch (e) {
        return fail(res, 500, '合成失败: ' + (e.message || e));
      }
    }
    if (p === '/api/voices') {
      return ok(res, await listVoices());
    }
    if (p === '/api/tts/config') {
      const me = auth(req);
      if (!me) return fail(res, 401, 'Invalid authorization token');
      if (req.method === 'POST') {
        const b = await body(req);
        saveTtsConfig(b);
      }
      return ok(res, maskedTtsConfig());
    }

    /* ---------- SSE ---------- */
    if (p === '/api/live/events') {
      const liveId = u.searchParams.get('live_id') || '';
      const set = rooms.get(liveId) || new Set();
      rooms.set(liveId, set);
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'hello', live_id: liveId })}\n\n`);
      set.add(res);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(beat); set.delete(res); });
      return;
    }

    return send(res, 404, { code: 404, msg: 'not found' });
  } catch (e) {
    console.error('[x]', e);
    return send(res, 500, { code: 500, msg: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[✓] 本地复刻服务已启动  http://127.0.0.1:${PORT}`);
  console.log(`    控制台      ${SELF}/`);
  console.log(`    弹幕回调    ${SELF}/socket/index/bullet`);
  console.log(`    测试账号    admin / admin123`);
});
