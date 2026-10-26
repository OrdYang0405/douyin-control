#!/usr/bin/env node
/**
 * asar_extract.mjs — 零依赖 asar 解包（不需要 npm install）
 *
 * 用法: node tools/asar_extract.mjs <app.asar> <输出目录>
 *
 * asar 结构:
 *   0..3   uint32 = 4
 *   4..7   uint32 = headerSize
 *   8..11  uint32 = jsonSize(+padding)
 *   12..15 uint32 = jsonLen
 *   16..   UTF-8 JSON 目录树
 *   数据区 = 8 + headerSize + file.offset
 */
import fs from 'node:fs';
import path from 'node:path';

const [src, outDir] = process.argv.slice(2);
if (!src || !outDir) {
  console.error('用法: node tools/asar_extract.mjs <app.asar> <outDir>');
  process.exit(2);
}

const buf = fs.readFileSync(src);
if (buf.length < 16) throw new Error('文件太小，不是 asar');
const headerSize = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const json = buf.subarray(16, 16 + jsonLen).toString('utf8');
const dataStart = 8 + headerSize;

let tree;
try {
  tree = JSON.parse(json);
} catch (e) {
  throw new Error('头部 JSON 解析失败: ' + e.message);
}

let files = 0;
let bytes = 0;

function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const target = path.join(outDir, rel, name);
    if (entry.files) {
      fs.mkdirSync(target, { recursive: true });
      walk(entry, path.join(rel, name));
    } else if (entry.link) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.symlinkSync(entry.link, target);
      } catch {
        fs.writeFileSync(target + '.link.txt', entry.link);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const start = dataStart + Number(entry.offset || 0);
      const end = start + Number(entry.size || 0);
      const data = buf.subarray(start, end);
      if (entry.unpacked) {
        fs.writeFileSync(target + '.UNPACKED_MARKER', '');
      } else {
        fs.writeFileSync(target, data);
      }
      files++;
      bytes += data.length;
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
walk(tree, '');
console.log(`[✓] 解出 ${files} 个文件，${(bytes / 1024).toFixed(1)} KB → ${path.resolve(outDir)}`);

// 顺带打印顶层结构，便于快速判读
console.log('[i] 顶层:', Object.keys(tree.files || {}).join(', '));
