// server/.ws-check.mjs —— ws-client.mjs 的可重复验证脚本
// 运行：node server/.ws-check.mjs
//
// 1) 连通性：公共 echo 服务，发文本 + 200KB Buffer，校验原样回显
// 2) 抖音弹幕：向签名服务要 WssUrl，分别「不带 Origin」「带 Origin」握手，
//    报告是否 101、带/不带 Origin 的差异、前 3 个二进制帧字节数
//
// 不依赖任何第三方包，只用 node 内置模块。
import { connectWS } from './ws-client.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);
const info = (m) => console.log(`  · ${m}`);

// 轮询式等待：轮询比 setTimeout 更能覆盖「消息已在路上」的情况
const waitFor = (cond, ms = 10000, step = 50) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = cond();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`等待超时 ${ms}ms`));
      setTimeout(tick, step);
    };
    tick();
  });

// ---------- 1. 连通性 ----------
async function checkEcho() {
  console.log('\n[1] 基础连通性');
  // 注：postman-echo 对二进制帧限制很严（1KB 就断连），只适合测文本；
  //     echo.websocket.events 域名已不可用。真正的二进制/大帧/分片验证靠 echo.websocket.org。
  const ENDPOINTS = ['wss://echo.websocket.org', 'wss://ws.postman-echo.com/raw'];
  for (const url of ENDPOINTS) {
    const texts = [];
    const bins = [];
    let ws;
    try {
      ws = connectWS(url, { headers: { 'User-Agent': UA }, timeoutMs: 15000 });
      const hs = await ws.opened; // 失败会 reject，err.httpStatus 是真实状态码
      info(`${url} 握手 HTTP ${hs.httpStatus}`);

      ws.onMessage(({ data, isBinary }) => (isBinary ? bins.push(data) : texts.push(data)));

      // 文本回声
      ws.send('hello-ws-client');
      const t = await waitFor(() => texts.find((x) => x === 'hello-ws-client'), 10000);
      if (!t) throw new Error('未收到文本回声');
      ok(`文本回声一致："${t}"`);

      // 200KB 二进制回声（验证分片拼接 / 大帧）
      const N = 200 * 1024;
      const payload = Buffer.alloc(N);
      for (let i = 0; i < N; i++) payload[i] = i & 0xff;
      ws.send(payload);
      const back = await waitFor(() => bins.find((b) => b.length === N), 20000);
      const same = Buffer.compare(back, payload) === 0;
      if (!same) throw new Error(`回显长度一致但内容不同（收到 ${back.length} 字节）`);
      ok(`200KB 二进制回声一致：发送 ${N} 字节，收到 ${back.length} 字节，内容逐字节相同`);
      ws.close(1000, 'done');
      return { url, pass: true };
    } catch (e) {
      bad(`${url} 失败：${e.message}${e.httpStatus ? `（httpStatus=${e.httpStatus}）` : ''}`);
      if (e.rawHeaders) info(`响应头：${e.rawHeaders.replace(/\r\n/g, ' | ').slice(0, 300)}`);
      try {
        ws?.close(1000, 'abort');
      } catch {}
    }
  }
  return { pass: false };
}

// ---------- 2. 抖音弹幕 ----------
const SIGN_API = 'https://api.aiobs.cn/Douyin/Douyin/SignWss';

async function signUrl() {
  const r = await fetch(SIGN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ApiKey: 'apikey-dy-REPLACE_ME',
      BrowserName: 'Mozilla',
      BrowserVersion: UA,
      RoomId: '82485729980',
      UserUniqueId: '7410618736569206322',
    }),
  });
  const j = await r.json();
  const url = j?.Data?.WssUrl;
  if (!url) throw new Error(`签名接口未返回 WssUrl: ${JSON.stringify(j).slice(0, 300)}`);
  return url;
}

/** 用给定请求头连一次抖音弹幕，收集前 3 帧字节数 */
async function tryDouyin(label, url, extraHeaders) {
  const frames = [];
  const texts = [];
  let ws;
  const t0 = Date.now();
  try {
    ws = connectWS(url, { headers: extraHeaders, timeoutMs: 15000, binaryType: 'buffer' });
    ws.onMessage(({ data, isBinary }) => {
      if (isBinary) frames.push(data);
      else texts.push(data);
    });
    const hs = await ws.opened;
    ok(`${label}：握手 HTTP ${hs.httpStatus}（${Date.now() - t0}ms）`);
    // 等首帧（抖音服务器连上后通常立刻推一帧 push 心跳的响应），最多等 12s
    await waitFor(() => frames.length >= 3, 12000).catch(() => {});
    const sizes = frames.slice(0, 3).map((b) => b.length);
    info(`${label}：${frames.length} 个二进制帧，前 3 帧字节数 = [${sizes.join(', ')}]`);
    if (texts.length) info(`${label}：另有 ${texts.length} 个文本帧，首个="${texts[0].slice(0, 80)}"`);
    if (frames.length) {
      info(`${label}：首帧前 16 字节 hex = ${frames[0].subarray(0, 16).toString('hex')}`);
    } else {
      bad(`${label}：握手成功后 12s 内未收到任何二进制帧`);
    }
    ws.close(1000, 'check-done');
    return { label, ok: true, httpStatus: hs.httpStatus, frames: frames.length, sizes };
  } catch (e) {
    bad(`${label}：握手/连接失败 ${e.message}` + (e.httpStatus ? `（httpStatus=${e.httpStatus}）` : ''));
    if (e.rawHeaders) info(`${label} 响应头：${e.rawHeaders.replace(/\r\n/g, ' | ').slice(0, 400)}`);
    if (e.body) info(`${label} 响应体：${e.body.replace(/\s+/g, ' ').slice(0, 200)}`);
    try {
      ws?.close(1000, 'abort');
    } catch {}
    return { label, ok: false, httpStatus: e.httpStatus || 0, error: e.message, frames: 0, sizes: [] };
  }
}

