/**
 * douyin-ack.mjs — 抖音 webcast 协议的 ack / 心跳帧构造
 *
 * 协议事实（实测）：
 *   服务端只在客户端对 msg 帧回 ack 之后才继续推；
 *   不回 ack 就只收到第 1 帧（约 790 字节的 WebcastRoomMessage）。
 *
 * 帧结构（PushFrame）：
 *   field 1 seqid (varint)
 *   field 2 logid (varint)
 *   field 3 service (varint)
 *   field 4 method  (varint)
 *   field 5 headers (length-delimited, 多条)
 *   field 6 payloadEncoding (string)
 *   field 7 payloadType (string)  'msg' | 'ack' | 'hb'
 *   field 8 payload (bytes)
 */
import { readFields, bytes as fieldBytes } from './vendor/protobuf-wire.js';
import { gunzipSync } from 'node:zlib';

/* ---------------- 最小 protobuf 编码器 ---------------- */

function varint(n) {
  let v = BigInt(n);
  const out = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

const tag = (num, wire) => varint((BigInt(num) << 3n) | BigInt(wire));
const fVarint = (num, val) => Buffer.concat([tag(num, 0), varint(val)]);
const fBytes = (num, buf) => Buffer.concat([tag(num, 2), varint(buf.length), buf]);
const fStr = (num, s) => fBytes(num, Buffer.from(String(s), 'utf8'));

/* ---------------- 解析收到的帧头 ---------------- */

export function parseFrameHeader(buf) {
  const top = readFields(buf);
  const get = (n, wire = 0) => top.find((f) => f.number === n && f.wire === wire)?.value;
  const payload = fieldBytes(top, 8);
  // 内层 Response：field 1 = headersList（重复项），field 5 = internalExt
  let internalExt = '';
  let headersList = [];
  if (payload) {
    let body = payload;
    if (payload[0] === 0x1f && payload[1] === 0x8b) {
      try {
        body = gunzipSync(payload);
      } catch { /* 保持原样 */ }
    }
    const resp = readFields(body);
    internalExt = fieldBytes(resp, 5)?.toString('utf8') || '';
    headersList = resp
      .filter((f) => f.number === 1 && f.wire === 2)
      .map((f) => f.value);
  }
  return {
    seqid: get(1)?.toString(),
    logid: get(2)?.toString(),
    service: get(3)?.toString(),
    method: get(4)?.toString(),
    payloadType: fieldBytes(top, 7)?.toString('utf8') || '',
    internalExt,
    headersList,
  };
}

/**
 * 构造 ack 帧。
 *
 * 实测：把整帧 Response.messages（headersList 里其实是业务消息）回传也能用，
 * 但帧会膨胀到 5~15KB；只用 internalExt + logid 已足够让服务端续推，
 * 因此默认走精简版，includeHeaders 仅供排障。
 */
export function buildAck({ logid = '0', internalExt = '', headersList = [], includeHeaders = false }) {
  const parts = [];
  if (includeHeaders) for (const h of headersList || []) parts.push(fBytes(1, h));
  if (internalExt) parts.push(fStr(5, internalExt));
  const inner = Buffer.concat(parts);
  return Buffer.concat([
    fVarint(1, 1),                                  // seqid
    fVarint(2, BigInt(logid || 0)),                 // logid（回传原帧的）
    fStr(7, 'ack'),                                 // payloadType
    fBytes(8, inner),                               // payload = Response
  ]);
}

/** 构造心跳帧（部分环境需要主动 hb，可选） */
export function buildHeartbeat() {
  return Buffer.concat([fVarint(1, 1), fStr(7, 'hb')]);
}
