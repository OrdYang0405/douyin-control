/**
 * speak-script.mjs — 把「弹幕原文」变成「像人说的话」
 *
 * 逆向原系统后确认：他们不是把弹幕直接念出来，而是先改写成人话再合成。
 * 关键证据（APK app-service.js）：
 *   - 运营配置项叫「参考话术」，页面说明写着
 *     "可根据参考话术进行改写，最终得出一段加变量之后的文案，
 *      AI 会自动随机选择变量词去读"
 *   - 弹幕进 live/getReply 拿 anwser，再由 makeAudio 逐句合成
 *   - 前端有 rewriteinterv（每 20 秒改写一次）、suiyyin_zhu/suiyyin_fu（随机短语音库）
 *
 * 本模块用「确定性规则 + 随机变体」模拟那一层，零依赖、零费用、可离线。
 * 效果：同样的弹幕不会再每次都念成一模一样的一句话。
 */

/* ------------------------------ 变量词库 ------------------------------ */

const VARS = {
  greeting: ['家人们', '宝子们', '各位', '兄弟们', '姐妹们', '朋友们'],
  yes: ['对', '是的', '没错', '对对对'],
  think: ['嗯', '我想想', '这个嘛', '让我看看'],
  agree: ['可以的', '没问题', '当然啦', '必须的'],
  price: ['到手价', '直播间价格', '现在这个价', '咱们这个价'],
  call: ['下方小黄车', '左下角链接', '一号链接', '购物车'],
  emotion: ['真的', '说实话', '讲真', '不骗你们'],
  filler: ['啊', '呀', '哦', '哈'],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* --------------------------- 弹幕意图识别 --------------------------- */

const RULES = [
  { kind: 'price', re: /多少钱|价格|几块|怎么卖|贵不贵|便宜|优惠|打折|降|多少钱一/ },
  { kind: 'link', re: /链接|怎么买|在哪买|下单|小黄车|购物车|怎么下单|拍下/ },
  { kind: 'ship', re: /包邮|发货|多久到|快递|运费|物流/ },
  { kind: 'quality', re: /质量|好用吗|效果|靠谱|真的吗|正品|有没有保障/ },
  { kind: 'come', re: /^(来了|来了来了|到|报到)/ },
  { kind: 'greet', re: /主播好|你好|哈喽|hello|hi|晚上好|早上好/ },
  { kind: 'thanks', re: /谢谢|感谢|收到|买到了/ },
];

export function classify(text) {
  const t = String(text || '').trim();
  if (!t) return 'other';
  for (const r of RULES) if (r.re.test(t)) return r.kind;
  return 'other';
}

/* --------------------------- 生成播报文案 --------------------------- */

/**
 * @param {object} p
 * @param {string} p.nickname   观众昵称
 * @param {string} p.content    弹幕内容
 * @param {string} p.template   用户模板，支持 {nickname} {content} {reply}
 * @param {string} p.script     参考话术（可空），留空则用内置话术库
 * @param {'host'|'assistant'|'single'} p.role 谁在说
 * @returns {string}
 */
export function composeScript({ nickname = '', content = '', template = '', script = '', role = 'single' } = {}) {
  const kind = classify(content);
  const name = String(nickname || '').trim();
  const body = String(content || '').trim();

  // 1) 如果运营给了参考话术，优先在话术里替换变量，而不是念弹幕
  const base = String(script || '').trim();
  if (base) {
    const filled = fillVars(base);
    // 弹幕命中问句时，把问题接到话术后面，形成「回应」而不是「复读」
    return kind === 'other' ? filled : `${pick(VARS.think)}，${filled}`;
  }

  // 2) 内置话术库：按意图生成一句人话
  const reply = replyFor(kind, { name, body, role });

  // 3) 模板优先级最高（用户显式配置）
  if (template) {
    return fillVars(template
      .replace(/\{nickname\}/g, name || pick(VARS.greeting))
      .replace(/\{content\}/g, body)
      .replace(/\{reply\}/g, reply));
  }
  // 4) 语气词连写会变成「对对对啊」「对呀」这种怪腔，收一下
  return dedupeOnset(reply);
}

/** 处理 "对对对啊" / "对呀" / "嗯哈" 这类叠字开头 */
function dedupeOnset(s) {
  return String(s)
    .replace(/^(对对对)(?=[啊呀哦哈])/u, '对')
    .replace(/^(嗯嗯)(?=[啊呀哦哈])/u, '嗯')
    .replace(/^([对对是行好])\1+/u, '$1');
}

function replyFor(kind, { name, body, role }) {
  const who = name || pick(VARS.greeting);
  const guest = role === 'host' ? '助播' : '主播';

  switch (kind) {
    case 'price':
      return pick([
        `${pick(VARS.think)}，这位${who}问价格，${pick(VARS.price)}就在${pick(VARS.call)}，${pick(VARS.emotion)}很划算`,
        `${pick(VARS.yes)}，${who}这个问题问得好，${pick(VARS.price)}真不高，${pick(VARS.call)}自己看`,
        `${who}问多少钱是吧，${pick(VARS.agree)}，${pick(VARS.price)}我再说一遍，${pick(VARS.call)}第一个`,
        `${pick(VARS.think)}${pick(VARS.filler)}，价格我直接说，${pick(VARS.price)}，${who}你放心`,
        `${who}关心价格对不对，${pick(VARS.emotion)}不贵，${pick(VARS.call)}写着呢`,
        `${pick(VARS.yes)}${pick(VARS.filler)}，${pick(VARS.price)}就是这样，${who}自己算算`,
      ]);
    case 'link':
      return pick([
        `${pick(VARS.yes)}，${who}要链接，就在${pick(VARS.call)}，点进去就能拍`,
        `${pick(VARS.agree)}，${pick(VARS.call)}直接下单，${who}你看那个红色的按钮`,
        `${pick(VARS.emotion)}方便，${who}${pick(VARS.call)}点一下就买到了`,
      ]);
    case 'ship':
      return pick([
        `${pick(VARS.yes)}包邮的，${who}放心拍，正常两三天就到`,
        `${who}问发货啊，${pick(VARS.agree)}，今天拍明天就发`,
        `${pick(VARS.emotion)}不用担心，全国包邮，${who}下单就行`,
      ]);
    case 'quality':
      return pick([
        `${pick(VARS.emotion)}，质量这块${who}可以放心，我们自己都在用`,
        `${pick(VARS.yes)}，${who}问得对，这个品质${pick(VARS.agree)}，有保障`,
        `${pick(VARS.think)}，${who}担心的我懂，${pick(VARS.emotion)}不用怕，七天无理由`,
      ]);
    case 'come':
      return pick([
        `欢迎${who}${pick(VARS.filler)}，刚来的${pick(VARS.greeting)}点点关注`,
        `${who}来了${pick(VARS.filler)}，欢迎欢迎`,
        `${pick(VARS.greeting)}，又进来一位，${who}你好`,
      ]);
    case 'greet':
      return pick([
        `${who}好${pick(VARS.filler)}，欢迎来到直播间`,
        `${pick(VARS.greeting)}好，${who}来啦`,
        `${who}晚上好啊，${pick(VARS.call)}看看有没有喜欢的`,
      ]);
    case 'thanks':
      return pick([
        `${pick(VARS.emotion)}谢谢${who}的支持${pick(VARS.filler)}`,
        `${who}客气了，${pick(VARS.agree)}`,
        `感谢${who}，${pick(VARS.greeting)}都看看啊`,
      ]);
    default:
      // 普通弹幕：不逐字复读，而是「接一句」
      return pick([
        `${pick(VARS.think)}，${who}说的这个，${pick(VARS.agree)}`,
        `${pick(VARS.yes)}，${who}说得好`,
        `${pick(VARS.emotion)}，${who}这句话在理`,
        `${who}这个想法不错${pick(VARS.filler)}`,
      ]);
  }
}

/** 把话术里的占位符替换成随机变量词 */
export function fillVars(text) {
  return String(text)
    .replace(/\{(greeting|yes|think|agree|price|call|emotion|filler)\}/g, (_, k) => pick(VARS[k] || ['']))
    // 兼容简写：{pick} {cost} 这类运营随手写的占位符，统一映射到相近词库
    .replace(/\{pick\}/g, () => pick(['这款产品', '这个宝贝', '今天这款', '咱们这个']))
    .replace(/\{cost\}/g, () => pick(VARS.price))
    .replace(/\{[a-z_]+\}/gi, () => '');   // 未知占位符清掉，别念出奇怪的英文
}

/* ------------------------- 随机语气词（拟人化） ------------------------- */

/**
 * 原系统有 suiyyin_zhu / suiyyin_fu 两套「随机短语音库」，
 * 在 AI 语句之间插入，避免句句都是完整长句。
 * 这里返回一小段插入语，让对话有呼吸感。
 */
export function maybeInterjection(role = 'single') {
  if (Math.random() > 0.35) return '';       // 约 35% 概率插一句
  const zhu = ['嗯', '对', '是', '好', '来'];
  const fu = ['明白', '收到', '那我来说', '好的呀', '这个我补充一下'];
  return pick(role === 'host' ? zhu : fu);
}

export const __test = { VARS, replyFor, pick };
