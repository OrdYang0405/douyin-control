#!/usr/bin/env node
/**
 * debug_console.mjs — 用 CDP 打开控制台，收集 JS 错误并模拟点击登录
 * 用法: node tools/debug_console.mjs [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const URL_ = process.argv[2] || 'http://127.0.0.1:8080/';
const PORT = 9223;
const chrome = [
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!chrome) { console.error('找不到 Chrome'); process.exit(1); }

const profile = `${process.env.TEMP}\\dsh-dbg-profile`;
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', 'about:blank',
], { detached: false, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {}
    await sleep(300);
  }
  throw new Error('DevTools 未就绪');
}

const ver = await waitPort();
console.log('[i]', ver.Browser);

const create = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(create.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});

const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push(`[异常] ${d.text} ${d.exception?.description?.split('\n')[0] || ''} @${d.lineNumber}:${d.columnNumber}`);
  }
  if (m.method === 'Log.entryAdded') {
    logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text}`);
  }
  if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    if (!r.url.includes('favicon')) logs.push(`[net] ${r.status} ${r.url}`);
  }
});

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL_ });
await sleep(3000);

console.log('\n=== 页面加载后日志 ===');
console.log(logs.join('\n') || '(无)');

// 检查按钮绑定情况
const chk = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    btn: !!document.getElementById('btnLogin'),
    onclick: typeof document.getElementById('btnLogin')?.onclick,
    token: localStorage.token || '',
    scripts: document.scripts.length,
    appHidden: document.getElementById('app')?.classList.contains('hidden')
  })`,
  returnByValue: true,
});
console.log('\n=== 元素与绑定检查 ===');
console.log(chk.result.value);

// 模拟点击
logs.length = 0;
await send('Runtime.evaluate', {
  expression: `document.getElementById('btnLogin').click(); 'clicked'`,
  returnByValue: true,
});
await sleep(2500);

const after = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ token: localStorage.token || '', appHidden: document.getElementById('app')?.classList.contains('hidden'), loginHidden: document.getElementById('login')?.classList.contains('hidden') })`,
  returnByValue: true,
});
console.log('\n=== 点击后状态 ===');
console.log(after.result.value);
console.log('\n=== 点击后日志 ===');
console.log(logs.join('\n') || '(无)');

try { proc.kill(); } catch {}
process.exit(0);