/** 从直播间页拿 ttwid（抖音 wss 握手强制校验），失败返回空串 */
async function fetchTtwid() {
  try {
    const r = await fetch('https://live.douyin.com/82485729980', { headers: { 'User-Agent': UA } });
    const list = r.headers.getSetCookie?.() || [];
    const cookie = list.map((s) => s.split(';')[0]).filter((s) => s.includes('=') && s.split('=')[1]).join('; ');
    info(`从直播页取到 Cookie：${cookie ? cookie.split(';').map((s) => s.split('=')[0].trim()).join(',') : '无'}`);
    return cookie;
  } catch (e) {
    bad(`取 ttwid 失败：${e.message}`);
    return '';
  }
}

async function checkDouyin() {
  console.log('\n[2] 抖音弹幕握手');
  let url;
  try {
    url = await signUrl();
    info(`签名地址：${url.slice(0, 160)}${url.length > 160 ? '…' : ''}（共 ${url.length} 字符）`);
  } catch (e) {
    bad(`获取签名地址失败：${e.message}`);
    return { sign: false };
  }

  const uaLike = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  // 抖音 webcast 握手强制校验 Cookie（ttwid），缺失时返回 HTTP 200 +
  // Handshake-Status: 417 / Handshake-Msg: "http: named cookie not present"
  const cookie = await fetchTtwid();

  // A：浏览器完整头（含 Origin/Referer）
  const withOrigin = await tryDouyin('带 Origin + Cookie', url, {
    ...uaLike,
    Origin: 'https://live.douyin.com',
    Referer: 'https://live.douyin.com/',
    ...(cookie ? { Cookie: cookie } : {}),
  });
  // B：只有 UA，不带 Origin / Referer / Cookie
  const noOrigin = await tryDouyin('不带 Origin、不带 Cookie', url, { ...uaLike });
  // C：有 Cookie 但无 Origin（隔离 Origin 的影响）
  const cookieOnly = await tryDouyin('只带 Cookie（无 Origin）', url, {
    ...uaLike,
    ...(cookie ? { Cookie: cookie } : {}),
  });
  // D：有 Origin 但无 Cookie（复现当前 undici 失败场景）
  const originOnly = await tryDouyin('只带 Origin（无 Cookie）', url, {
    ...uaLike,
    Origin: 'https://live.douyin.com',
    Referer: 'https://live.douyin.com/',
  });

  const same =
    withOrigin.httpStatus === noOrigin.httpStatus &&
    noOrigin.httpStatus === cookieOnly.httpStatus &&
    cookieOnly.httpStatus === originOnly.httpStatus;
  const diff = same
    ? `四种写法状态码相同（${withOrigin.httpStatus}）`
    : [
        `带 Origin+Cookie=${withOrigin.httpStatus}`,
        `带 Cookie 无 Origin=${cookieOnly.httpStatus}`,
        `带 Origin 无 Cookie=${originOnly.httpStatus}`,
        `带 UA 无 Cookie=${noOrigin.httpStatus}`,
      ].join('，');
  console.log(`\n  ⇒ ${diff}`);
  console.log('  ⇒ 关键变量 = Cookie(ttwid)；Origin/Referer 不是握手门槛，但缺失 Cookie 时服务端回 200+Handshake-Status:417');
  return { sign: true, cookie: !!cookie, withOrigin, noOrigin, cookieOnly, originOnly };
}

// ---------- main ----------
const start = Date.now();
console.log('ws-client 验证');
console.log(`Node ${process.version} / ${process.platform}`);

const echo = await checkEcho();
const douyin = await checkDouyin();

console.log(`\n== 汇总（${((Date.now() - start) / 1000).toFixed(1)}s）==`);
console.log(`  1. echo 连通性：${echo.pass ? '通过（文本 + 200KB 二进制）' : '未通过'}`);
if (douyin.sign) {
  for (const k of ['withOrigin', 'cookieOnly', 'originOnly', 'noOrigin']) {
    const x = douyin[k];
    console.log(
      `  2. 抖音 ${x.label} → HTTP ${x.httpStatus}，收到 ${x.frames} 个二进制帧，前 3 帧 [${x.sizes.join(', ')}]`
    );
  }
} else {
  console.log('  2. 抖音：签名接口未取到地址，未测试');
}

process.exitCode = echo.pass ? 0 : 1;
