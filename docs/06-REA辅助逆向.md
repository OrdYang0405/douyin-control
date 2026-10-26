# 用 REA 辅助逆向（rea-agents）

来源：`https://github.com/morluto/rea`（MCP 逆向平台，npm 包 `rea-agents`）
用途：对**已落地的产物**做结构化静态分析，补手工 grep 拿不到的「调用链 + 证据溯源 + 分析边界声明」。

---

## 1. 环境与限制（先看这条）

| 项 | 本机 | REA 要求 | 结论 |
|---|---|---|---|
| Node | v24.14.0 | `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1` | **不满足**，npm 报 `EBADENGINE`，但**实测可运行** |
| npm | 11.9.0 | — | OK |
| JDK | 17.0.19 | APK 分析需完整 JDK | OK（本次未用） |

装法与调用（无需全局安装）：

```powershell
npx -y rea-agents@latest --version            # 6.8.0
npx -y rea-agents@latest analyze-javascript-application <目录或asar> --json
```

> `EBADENGINE` 只是警告，实际跑通。若后续版本变严格，需要把 Node 升到 24.22+。

---

## 2. 本次实际跑的命令与产出

```powershell
npx -y rea-agents@latest analyze-javascript-application `
  "D:\DeepSeek-Harness\逆向直播后台助手\captures\target\client\asar" --json
```

| 产出 | 位置 | 说明 |
|---|---|---|
| 原始 Evidence | `captures/rea/client-analysis.json` | 16.7 MB，含 progress 行 + 一条完整 Evidence JSON |
| 提炼摘要 | `captures/rea/summary.json` | 5.5 KB，只留结论 |

分析范围：**25 个文件、13417 个 AST 节点、98 条 findings、0 解析失败**。
`confidence=derived`、`authority=shipped-artifact`。

---

## 3. 它给出的结论（已与手工逆向交叉验证）

### 3.1 Electron 结构

```json
{ "browser_windows": 1, "explicit_web_preferences": 5,
  "context_bridge_apis": 1, "exposed_api_members": 15,
  "preload_entrypoints": 0, "utility_processes": 0, "native_addon_bindings": 0 }
