/**
 * probe_chat.mjs — dump WebcastChatMessage 的业务载荷结构
 */
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { connectWS } from '../server/ws-client.mjs';
import { resolveRoomId, signWss, getCookies } from '../server/douyin.mjs';
import { buildAck, parseFrameHeader } from '../server/douyin-ack.mjs';

const require = createRequire(import.meta.url);
const { readFields, bytes } = require('../server/vendor/protobuf-wire.js');

const room = process.argv[2] || '7700602420464077619';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const { roomId } = await resolveRoomId(room);
const url = await signWss(roomId);
const cookie = await getCookies();

function dump(buf, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return;
  const pad = '  '.repeat(depth + 1);
  let fields;
  try { fields = readFields(buf); } catch { return; }
  for (const f of fields) {
    if (f.wire === 0) { console.log(`${pad}#${f.number} varint = ${f.value}`); continue; }
    if (f.wire !== 2) continue;
    const v = f.value;
    const s = v.toString('utf8');
    const printable = /^[\x20-\x7E\u4e00-\u9fa5\p{Emoji}\s]{1,100}$/u.test(s);
    if (printable) console.log(`${pad}#${f.number} str  = ${JSON.stringify(s.slice(0, 80))}`);
    else { console.log(`${pad}#${f.number} msg  (${v.length}B)`); if (v.length < 3000) dump(v, depth + 1, maxDepth); }
  }
}

const ws = connectWS(url, {
  headers: { 'User-Agent': UA, Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/', Cookie: cookie },
});

let shown = 0;
ws.onOpen(() => console.log('[✓] 已连接，等 ChatMessage…\n'));
ws.onMessage((ev) => {
  const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
  const hdr = parseFrameHeader(buf);
  if (hdr.payloadType === 'msg') { try { ws.send(buildAck({ logid: hdr.logid, internalExt: hdr.internalExt })); } catch {} }
  const top = readFields(buf);
  const payload = bytes(top, 8);
  if (!payload) return;
  let body = payload;
  if (payload[0] === 0x1f && payload[1] === 0x8b) { try { body = gunzipSync(payload); } catch { return; } }
  for (const m of readFields(body).filter((f) => f.number === 1 && f.wire === 2)) {
    const rf = readFields(m.value);
    const method = bytes(rf, 1)?.toString('utf8') || '';
    if (method !== 'WebcastChatMessage' || shown >= 2) continue;
    shown++;
    console.log(`\n===== ${method} #${shown} =====`);
    const biz = bytes(rf, 2);
    if (biz) dump(biz, 0, 5);
    if (shown >= 2) setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, 300);
  }
});
setTimeout(() => { console.log('\n[i] 25s 超时'); try { ws.close(); } catch {} process.exit(0); }, 25000);
