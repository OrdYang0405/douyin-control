/**
 * probe_ack.mjs — 检查 ack 构造是否正确
 * 用法: node tools/probe_ack.mjs [room]
 */
import { createRequire } from 'node:module';
import { connectWS } from '../server/ws-client.mjs';
import { parseFrameHeader, buildAck, buildHeartbeat } from '../server/douyin-ack.mjs';

const require = createRequire(import.meta.url);
const { decodeFrame } = require('../server/vendor/douyin-protocol.js');

const ROOM = process.argv[2] || '14631259785';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const rc = await fetch(`https://live.douyin.com/${ROOM}`, { headers: { 'User-Agent': UA } });
const cookie = (rc.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
const r1 = await fetch('https://api.aiobs.cn/Douyin/Douyin/SignWss', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ApiKey: process.env.AIOBS_API_KEY || 'apikey-dy-REPLACE_ME',
    BrowserName: 'Mozilla', BrowserVersion: UA, RoomId: ROOM, UserUniqueId: '7410618736569206322',
  }),
});
const url = (await r1.json()).Data.WssUrl;

const ws = connectWS(url, {
  headers: { 'User-Agent': UA, Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/', Cookie: cookie },
});
let n = 0;
ws.onOpen(() => console.log('[✓] 101'));
ws.onMessage((ev) => {
  n++;
  const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
  const h = parseFrameHeader(buf);
  console.log(`\n[帧${n}] ${buf.length}B payloadType=${h.payloadType} logid=${h.logid} internalExt=${JSON.stringify(h.internalExt).slice(0, 200)}`);
  if (h.payloadType === 'msg') {
    const ack = buildAck({ logid: h.logid, internalExt: h.internalExt, headersList: h.headersList });
    console.log('  → ack hex:', ack.toString('hex').slice(0, 160), `(${ack.length}B)`);
    ws.send(ack);
    const d = decodeFrame(buf, () => {});
    console.log('  → 消息:', d.msgList.map((m) => `${m.nickname}:${m.content}`).join(' | ') || '(无聊天)');
  }
});
ws.onClose((e) => console.log('[i] 关闭', e.code, e.reason));
setTimeout(() => { console.log(`\n[i] 25s 共 ${n} 帧`); try { ws.close(); } catch {} process.exit(0); }, 25000);
