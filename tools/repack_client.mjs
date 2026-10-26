#!/usr/bin/env node
/**
 * repack_client.mjs — 把「星辰弹幕助手」原客户端改成指向本地方案（不改一行业务逻辑）
 *
 * 做的事：
 *   1. 复制 Electron 应用到 build/client（robocopy，大目录更稳）
 *   2. 解包 resources/app.asar → resources/app/（Electron 在没有 asar 时自动加载目录）
 *   3. 改 platforms.json 的回调地址 → 本地 /socket/index/bullet
 *   4. 把更新源指向本地死链，避免它把官方核心包热更回来、覆盖我们的配置
 *   5. 删掉 app.asar
 *
 * 用法:
 *   node tools/repack_client.mjs --host http://127.0.0.1:8080
 *   node tools/repack_client.mjs --host http://10.0.0.5:8080 --dst build/client2
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i === -1 ? d : args[i + 1];
};

const SRC = path.resolve(get('src', 'captures/target/client/app'));
const DST = path.resolve(get('dst', 'build/client'));
const HOST = String(get('host', 'http://127.0.0.1:8080')).replace(/\/+$/, '');

const asarSrc = path.join(SRC, 'resources', 'app.asar');
if (!fs.existsSync(asarSrc)) {
  console.error('[x] 找不到', asarSrc, '- 先把安装包解开（见 README 复现命令）');
  process.exit(1);
}

console.log('[1/5] 复制应用 →', DST);
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
{
  const r = spawnSync('robocopy', [SRC, DST, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'], { stdio: 'ignore' });
  if (r.status === null || r.status > 7) {
    console.error('[x] robocopy 失败, exit =', r.status);
    process.exit(1);
  }
}

const asar = path.join(DST, 'resources', 'app.asar');
const appDir = path.join(DST, 'resources', 'app');

console.log('[2/5] 解包 app.asar');
execFileSync(process.execPath, ['tools/asar_extract.mjs', asar, appDir], { stdio: 'inherit' });

console.log('[3/5] 改回调地址 →', HOST);
const pf = path.join(appDir, 'platforms.json');
const conf = JSON.parse(fs.readFileSync(pf, 'utf8'));
const url = HOST + '/socket/index/bullet';
conf.callback = { domestic: url, overseas: url };
conf.callbackBackup = { domestic: url, overseas: url };
fs.writeFileSync(pf, JSON.stringify(conf));

console.log('[4/5] 停用官方热更新（防止核心包被换回官方版）');
const main = path.join(appDir, 'main.js');
let src = fs.readFileSync(main, 'utf8');
const before = src.length;
src = src.replace(
  /DEFAULT_UPDATE_BASE_URL\s*=\s*["'][^"']+["']/,
  `DEFAULT_UPDATE_BASE_URL = "${HOST}/output/dm-update/"`
);
src = src.replace(/http:\/\/live\.xc58\.icu\/output\/readme_new\.html/g, HOST + '/');
// 兜底上报地址也改掉：platforms.json 里匹配不到平台时会用它
src = src.replace(/FALLBACK_REPORT_URL\s*=\s*["'][^"']+["']/, `FALLBACK_REPORT_URL = "${url}"`);
fs.writeFileSync(main, src);
console.log(`      主进程改写 ${before} → ${src.length} 字节`);

console.log('[5/5] 删除 app.asar（让 Electron 读 app/ 目录）');
fs.rmSync(asar, { force: true });

fs.writeFileSync(path.join(DST, 'REPACK-README.txt'), [
  '本目录是改过回调地址的「星辰弹幕助手」，业务代码未改。',
  '',
  '启动：双击 星辰弹幕助手.exe',
  '用法：',
  '  1) 先启动本地服务： pwsh -File start.ps1',
  '  2) 在控制台建一个直播位，复制它的 live_id',
  '  3) 客户端里填「直播间地址」+ 那个 live_id，点开始监听',
  '  4) 弹幕会 POST 到 ' + url,
  '',
  '若客户端报错，检查 resources/app/platforms.json 里的 callback 是否正确。',
].join('\r\n'), 'utf8');

console.log('[✓] 完成：', DST);
console.log('    双击运行：', path.join(DST, '星辰弹幕助手.exe'));
