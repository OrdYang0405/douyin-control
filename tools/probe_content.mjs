/**
 * probe_content.mjs — 展开 ChatMessage 的 #3（内容）内部结构
 */
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { connectWS } from '../server/ws-client.mjs';
import { resolveRoomId, signWss, getCookies } from '../server/douyin.mjs';
import { buildAck, parseFrameHeader } from '../server/douyin-ack.mjs';

const require = createRequire(import.meta.url);
const { readFields, bytes } = require('../server/vendor/protobuf-wire.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const { roomId } = await resolveRoomId(process.argv[2] || '7700602420464077619');
const url = await signWss(roomId);
const cookie = await getCookies();

function tree(buf, depth, max) {
  if (depth > max) return;
  const pad = '  '.repeat(depth + 1);
  for (const f of readFields(buf)) {
    if (f.wire === 0) { console.log(`${pad}#${f.number} = ${f.value}`); continue; }
    if (f.wire !== 2) continue;
    const s = f.value.toString('utf8');
    const isText = /^[\x20-\x7E\u4e00-\u9fa5\p{Emoji}\s]{1,120}$/u.test(s);
    if (isText) console.log(`${pad}#${f.number} str = ${JSON.stringify(s)}`);
    else { console.log(`${pad}#${f.number} msg (${f.value.length}B)`); tree(f.value, depth + 1, max); }
  }
}

const ws = connectWS(url, {
  headers: { 'User-Agent': UA, Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/', Cookie: cookie },
});
let n = 0;
ws.onMessage((ev) => {
  const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
  const h = parseFrameHeader(buf);
  if (h.payloadType === 'msg') { try { ws.send(buildAck({ logid: h.logid, internalExt: h.internalExt })); } catch {} }
  const payload = bytes(readFields(buf), 8);
  if (!payload) return;
  let body = payload;
  if (payload[0] === 0x1f && payload[1] === 0x8b) { try { body = gunzipSync(payload); } catch { return; } }
  for (const m of readFields(body).filter((f) => f.number === 1 && f.wire === 2)) {
    const rf = readFields(m.value);
    if (bytes(rf, 1)?.toString('utf8') !== 'WebcastChatMessage' || n >= 2) continue;
    n++;
    const biz = readFields(bytes(rf, 2));
    console.log(`\n===== ChatMessage #${n} =====`);
    console.log('--- #2 (User) ---');
    tree(biz.find((f) => f.number === 2)?.value || Buffer.alloc(0), 0, 2);
    console.log('--- #3 (Content?) ---');
    const c = biz.find((f) => f.number === 3)?.value;
    if (c) tree(c, 0, 4);
    if (n >= 2) setTimeout(() => process.exit(0), 200);
  }
});
setTimeout(() => process.exit(0), 25000);
