/**
 * douyin.mjs — 抖音弹幕直连（不需要桌面客户端、不需要浏览器）
 *
 * 链路：
 *   1. 直播间地址/房间号 → 解析出数字 room_id（web_rid 需要先换 room_id）
 *   2. 调第三方签名服务拿带 signature 的 wss 地址（ApiKey 来自原 App 硬编码）
 *   3. 自己连 wss，按 PushFrame 协议解 gzip + protobuf
 *
 * 解码器直接复用原客户端 v28 的 dom/douyin-protocol.js（已 vendor 到 server/vendor）。
 */
import { connectWS } from './ws-client.mjs';
import { parseFrameHeader, buildAck } from './douyin-ack.mjs';
import { decodeFrame } from './douyin-decode.mjs';

const SIGN_API = 'https://api.aiobs.cn/Douyin/Douyin/SignWss';
/**
 * 抖音弹幕 WSS 签名服务的 ApiKey。
 * 说明：该 key 来自对目标客户端的逆向分析（硬编码在 App 内），
 * 属于第三方服务凭据，**不应提交到公开仓库**。
 * 请通过环境变量注入：AIOBS_API_KEY=apikey-dy-xxxx
 * 没有配置时会走内置兜底值，仅用于本地联调。
 */
const API_KEY = process.env.AIOBS_API_KEY || 'apikey-dy-REPLACE_ME';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TYPE_MAP = { msg: '1', come: '2', follow: '3', like: '4', gift: '6' };
/** 设备指纹式的 user_unique_id（16 位数字，可用环境变量固定） */
const DEVICE_UID = process.env.DOUYIN_UID || String(1000000000000000 + Math.floor(Math.random() * 8000000000000000));

/** 从「直播间链接或号码」里取标识 */
export function parseWebRid(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/live\.douyin\.com\/(\d{3,})/i) || s.match(/^(\d{3,})$/);
  return m ? m[1] : '';
}

/** 纯数字且 >=15 位的一律按 room_id 处理（抖音 room_id 通常 19 位，web_rid 11~12 位） */
const looksLikeRoomId = (s) => /^\d{15,}$/.test(String(s || '').trim());

/** web_rid → 数字 room_id（网页端进房接口，必须带 ttwid cookie，否则返回空） */
export async function resolveRoomId(input) {
  const raw = String(input || '').trim();
  if (looksLikeRoomId(raw)) return { roomId: raw, webRid: '' };  // 已经是 room_id
  const rid = parseWebRid(input);
  if (!rid) throw new Error('无法识别直播间地址/房间号');

  const q = new URLSearchParams({
    aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web',
    language: 'zh-CN', enter_from: 'web_live', cookie_enabled: 'true',
    screen_width: '1440', screen_height: '900', browser_language: 'zh-CN',
    browser_platform: 'Win32', browser_name: 'Mozilla', browser_version: UA,
    web_rid: rid,
  });

  const cookie = await getCookies();
  const r = await fetch(`https://live.douyin.com/webcast/room/web/enter/?${q}`, {
    headers: {
      'User-Agent': UA,
      Referer: `https://live.douyin.com/${rid}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const j = await r.json();
  const d = j?.data?.data?.[0];
  const id = d?.id_str || d?.id;
  if (id) {
    return {
      roomId: String(id),
      webRid: rid,
      status: d.status,
      title: d.title || '',
      users: d.user_count_str || '',
    };
  }
  throw new Error(`拿不到 room_id（web_rid=${rid}）：房间可能未开播或接口被风控`);
}

/** 拿带 signature 的弹幕 wss 地址 */
export async function signWss(roomId, userUniqueId) {
  const r = await fetch(SIGN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ApiKey: API_KEY,
      BrowserName: 'Mozilla',
      BrowserVersion: UA,
      RoomId: String(roomId),
      UserUniqueId: String(userUniqueId || DEVICE_UID),
    }),
  });
  const j = await r.json();
  if (j?.Code !== 0 || !j?.Data?.WssUrl) {
    throw new Error(`签名服务返回异常: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j.Data.WssUrl;
}

/** 拿 webcast 需要的 cookie（ttwid 必需，否则握手返回 417 named cookie not present） */
const cookieJar = { value: '', at: 0 };

export async function getCookies(force = false) {
  if (!force && cookieJar.value && Date.now() - cookieJar.at < 30 * 60 * 1000) return cookieJar.value;
  try {
    const r = await fetch('https://live.douyin.com/', {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    const raw = r.headers.getSetCookie?.() || [];
    const jar = {};
    for (const c of raw) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    cookieJar.value = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    cookieJar.at = Date.now();
  } catch (e) {
    console.warn('[douyin] 取 cookie 失败:', e.message);
  }
  return cookieJar.value;
}

/**
 * 接入一个直播间，持续推弹幕
 * @param {{room:string, onBullets:(list:any[])=>void, onState?:(s:string,extra?:any)=>void}} p
 * @returns {{stop:()=>void, roomId?:string}}
 */
export function attachDouyin({ room, onBullets, onState = () => {} }) {
  let ws = null;
  let stopped = false;
  let retry = 0;
  let roomId = '';
  let timer = null;

  const state = (s, extra) => { try { onState(s, extra); } catch {} };

  async function connect() {
    if (stopped) return;
    try {
      roomId = roomId || (await resolveRoomId(room)).roomId;
      const url = await signWss(roomId);
      const cookie = await getCookies();
      state('connecting', { roomId });
      ws = connectWS(url, {
        headers: {
          'User-Agent': UA,
          Origin: 'https://live.douyin.com',
          Referer: 'https://live.douyin.com/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeoutMs: 15000,
      });

      ws.onOpen(() => {
        retry = 0;
        state('open', { roomId });
      });

      ws.onMessage((ev) => {
        try {
          const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);

          // 先回 ack：不回的话服务端只推第 1 帧
          const hdr = parseFrameHeader(buf);
          if (hdr.payloadType === 'msg') {
            try {
              ws.send(buildAck({ logid: hdr.logid, internalExt: hdr.internalExt }));
            } catch (e) {
              state('ack-error', { error: String(e.message || e) });
            }
          }

          const out = decodeFrame(buf, (kind, info) => state('decode-' + kind, info));
          if (out.onlineNum != null) state('online', { onlineNum: out.onlineNum });
          if (out.msgList?.length) {
            onBullets(out.msgList.map((m) => ({
              type: TYPE_MAP[m.type] || '1',
              nickname: m.nickname || '',
              content: m.content || '',
              platform: 'douyin',
              uid: m.uid || '',
            })));
          }
        } catch (e) {
          state('decode-error', { error: String(e.message || e) });
        }
      });

      ws.onClose((e) => {
        if (stopped) return;
        state('closed', e);
        if (e?.code === 1008 || /cookie/i.test(String(e?.reason || ''))) getCookies(true);
        scheduleReconnect();
      });

      ws.onError((e) => {
        state('error', { message: e.message, httpStatus: e.httpStatus });
        if (e.httpStatus === 417) getCookies(true);
      });
    } catch (e) {
      state('fatal', { error: String(e.message || e) });
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    retry += 1;
    if (retry > 6) return state('giveup');
    const wait = Math.min(30000, 1000 * 2 ** retry);
    timer = setTimeout(connect, wait);
  }

  connect();

  return {
    get roomId() { return roomId; },
    stop() {
      stopped = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
    },
  };
}
