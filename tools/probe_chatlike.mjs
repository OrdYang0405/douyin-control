/**
 * probe_chatlike.mjs — 抓 ChatLikeMessage 帧，逐字段 dump 结构，定位昵称/内容在哪
 * 用法: node tools/probe_chatlike.mjs [room_id或链接]
 */
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { connectWS } from '../server/ws-client.mjs';
import { resolveRoomId, signWss, getCookies } from '../server/douyin.mjs';

const require = createRequire(import.meta.url);
const { readFields, bytes } = require('../server/vendor/protobuf-wire.js');

const room = process.argv[2] || '7700602420464077619';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const { roomId } = await resolveRoomId(room);
const url = await signWss(roomId);
const cookie = await getCookies();
console.log('[i] room_id =', roomId);

/** 把 protobuf 递归打印成树 */
function dump(buf, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return;
  const pad = '  '.repeat(depth + 1);
  let fields;
  try { fields = readFields(buf); } catch { return; }
  for (const f of fields) {
    if (f.wire === 0) {
      console.log(`${pad}#${f.number} varint = ${f.value}`);
    } else if (f.wire === 2) {
      const v = f.value;
      const asText = v.toString('utf8');
      const printable = /^[\x20-\x7E\u4e00-\u9fa5\p{Emoji}]{1,80}$/u.test(asText);
      if (printable) {
        console.log(`${pad}#${f.number} str  = ${JSON.stringify(asText)}`);
      } else {
        console.log(`${pad}#${f.number} msg  (${v.length}B)`);
        if (v.length < 4000) dump(v, depth + 1, maxDepth);
      }
    }
  }
}

const ws = connectWS(url, {
  headers: { 'User-Agent': UA, Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/', Cookie: cookie },
});

let shown = 0;
ws.onOpen(() => console.log('[✓] 已连接，等待 ChatLikeMessage…\n'));
ws.onMessage((ev) => {
  const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
  const top = readFields(buf);
  const payload = bytes(top, 8);
  if (!payload) return;
  let body = payload;
  if (payload[0] === 0x1f && payload[1] === 0x8b) {
    try { body = gunzipSync(payload); } catch { return; }
  }
  const resp = readFields(body);
  for (const m of resp.filter((f) => f.number === 1 && f.wire === 2)) {
    const rf = readFields(m.value);
    const method = bytes(rf, 1)?.toString('utf8') || '';
    if (method !== 'WebcastChatLikeMessage') continue;
    if (shown >= 2) continue;
    shown++;
    console.log(`\n===== ${method} (第 ${shown} 个) =====`);
    const biz = bytes(rf, 2);
    if (biz) dump(biz, 0, 7);
    if (shown >= 2) setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, 300);
  }
});

setTimeout(() => {
  console.log(`\n[i] 25s 结束，展示 ${shown} 个 ChatLikeMessage`);
  try { ws.close(); } catch {}
  process.exit(0);
}, 25000);
