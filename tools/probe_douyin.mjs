/**
 * probe_douyin.mjs — 直连链路探针（排查用，不影响主服务）
 * 用法: node tools/probe_douyin.mjs <直播间地址或room_id> [秒数]
 */
import { attachDouyin, resolveRoomId, signWss } from '../server/douyin.mjs';

const room = process.argv[2] || '82485729980';
const secs = Number(process.argv[3] || 20);

console.log('[i] room =', room);
try {
  const r = await resolveRoomId(room);
  console.log('[i] resolve →', r);
} catch (e) {
  console.log('[x] resolve 失败:', e.message);
}

try {
  const u = await signWss((await resolveRoomId(room)).roomId);
  console.log('[i] wss url 前缀:', u.slice(0, 120));
} catch (e) {
  console.log('[x] sign 失败:', e.message);
}

let n = 0;
const h = attachDouyin({
  room,
  onBullets: (list) => {
    n += list.length;
    for (const m of list.slice(0, 3)) console.log(`[弹幕] ${m.nickname}：${m.content} (type=${m.type})`);
  },
  onState: (s, extra) => console.log('[state]', s, extra ? JSON.stringify(extra) : ''),
});

setTimeout(() => {
  console.log(`\n[i] ${secs}s 内收到 ${n} 条弹幕`);
  h.stop();
  process.exit(0);
}, secs * 1000);
