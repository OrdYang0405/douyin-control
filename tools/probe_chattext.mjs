/**
 * probe_chattext.mjs — 在 ChatMessage 业务体里扫描中文串，定位「内容」字段
 * 用法: node tools/probe_chattext.mjs [room]
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
    if (bytes(rf, 1)?.toString('utf8') !== 'WebcastChatMessage') continue;
    if (n >= 3) continue;
    n++;
    const biz = bytes(rf, 2);
    console.log(`\n=== ChatMessage #${n} (${biz.length}B) 中文串扫描 ===`);
    const utf8 = require('../server/vendor/protobuf-wire.js');
    for (let i = 0; i < biz.length - 2; i++) {
      const b = biz[i];
      if (b >= 0xe2 && b <= 0xef) {
        let j = i;
        while (j < biz.length && biz[j] >= 0x80) j++;
        const s = biz.subarray(i, j).toString('utf8');
        if (/[\u4e00-\u9fa5]{1,}/.test(s) && s.length < 60) {
          console.log(`  offset ${i}: ${JSON.stringify(s)}`);
        }
        i = j - 1;
      }
    }
    // 同时打印顶层字段，方便对照
    console.log('  顶层字段:', readFields(biz).map((f) => `#${f.number}(w${f.wire},${f.wire === 2 ? f.value.length + 'B' : f.value})`).join(' '));
    if (n >= 3) setTimeout(() => process.exit(0), 200);
  }
});

setTimeout(() => { console.log(`\n[i] 超时，仅拿到 ${n} 条`); process.exit(0); }, 25000);
