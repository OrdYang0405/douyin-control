/**
 * douyin-decode.mjs — 抖音弹幕解码（兼容新老协议结构）
 *
 * 为什么不直接用 vendor 里的 douyin-protocol.js：
 *   那是客户端的旧版本，假设 ChatMessage.content 是 field 3 的「裸字符串」。
 *   2026-10 起抖音把 content 换成了 **field 3 的嵌套消息**，于是旧解码器
 *   每条聊天都抛「空聊天内容」，6 万人的房间一条都解不出来。
 *
 * 本实现：
 *   - 结构照旧（PushFrame → gzip → Response.messages）
 *   - ChatMessage 的内容：先试 field 3 裸串，再递归在 field 3 里找第一个中文串
 *   - 昵称：User(field 2).field 3
 *   - 顺带解析进入/关注/点赞/在线人数
 */
import { gunzipSync } from 'node:zlib';
import { readFields, bytes } from './vendor/protobuf-wire.js';

const MAX = 4 * 1024 * 1024;

const text = (fields, n) => bytes(fields, n)?.toString('utf8') || '';
const int = (fields, n) => fields.find((f) => f.number === n && f.wire === 0)?.value;
const nested = (fields, n) => {
  const b = bytes(fields, n);
  if (!b) return [];
  try { return readFields(b); } catch { return []; }
};
const num = (v) => (v == null ? undefined : v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined);

/** 在任意 protobuf 结构里递归找第一个「像人话」的中文串 */
function findChinese(buf, depth = 0) {
  if (!buf || depth > 5) return '';
  let fields;
  try { fields = readFields(buf); } catch { return ''; }
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const s = f.value.toString('utf8');
    if (/^[\u3000-\u9fff\uff00-\uffef\u4e00-\u9fa5]{2,}$/.test(s) && !/^[\u4e00-\u9fa5]*勋章/.test(s)) {
      return s.trim();
    }
    const deeper = findChinese(f.value, depth + 1);
    if (deeper) return deeper;
  }
  return '';
}

/** 解一条业务消息 */
function decodeMessage(method, biz) {
  const f = readFields(biz);
  const methodId = text(f, 1) ? '' : '';

  if (method === 'WebcastChatMessage') {
    const user = nested(f, 2);
    const nickname = text(user, 3).trim() || findChinese(bytes(f, 2) || Buffer.alloc(0));
    let content = text(f, 3).trim();
    if (!content) content = findChinese(bytes(f, 3) || Buffer.alloc(0));
    if (!nickname || !content) return null;
    return { type: 'msg', nickname, content, uid: int(user, 1)?.toString() || '' };
  }

  if (method === 'WebcastMemberMessage') {
    if (int(f, 10) !== 1n) return null;             // 只取「进入」
    const user = nested(f, 2);
    const nickname = text(user, 3).trim() || findChinese(bytes(f, 2) || Buffer.alloc(0));
    if (!nickname) return null;
    return { type: 'come', nickname, content: '来了', uid: int(user, 1)?.toString() || '' };
  }

  if (method === 'WebcastLikeMessage') {
    // 新版结构：没有 User 字段，#2=本次点赞数，#3=累计，#5=用户（嵌套，含昵称）
    let nickname = '';
    const userWrapper = nested(f, 5);
    if (userWrapper.length) {
      const u = bytes(userWrapper, 1) ? nested(userWrapper, 1) : userWrapper;
      nickname = text(u, 3).trim() || findChinese(bytes(f, 5) || Buffer.alloc(0));
    }
    const count = num(int(f, 2)) || 1;
    return { type: 'like', nickname: nickname || '', content: `点赞 ×${count}`, uid: '' };
  }

  if (method === 'WebcastSocialMessage') {
    const action = int(f, 4);
    if (action !== 1n) return null;                // 1=关注，其它是分享等
    const user = nested(f, 2);
    const nickname = text(user, 3).trim();
    if (!nickname) return null;
    return { type: 'follow', nickname, content: '关注了主播', uid: int(user, 1)?.toString() || '' };
  }

  return null;
}

/**
 * 解一帧
 * @returns {{msgList:Array, onlineNum?:number}}
 */
export function decodeFrame(buf, onDebug = () => {}) {
  const out = { msgList: [] };
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX) return out;

  const top = readFields(buf);
  const payloadType = text(top, 7);
  if (payloadType === 'hb' || payloadType === 'ack') return out;
  if (payloadType !== 'msg') return out;

  let payload = bytes(top, 8);
  if (!payload) return out;
  if (payload[0] === 0x1f && payload[1] === 0x8b) {
    try { payload = gunzipSync(payload, { maxOutputLength: MAX }); } catch (e) { onDebug('gunzip-error', { error: e.message }); return out; }
  }

  let resp;
  try { resp = readFields(payload); } catch { return out; }

  for (const m of resp.filter((x) => x.number === 1 && x.wire === 2)) {
    let rf, method;
    try {
      rf = readFields(m.value);
      method = text(rf, 1);
    } catch { continue; }

    // 在线人数
    if (method === 'WebcastRoomUserSeqMessage') {
      const n = num(int(readFields(bytes(rf, 2) || Buffer.alloc(0)), 3));
      if (n != null) out.onlineNum = n;
      continue;
    }
    if (method === 'WebcastRoomStatsMessage') {
      const stats = readFields(bytes(rf, 2) || Buffer.alloc(0));
      if (text(stats, 4).includes('在线观众')) {
        const n = num(int(stats, 5));
        if (n != null) out.onlineNum = n;
      }
      continue;
    }

    const biz = bytes(rf, 2);
    if (!biz) { onDebug('no-biz', { method }); continue; }
    try {
      const one = decodeMessage(method, biz);
      if (one) out.msgList.push(one);
      else onDebug('skip', { method });
    } catch (e) {
      onDebug('decode-error', { method, error: e.message });
    }
  }
  return out;
}
