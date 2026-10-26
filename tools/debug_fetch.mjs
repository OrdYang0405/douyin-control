#!/usr/bin/env node
/**
 * debug_fetch.mjs — 在浏览器上下文里复现登录后的两次请求，打印原始响应
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9224;
const chrome = [
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\dsh-dbg2`, '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); } }

const t = await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8080/`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await send('Runtime.enable');
await sleep(2000);

const expr = `(async () => {
  const r1 = await fetch('/api/v1.token/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123', merchant: 1 })
  });
  const j1 = await r1.json();
  const r2 = await fetch('/api/v1/member/tmymember?merchid=1', {
    headers: { 'Content-Type': 'application/json', Authorization: j1.data.access_token }
  });
  const text2 = await r2.text();
  return JSON.stringify({
    login: { status: r1.status, code: j1.code },
    tmymember: { status: r2.status, body: text2.slice(0, 400) }
  }, null, 2);
})()`;

const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(out.result.value || JSON.stringify(out));
try { proc.kill(); } catch {}
process.exit(0);
