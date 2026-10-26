#!/usr/bin/env node
/**
 * capture.mjs — 通用 CDP 抓取器（文档读取 + 目标系统逆向取证共用）
 *
 * 依赖：Node >= 22（内置 WebSocket），无需 npm install
 * 用法：
 *   node tools/capture.mjs --url "https://TARGET/页面" --out captures/run1 \
 *        [--port 9222] [--wait 8000] [--idle 1500] [--scroll] [--cookies] [--keep]
 *
 * 产出（--out 目录）：
 *   page.md          标题 + 正文纯文本
 *   dom.html         渲染后的 HTML
 *   state.json       页面内嵌全局状态（window.DATA / __INITIAL_STATE__ ...）
 *   requests.jsonl   全部网络请求（含 POST body、请求头、状态码）
 *   ws.jsonl         WebSocket 建连与帧收发
 *   resources.json   performance 资源列表（脚本/接口/图片）
 *   cookies.json     仅在 --cookies 时落盘（默认只记名称，不落值）
 *   summary.md       本次抓取摘要
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const has = (name) => argv.includes('--' + name);

const url = arg('url');
if (!url) {
  console.error('缺少 --url');
  process.exit(2);
}
const port = Number(arg('port', 9222));
const outDir = String(arg('out', 'captures/run-' + Date.now()));
const waitMs = Number(arg('wait', 8000));
const idleMs = Number(arg('idle', 1200));
const doScroll = has('scroll');
const saveCookies = has('cookies');
const keepOpen = has('keep');
const base = `http://127.0.0.1:${port}`;

fs.mkdirSync(outDir, { recursive: true });
const w = (name, data) => fs.writeFileSync(path.join(outDir, name), data);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(pathname) {
  const r = await fetch(base + pathname);
  if (!r.ok) throw new Error(`${pathname} -> HTTP ${r.status}`);
  return r.json();
}

let ws, nextId = 1;
const pending = new Map();
const listeners = new Set();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout: ' + method));
      }
    }, 30000);
  });
}

function on(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

async function main() {
  // 1) 版本探测：确认 Chrome 已带 --remote-debugging-port 启动
  let ver;
  try {
    ver = await json('/json/version');
  } catch (e) {
    console.error('[!] 连不上 DevTools 端口 ' + port + '。先跑 tools/feishu_login.ps1（或带 --remote-debugging-port=' + port + ' 启动 Chrome）');
    process.exit(3);
  }
  console.log('[i] target:', ver.Browser);

  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(p.method + ': ' + msg.error.message)) : p.resolve(msg.result);
      return;
    }
    for (const h of listeners) h(msg);
  });

  // 2) 新建标签页并扁平化 attach
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = sessionId;

  const reqByRequestId = new Map();
  const reqLog = [];
  const wsLog = [];

  on((msg) => {
    if (msg.sessionId !== S) return;
    const { method, params } = msg;
    if (method === 'Network.requestWillBeSent') {
      const r = {
        id: params.requestId,
        ts: new Date().toISOString(),
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        headers: params.request.headers,
        postData: params.request.postData ?? null,
        initiator: params.initiator?.url ?? null,
      };
      // 去重：同一 requestId 的重定向链保留最新 URL
      reqByRequestId.set(params.requestId, r);
      reqLog.push(r);
    } else if (method === 'Network.responseReceived') {
      const r = reqByRequestId.get(params.requestId);
      if (r) {
        r.status = params.response.status;
        r.mimeType = params.response.mimeType;
        r.fromDiskCache = params.response.fromDiskCache;
      }
    } else if (method === 'Network.loadingFailed') {
      const r = reqByRequestId.get(params.requestId);
      if (r) r.failed = params.errorText;
    } else if (method === 'Network.webSocketCreated') {
      wsLog.push({ ts: new Date().toISOString(), event: 'open', url: params.url, requestId: params.requestId });
    } else if (method === 'Network.webSocketHandshakeResponseReceived') {
      wsLog.push({
        ts: new Date().toISOString(),
        event: 'handshake',
        url: params.response?.url,
        status: params.response?.status,
        headers: params.response?.headers,
      });
    } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      wsLog.push({
        ts: new Date().toISOString(),
        event: method === 'Network.webSocketFrameSent' ? 'send' : 'recv',
        requestId: params.requestId,
        opcode: params.response.opcode,
        payload: String(params.response.payloadData ?? '').slice(0, 20000),
      });
    }
  });

  await send('Page.enable', {}, S);
  await send('Network.enable', { maxPostDataSize: 65536 }, S);
  await send('Runtime.enable', {}, S);

  let loaded = false;
  on((msg) => {
    if (msg.sessionId === S && msg.method === 'Page.loadEventFired') loaded = true;
  });

  console.log('[i] navigate:', url);
  await send('Page.navigate', { url }, S);
  const t0 = Date.now();
  while (!loaded && Date.now() - t0 < 30000) await sleep(200);
  await sleep(waitMs);

  // 3) 懒加载滚动（长文档/长列表）
  if (doScroll) {
    for (let i = 0; i < 30; i++) {
      await send(
        'Runtime.evaluate',
        { expression: 'window.scrollBy(0, Math.max(600, window.innerHeight*0.9)); 1', returnByValue: true },
        S
      );
      await sleep(500);
      const { result } = await send(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify({y: window.scrollY, h: document.documentElement.scrollHeight, vh: window.innerHeight})',
          returnByValue: true,
        },
        S
      );
      const st = JSON.parse(result.value || '{}');
      if (st.y + st.vh >= st.h - 50) break;
    }
    await sleep(idleMs);
  }

  // 4) 页面内容与内嵌状态
  const extract = `(() => {
    const trim = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
    const safe = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v).slice(0, 2000); } };
    const out = {
      url: location.href,
      title: document.title,
      text: document.body ? document.body.innerText : '',
      htmlLen: document.documentElement.outerHTML.length,
      state: {},
      globals: []
    };
    for (const k of ['DATA','__INITIAL_STATE__','__NUXT__','__NEXT_DATA__','__PRELOADED_STATE__','__APP_DATA__','g_initialData','__WIKI_DATA__','__docx_data__']) {
      try { if (window[k]) out.state[k] = safe(window[k]); } catch (e) {}
    }
    try {
      out.globals = Object.keys(window).filter(k => /data|state|config|token|user|doc/i.test(k)).slice(0, 300);
    } catch (e) {}
    out.text = trim(out.text, 800000);
    return JSON.stringify(out);
  })()`;
  const ev = await send('Runtime.evaluate', { expression: extract, returnByValue: true }, S);
  const page = JSON.parse(ev.result.value || '{}');

  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify(performance.getEntriesByType('resource').map(e => ({name:e.name, type:e.initiatorType, size:e.transferSize})))`,
    returnByValue: true,
  }, S);
  const resources = JSON.parse(res.result.value || '[]');

  const html = await send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  }, S);
  w('dom.html', html.result.value || '');
  w('page.md', `# ${page.title}\n\n> ${page.url}\n\n${page.text}\n`);
  w('state.json', JSON.stringify({ globals: page.globals, state: page.state }, null, 2));
  w('requests.jsonl', reqLog.map((r) => JSON.stringify(r)).join('\n'));
  w('ws.jsonl', wsLog.map((r) => JSON.stringify(r)).join('\n'));
  w('resources.json', JSON.stringify(resources, null, 2));

  if (saveCookies) {
    try {
      const ck = await send('Network.getAllCookies', {}, S);
      w('cookies.json', JSON.stringify(ck.cookies, null, 2));
    } catch (e) {
      console.warn('[!] getAllCookies 失败:', e.message);
    }
  } else {
    try {
      const ck = await send('Network.getAllCookies', {}, S);
      w('cookie-names.txt', ck.cookies.map((c) => `${c.domain}\t${c.name}`).join('\n'));
    } catch {}
  }

  const apiReqs = reqLog.filter((r) => /\/(api|open-apis|space\/api)\//.test(r.url));
  const assets = resources.filter((r) => /\.(js|mjs|css)(\?|$)/.test(r.name));
  const summary = [
    `# 抓取摘要`,
    ``,
    `- URL: ${page.url}`,
    `- 标题: ${page.title}`,
    `- 时间: ${new Date().toISOString()}`,
    `- 浏览器: ${ver.Browser}`,
    `- 正文长度: ${page.text.length}`,
    `- 请求总数: ${reqLog.length}（API 类 ${apiReqs.length}）`,
    `- WebSocket 事件: ${wsLog.length}`,
    `- JS/CSS 资源: ${assets.length}`,
    ``,
    `## 内嵌状态键`,
    page.state && Object.keys(page.state).length ? Object.keys(page.state).map((k) => `- ${k}`).join('\n') : '- 无',
    ``,
    `## API 请求（前 80）`,
    ...apiReqs.slice(0, 80).map((r) => `- ${r.method} ${r.status ?? '?'} ${r.url}${r.postData ? '  [body ' + r.postData.length + 'B]' : ''}`),
    ``,
    `## 脚本资源（前 60）`,
    ...assets.slice(0, 60).map((r) => `- ${r.name}`),
    ``,
    `## WebSocket（前 20）`,
    ...wsLog.slice(0, 20).map((r) => `- ${r.event} ${r.url ?? ''}`),
  ].join('\n');
  w('summary.md', summary);
  console.log(summary);

  if (!keepOpen) {
    await send('Target.closeTarget', { targetId });
  }
  ws.close();
  console.log('\n[i] 输出目录:', path.resolve(outDir));
}

main().catch((e) => {
  console.error('[x]', e.message);
  process.exit(1);
});
