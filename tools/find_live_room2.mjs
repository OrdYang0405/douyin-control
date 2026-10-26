/**
 * find_live_room2.mjs — 用 webcast enter 接口筛出真正在播且人多的房间
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const homeRes = await fetch('https://live.douyin.com/', { headers: { 'User-Agent': UA } });
const cookie = (homeRes.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
const home = await homeRes.text();
const rids = [...new Set([...home.matchAll(/live\.douyin\.com\/(\d{8,})/g)].map((m) => m[1]))];
const cat = await (await fetch('https://live.douyin.com/category/1', { headers: { 'User-Agent': UA, Referer: 'https://live.douyin.com/', Cookie: cookie } })).text();
const rids2 = [...new Set([...cat.matchAll(/live\.douyin\.com\/(\d{8,})/g)].map((m) => m[1]))];
const all = [...new Set([...rids, ...rids2])];
console.log('[i] 候选:', all.length, '| cookie:', cookie.slice(0, 30));

const q = (rid) => new URLSearchParams({
  aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', language: 'zh-CN',
  enter_from: 'web_live', cookie_enabled: 'true', screen_width: '1440', screen_height: '900',
  browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Mozilla',
  browser_version: UA, web_rid: rid,
});

const live = [];
for (const rid of all.slice(0, 20)) {
  try {
    const r = await fetch(`https://live.douyin.com/webcast/room/web/enter/?${q(rid)}`, {
      headers: { 'User-Agent': UA, Referer: 'https://live.douyin.com/', Cookie: cookie },
    });
    const j = await r.json();
    const d = j?.data?.data?.[0];
    if (!d) { console.log(`  ${rid} 无数据 status=${j?.status_code}`); continue; }
    const row = {
      webRid: rid,
      roomId: String(d.id_str || d.id || ''),
      status: d.status,
      title: (d.title || '').slice(0, 24),
      users: d?.room_view_stats?.display_value ?? d?.user_count ?? '',
    };
    console.log(`  ${rid} room=${row.roomId} status=${row.status} 在线=${row.users} ${row.title}`);
    if (Number(row.status) === 2 && row.roomId) live.push(row);
  } catch (e) {
    console.log(`  ${rid} 失败: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}
live.sort((a, b) => String(b.users).localeCompare(String(a.users)));
console.log('\n[i] 在播房间（按人数）:');
for (const l of live) console.log(`   ${l.roomId}  在线=${l.users}  ${l.title}`);
