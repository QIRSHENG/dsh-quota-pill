# 网关集成状态（tk-sh7rds）

最后更新：2026-11-25 13:2x（本地时间）｜状态：**集成完成，等待确认**

## 一、已完成

### 1. 宿主集成（lib/index.js，583 行）

| 位置 | 内容 |
|---|---|
| L27-33 | `import { createGateway, GATEWAY_PRESETS, VIRTUAL_MODEL, normalizeGatewayConfig, redactGatewayConfig, mergeGatewayConfig } from './gateway.js'` |
| L45 | `GATEWAY_FILE = $DSH_HOME/zhipu-status/gateway.json` |
| L215-216 | `readGatewayConfig()` → `normalizeGatewayConfig(readJson(GATEWAY_FILE))`，`gatewayConfig` 保存当前配置 |
| L220-230 | `balanceTokensLeft(entry)`：把轮询到的资源包余量折算成总 tokens，供网关低余量跳过 |
| L233-243 | `gatewayEnvelope(entry, body)`：智谱业务包络分类（`{code:401}` 走 auth → 硬失败切换） |
| L245-250 | `createGateway({ getConfig, log, envelope, balanceTokensLeft })` |
| L254-256 | `startGateway() / applyGatewayConfig() / stopGateway()` 三个生命周期包装（SMOKE 下不绑端口） |
| L544-564 | `GET/POST /dsh-zhipu-status/gateway`：GET 回脱敏投影+实时状态；POST → merge → 落盘 → `applyGatewayConfig()` |
| L566-569 | `disposers.push(stopGateway)`：插件销毁时 `stop()` 释放端口 |
| L578 | `startGateway()`：插件启动时 `start()` |

### 2. 网关模块（lib/gateway.js，约 490 行）

- 原有：`createGateway()`（/v1/models、/v1/chat/completions 流式+非流式、/healthz、链路切换、冷却、SSE、tool_calls 透传）
- 新增：`GATEWAY_DEFAULTS`、`normalizeGatewayConfig()`、`redactGatewayConfig()`、`mergeGatewayConfig()`、导出的 `clampTimeout`/`normalizePort`
- 修复点：**空 `apiKey` 视为「保持不变」**（设置页永远读不回 key，只能回空串；旧逻辑会把已存 key 清空）

### 3. 客户端（lib/client.js）

- 新增「智谱多上游网关」设置页（`settings.section` id `zhipu-gateway`，order 91）+ 配套图标
- 链路编辑器：上下移 / 启用开关 / 删除 / 名称 / Base URL / 模型 / key（掩码，留空不改）/ 鉴权方式 / 包络类型 / 一键加全部预设
- 状态行：运行中端口、监听错误、当前上游、冷却中的上游、链路启用数
- 底部给出 DSH 接入指引（Base URL `http://127.0.0.1:<port>/v1`、模型 `auto-router`、占位 key）
- 修复点：补上被调用但从未定义的 `resolveBase()`（旧代码会让 interval 设置 POST 直接抛错）

### 4. 验证脚本（scripts/）

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `build.mjs --smoke` | 清单/语法/路由/设置/栅栏/注册表/包络/网关配置+脱敏+网关路由 | 20 项全绿 |
| `gateway-smoke.mjs` | /v1/models 单模型、假 key A(业务401)→切 B(500)→归一化 502、冷却、key 不外泄、merge 保 key、applyConfig 重绑、stop 释放 | 9 项全绿 |
| `stream-check.mjs` | SSE 顺序透传、流式前切换、JSON→SSE、tool_calls 透传、400 不切换 | 5 项全绿 |
| `lifecycle-check.mjs` | 真实 start 绑定 → POST 触发 applyConfig 重绑 → dispose 释放端口 | 4 项全绿 |
| `client-check.mjs` | bundle 载入、5 个 slot 注册、pill 渲染、两个设置页渲染、保存回传、key 不入渲染树 | 7 项全绿 |

`npm run verify` 串跑以上全部：**exit 0**。

### 5. 提交记录

```
b84bffe test: streaming, stream-failover, json->sse and tool-call passthrough checks
7ef65dd feat: gateway settings panel (multi-upstream chain editor) + client render check
634ad73 wip: gateway integration in progress
9b15251 feat: 智谱资源包余量状态栏插件（dock pill + 设置面板）
```

## 二、过程中踩到的坑（已修）

1. **SMOKE 模式仍绑端口** → build.mjs 冒烟跑完挂住事件循环。已加 `startGateway/applyGatewayConfig` 的 SMOKE 短路。
2. **`resolveBase()` 未定义**（客户端既有缺陷）→ interval 设置 POST 抛 ReferenceError，静默失败。已补定义。
3. **空 apiKey 清空已存 key** → 设置页每次保存都会抹掉上游 key。已改为空串保留旧值。
4. **本机没有 git 在 PATH** → 用 MinGit：`C:\Users\24388\AppData\Local\Programs\MinGit\cmd\git.exe`。
5. **PowerShell 5.1 读写 UTF-8 中文文件会乱码**（`Set-Content -Encoding UTF8` 加 BOM 且中文被 GBK 往返破坏）→ 一律用 write/edit 工具改文件，不要在 PowerShell 里做文本替换。

## 三、边界与未做（按任务约束）

- 没改 DSH checkout，没读任何真实凭据；所有测试 key 都是 `fake-key-*` / `sk-fake-*` / `sk-smoke-fake`。
- 没重构既有 poller / pill / 设置逻辑，只在其上增加网关部分。
- 没 push（任务要求只本地提交）。
- 网关默认 `enabled: false`：装上不会偷偷开端口。
