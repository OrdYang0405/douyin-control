/**
 * voice-schedule.mjs — 双人对播调度器（复刻原系统 hostVoice / assistantVoice / zhu_baifenbi）
 *
 * 原系统（APK 的 live/extPerson 接口）：
 *   hostVoice      主播音色
 *   assistantVoice 助播音色
 *   zhu_baifenbi   主播占比，默认 30 → 主播 30% / 助播 70%
 *   pinci          插话频率
 *
 * 本模块只决定「这一句用谁的声音」，不碰 TTS 层。
 * 未配置双人时退化为单音色，行为与之前完全一致。
 *
 * 调度策略（三点，缺一不可）：
 *   1. 目标比例：按 zhu_baifenbi 抽样
 *   2. 欠账补偿：记录实际已播比例，偏离目标时向另一侧拉回
 *      —— 这是让「配置30%就真的接近30%」的关键，
 *         单纯随机 + 强制换人会因为换人不分方向而把比例推向 50%
 *   3. 问句优先助播：弹幕像提问时，更像「助播接话」的自然场景
 */
const QUESTION_RE = /[?？]|吗|呢|多少|怎么|什么|哪里|能不能|有没有|包邮|多久|多少钱/;

export function createScheduler() {
  /** live_id -> { host: 已播主播句数, total: 总句数, last: 角色, run: 连续次数 } */
  const state = new Map();

  function get(key) {
    if (!state.has(key)) state.set(key, { host: 0, total: 0, last: '', run: 0 });
    return state.get(key);
  }

  return {
    /**
     * @param {object} stream 直播位配置
     * @param {string} text   要播的内容
     * @returns {{voice:string, role:'host'|'assistant'|'single'}}
     */
    pick(stream, text = '') {
      const host = stream.hostVoice ? String(stream.hostVoice).split(',')[0].trim() : '';
      const assist = stream.assistantVoice ? String(stream.assistantVoice).split(',')[0].trim() : '';

      // 没配双人 → 单音色（老行为）
      if (!host || !assist) {
        return { voice: stream.voice || '', role: 'single' };
      }

      const key = stream.live_id || 'default';
      const st = get(key);
      const target = Math.max(0, Math.min(100, Number(stream.zhu_baifenbi ?? 30))) / 100;

      // —— 1) 目标比例 + 欠账补偿（Bresenham 式：每句都用累计欠账决定，
      //        偏差不会累积成死区，因此 10% / 90% 也能稳定命中）
      const expectedHost = st.total * target;          // 按目标，前 N 句里本应有多少句主播
      // 只有当欠账超过半句才强制补，否则用随机，保证同一角色不会机械交替
      let role;
      if (st.host < Math.floor(expectedHost)) {
        role = 'host';
      } else if (st.host > Math.ceil(expectedHost)) {
        role = 'assistant';
      } else {
        role = Math.random() < target ? 'host' : 'assistant';
      }
      const deficit = expectedHost - st.host;          // 供下面的换人判断参考

      // —— 3) 问句优先助播（不改变长期比例：会把这次当主播的名额让出去，下轮补回）
      if (QUESTION_RE.test(text) && Math.random() < 0.7) role = 'assistant';

      // —— 4) 连续同一角色过多时换人。
      //        注意：这条只在中间比例（20%~80%）启用。
      //        极端比例（如 10%）时助播本来就该连说很多句，
      //        强行换人会把实测比例抬到 25%，反而违背用户配置。
      if (st.last && role === st.last && st.run >= 3 && target > 0.25 && target < 0.75) {
        const flip = role === 'host' ? 'assistant' : 'host';
        const afterFlip = flip === 'host' ? deficit + 1 : deficit - 1;
        if (Math.abs(afterFlip) <= Math.abs(deficit)) role = flip;
      }

      // —— 记账
      st.total += 1;
      if (role === 'host') st.host += 1;
      st.run = role === st.last ? st.run + 1 : 1;
      st.last = role;

      return { voice: role === 'host' ? host : assist, role };
    },
  };
}

/** 服务端全局单例 */
export const scheduler = createScheduler();
