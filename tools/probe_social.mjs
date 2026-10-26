/**
 * probe_social.mjs — 看 WebcastSocialMessage / WebcastLikeMessage 的真实字段
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

const want = new Set(['WebcastSocialMessage', 'WebcastLikeMessage']);
const seen = new Map();

const ws = connectWS(url, {
  headers: { 'User-Agent': UA, Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/', Cookie: cookie },
});

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
    const method = bytes(rf, 1)?.toString('utf8') || '';
    if (!want.has(method)) continue;
    if ((seen.get(method) || 0) >= 2) continue;
    seen.set(method, (seen.get(method) || 0) + 1);
    const biz = readFields(bytes(rf, 2));
    console.log(`\n===== ${method} #${seen.get(method)} =====`);
    console.log('业务体顶层:', biz.map((f) => `#${f.number}(w${f.wire}${f.wire === 2 ? ',' + f.value.length + 'B' : '=' + f.value})`).join(' '));
    const user = bytes(biz, 2);
    if (user) {
      const uf = readFields(user);
      console.log('  User:', uf.map((f) => `#${f.number}(w${f.wire}${f.wire === 2 ? ',' + f.value.length + 'B' : '=' + f.value})`).join(' '));
      console.log('  User.#3 昵称 =', JSON.stringify(bytes(uf, 3)?.toString('utf8')));
    }
  }
});

setTimeout(() => {
  console.log('\n[i] 统计:', [...seen.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '(未捕获)');
  process.exit(0);
}, 30000);
