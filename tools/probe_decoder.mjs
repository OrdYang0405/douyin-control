/**
 * probe_decoder.mjs — 用新解码器跑一段时间，统计各方法处理结果
 */
import { connectWS } from '../server/ws-client.mjs';
import { resolveRoomId, signWss, getCookies } from '../server/douyin.mjs';
import { buildAck, parseFrameHeader } from '../server/douyin-ack.mjs';
import { decodeFrame } from '../server/douyin-decode.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const { roomId } = await resolveRoomId(process.argv[2] || '7700602420464077619');
const url = await signWss(roomId);
const cookie = await getCookies();

const stats = { chatSeen: 0, msgs: [], skip: new Map(), errors: [] };
const ws = connectWS(url, {
  headers: { 'User-Agent': UA, Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/', Cookie: cookie },
});

ws.onMessage((ev) => {
  const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
  const h = parseFrameHeader(buf);
  if (h.payloadType === 'msg') { try { ws.send(buildAck({ logid: h.logid, internalExt: h.internalExt })); } catch {} }
  const out = decodeFrame(buf, (kind, info) => {
    if (kind === 'skip') {
      const m = info.method;
      stats.skip.set(m, (stats.skip.get(m) || 0) + 1);
      if (m === 'WebcastChatMessage') stats.chatSeen++;
    }
    if (kind === 'decode-error') stats.errors.push(info);
    if (kind === 'no-biz') stats.skip.set('NO-BIZ ' + info.method, (stats.skip.get('NO-BIZ ' + info.method) || 0) + 1);
  });
  for (const m of out.msgList) {
    if (stats.msgs.length < 12) stats.msgs.push(m);
  }
});

setTimeout(() => {
  console.log('=== 解出的消息（前 12 条） ===');
  stats.msgs.forEach((m) => console.log(`  [${m.type}] ${m.nickname}：${m.content}`));
  console.log('\n=== 跳过的消息类型 ===');
  [...stats.skip.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)} ${k}`));
  console.log('\n=== 解码错误 ===');
  stats.errors.slice(0, 5).forEach((e) => console.log('  ', JSON.stringify(e)));
  process.exit(0);
}, 25000);