```

### 3.2 完整 IPC 契约（45 条调用链，全部核对无误）

| bridge 成员 | 通道 | Electron API | 方向 |
|---|---|---|---|
| `api.report` | `report` | `ipcRenderer.invoke` | ← 弹幕上报，最关键 |
| `api.saveConfig` | `save-config` | `invoke` | 写配置 |
| `api.getConfig` | `get-config` | `invoke` | 读配置 |
| `api.getPlatforms` | `get-platforms` | `invoke` | 平台表 |
| `api.getBranding` | `get-branding` | `invoke` | 品牌信息 |
| `api.checkUpdate` | `check-update` | `invoke` | 检查更新 |
| `api.applyUpdate` | `apply-update` | `invoke` | 应用更新 |
| `api.clearCache` | `clear-cache` | `invoke` | 清缓存 |
| `api.copyText` | `copy-text` | `invoke` | 剪贴板 |
| `api.openExternal` | `open-external` | `invoke` | 开外链 |
| `api.isDebug` | `get-debug` | `invoke` | 调试位 |
| `api.onNetLog` | `live-net-log` | `ipcRenderer.on` | 网络日志 |
| `api.onUpdateLog` | `update-log` | `on` | 更新日志 |
| `api.onUpdateAvailable` | `update-available` | `on` | 有新版 |
| `api.onUpdateNone` | `update-none` | `on` | 无新版 |

另 3 个 webview→宿主通道：`tk-barrage`（弹幕）、`tk-status`（健康度）、`tk-zoom`（缩放）。

> 这与我手工读 `preload.js`/`main.js`/`webview-preload.js` 得出的完全一致 —— **REA 作为独立交叉验证是可信的**。

### 3.3 一个安全发现（我已手工复核）

```
sender_validation_observations: 0
```

手工 grep 确认：11 个 `ipcMain.handle`，**零处** `senderFrame` / `event.sender` / `senderId` 校验。

```js
ipcMain.handle("report", async (e, t) => {
  const n = resolveReportUrls(t && t.platformKey);
  const a = Object.assign({}, t);
  delete a.platformKey; delete a.detectedAt;
  const r = await postWithFailover(n, a);   // 直接信任入参
  ...
});
```

**含义**：任何加载进它 webview 的页面（含被劫持的直播间）都能调 `window.api.report` 伪造弹幕。
这与「服务端只校验 `live_id`」互为印证 —— 整条链路上**没有任何一环验证消息来源**。

### 3.4 它明确声明的分析边界（重要，别当全知）

REA 自带 `limitations`，摘录三条最关键的：

- Graph coverage is incomplete; unavailable facts remain explicit and **must not be read as absence**.
- JavaScript and HTML were parsed as inert text; **bundle bootstrap code was never executed**.
- Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.

也就是说：**REA 没发现 ≠ 不存在**。本项目的动态行为结论（弹幕真的能收到、语音真的能合成）仍以实测为准。

---

## 4. 还能用它做什么（针对本项目）

| 能力 | 对哪部分 | 命令 | 备注 |
|---|---|---|---|
| Web 包分析 | 控制台 `xcai1618.com/web` | `analyze-web-bundle <origin>` | 会自动抓包 + 静态分析 |
| 网站观察 | 控制台网络请求 | `capture-browser-scenario` / `capture-web-screenshot` | 需 Chrome |
| HAR/SAZ 解析 | 弹幕链路抓包 | `analyze` + capture | 支持 mitmproxy 流量 |
| APK 分析 | 我们已解出的 `app.apk` | `decode-android-resources` + JADX 流程 | JDK 17 已具备 |
| Electron 运行时场景 | 客户端的真实运行行为 | `capture-electron-scenario` | 比静态更强，会真的跑 |
| 版本对比 | 客户端 v28 vs 更新版 | `compare-application-versions` | 我们手上只有一个版本 |

**不建议**用它做的：抖音 WSS 协议解析（那是网络协议，不是代码结构），这块继续用我们自己的 `douyin-decode.mjs` + 实测。

---

## 5. `doctor` 体检结果（决定哪些能力现在可用）

```
healthy: false   environment_healthy: false
```

| 检查项 | 状态 | 说明 | 影响 |
|---|---|---|---|
| `host` | ✅ | win32 x64 | — |
| `node` | ✅ 24.22.1 | 已从 24.14.0 升级 | — |
| `jadx` | ✅ | JAR 已校验（sha256 匹配发布方） | APK 分析可用 |
| `hopper` | ❌ | 未安装 | 原生二进制分析不可用 |
| `ghidra` | ❌ | `GHIDRA_INSTALL_DIR` 未设 | 同上 |
| `ida-registration` | ❌ | 未配置 | 同上 |

### 为跑通 APK 线做的两件事

```powershell
nvm install 24.22.1 && nvm use 24.22.1          # node 达标
# 下载 REA 审计过的 jadx-headless-mcp v0.7.1（40.65 MB）
curl.exe -L -o tools/jadx/jadx-headless-mcp-0.7.1-all.jar `
  "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar"
# 校验：6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75  ✅ 与官方一致
[Environment]::SetEnvironmentVariable('REA_JADX_MCP_JAR', '<绝对路径>', 'User')
```

---

## 5.1 REA 的能力边界（实测踩到的）

对 APK 里的 `www` 目录跑 `analyze-javascript-application` 时：

```
app-service.js: Resource constraint — Owned JavaScript worker exhausted
its 1024 MiB V8 old-space heap (max_heap_mb) during static analysis
```

**1.8 MB 单行 JS（uni-app 编译产物）直接把 worker 堆打爆**，输出 121 MB 且分析不完整。

结论：
- REA 适合**多文件、结构化**的代码库（我们的 Electron 客户端 25 个文件 → 完美）
- 不适合**超长单行 bundle**（uni-app 产物）；这类目标手工正则定位反而更快更准

---

## 6. 落地建议

1. **保留 `captures/rea/`** 作为证据基线；后续客户端升级时重跑一次，用 `compare-application-versions` 看差异
2. **IPC 契约表**可直接用于：改成我们自己的客户端（加 sender 校验、换通道名）或写第三方宿主
3. **别用它替代实测**：它对动态行为一律标注 unresolved，我们的稳定性结论必须来自实跑
4. 若要用 APK 那条线，先确认 JADX 可用（`npx rea-agents@latest doctor` 会体检）
