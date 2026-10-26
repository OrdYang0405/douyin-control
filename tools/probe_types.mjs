/**
 * probe_types.mjs — 统计一个直播间 25 秒内出现的所有消息类型，并尝试提取文本
 * 用法: node tools/probe_types.mjs [room]
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
console.log('[i] room_id =', roomId);

const types = new Map();
let total = 0;

/** 递归找所有「像中文文本」的字符串字段 */
function collectText(buf, depth = 0, out = [], path = '') {
  if (depth > 6) return out;
  let fields;
  try { fields = readFields(buf); } catch { return out; }
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const v = f.value;
    const s = v.toString('utf8');
    if (/^[\s\S]{1,200}$/.test(s) && /[\u4e00-\u9fa5]{1,}/.test(s) && !/^\d+$/.test(s)) {
      out.push({ path: `${path}#${f.number}`, text: s.slice(0, 60) });
    } else if (v.length > 2 && v.length < 5000) {
      collectText(v, depth + 1, out, `${path}#${f.number}`);
    }
  }
  return out;
}

const ws = connectWS(url, {
  headers: { 'User-Agent': UA, Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/', Cookie: cookie },
});

const samples = [];
ws.onOpen(() => console.log('[✓] 已连接，统计 25 秒…\n'));
ws.onMessage((ev) => {
  const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
  const hdr = parseFrameHeader(buf);
  if (hdr.payloadType === 'msg') {
    try { ws.send(buildAck({ logid: hdr.logid, internalExt: hdr.internalExt })); } catch {}
  }
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
    const method = bytes(rf, 1)?.toString('utf8') || '(空)';
    total++;
    types.set(method, (types.get(method) || 0) + 1);
    if (samples.length < 12 && !/ChatLike|Rank|Room(Message|Stats)/.test(method)) {
      const biz = bytes(rf, 2);
      if (biz) {
        const texts = collectText(biz);
        if (texts.length) samples.push({ method, texts: texts.slice(0, 6) });
      }
    }
  }
});

setTimeout(() => {
  console.log(`[i] 25 秒共 ${total} 条消息\n`);
  console.log('=== 消息类型统计 ===');
  [...types.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
  console.log('\n=== 含中文文本的样本 ===');
  for (const s of samples) console.log(`  [${s.method}] ` + s.texts.map((t) => `${t.path}=${t.text}`).join(' | '));
  try { ws.close(); } catch {}
  process.exit(0);
}, 25000);
