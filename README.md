# dsh-quota-pill

[![version](https://img.shields.io/badge/version-0.1.0-blue)]() [![dsh](https://img.shields.io/badge/DSH-0.2.2.x-green)]() [![license](https://img.shields.io/badge/license-MIT-lightgrey)]()

DeepSeek Harness（DSH）插件：把 **AI 服务的额度/余量** 显示在输入框下方的状态栏（composer dock）里，与官方的 tok/s、缓存命中统计 pill 并排，并在 **DSH 设置面板新增一个「AI 额度」页**（内部用标签页切换「监控」与「网关」两个面板）完成全部配置。

数据源层是 **provider 注册表**：智谱（GLM）是当前唯一接入的 provider（注册表第 1 条），DeepSeek / 硅基流动 / OpenRouter 等只需往注册表加条目。插件本体与 UI 全部中性命名，不绑定任何单一厂商。

![screenshot placeholder：状态栏 pill + 设置面板截图（发布前替换 assets/screenshot.png）](assets/screenshot.png)

<!-- 发布前：截一张「状态栏 pill（如 `12.5M · 12-25`）」与「设置 → AI 额度」的图，存到 assets/screenshot.png -->

## 功能

- 📊 **状态栏 pill**：余量（`12.5M` 压缩格式）· 到期日期（`12-25`）· 降频标记；hover 显示每个资源包的完整明细；字体与字号跟随 DSH 主题（与官方 ActivityPill/UsagePill 同一基线，无自定义字体），只有「文字大小」设置可以覆盖字号（dock 官方插槽 `conversation.composer.dock`，`replaceRisk: 'none'`，新增独立 id `quota-pill`）
- ⚙️ **设置面板（单栏位双标签页）**：DSH 设置 → 「AI 额度」（官方 `settings.section` 插槽，只占一个侧栏位）
  - **监控页**：
    - **API Key 直填**：`type=password` 掩码输入框，placeholder 显示当前状态（如 `已配置(尾4位 a1b2)`）；保存后立即生效并触发一次重新轮询；支持清除
    - 在状态栏显示 / 隐藏 pill
    - 轮询间隔：1–60 分钟下拉，默认 **2 分钟**；低于 2 分钟会提示限流风险；改动即时生效
    - 文字大小：跟随主题 / 小 / 中 / 大
    - 显示内容开关：余量 / 到期 / 降频状态
    - 低余额提醒阈值：余量低于该值时数字高亮（0 = 关闭）
    - 状态行：数据模式、面板 Key 状态（掩码）、上次成功时间、降频状态
  - **网关页**：
    - 启用本地网关 / 端口 / 上游超时 / 冷却时长 / 低余量跳过阈值
    - 上游链路编辑器（名称 / Base URL / 模型 / key / 鉴权方式 / 包络类型 / 上下移 / 启用 / 删除 / 一键加预设）
- 🔁 **自动降级链**：资源包余量 → Coding Plan 订阅窗口 → 可读的降级态（见下表）
- 🧩 **provider 注册表架构**：数据源层按 provider 注册表组织（域名匹配 / 端点 / 鉴权 / 解析 / 到期字段各为一个条目字段），智谱是第 1 条；加新 provider 只需加注册表条目，不改核心
- 🔀 **本地多上游网关**（可选，默认关闭）：在本机开一个 OpenAI 兼容入口，把 DSH 的一条 provider 变成一个「按你排序的上游链路」，命中 401/402/403/429、业务包络鉴权错误或 5xx 时自动切下一条

## API Key 配置（三来源优先级链）

宿主按以下顺序解析凭据，**任何一处都不落明文到插件配置或日志**：

1. **面板直填**（设置 → AI 额度 → 监控）：保存在宿主 `$DSH_HOME/quota-pill/auth.json`，存储时做 base64 掩码（文件里只有 `apiKeyEncoded`，没有明文）。**空串=保持不变；「清除」按钮才删除**；保存新值直接替换并立即重新轮询。
2. **DSH 官方凭据服务**，凭据名 `ZHIPU_API_KEY`。如果本机装了 dsh-whale-widget：在它的「小鲸鱼记账 → 模型 → 智谱 GLM Coding Plan（订阅）」模板里填一次 key，它会写进凭据服务的 `ZHIPU_API_KEY`，本插件直接共用。
3. **宿主环境变量** `ZHIPU_API_KEY`（启动 DSH 的进程环境里设置）。

三处都没有时，pill 显示「未配置 API Key」，每 60 秒自动重查（后配的 key 无需重启）。

**隐私边界**：key 的任何接口投影只有 `hasKey: true/false` + `maskedHint`（尾 4 位）；`GET /dsh-quota-pill/key`、`GET /dsh-quota-pill/quota`、调试日志里都不会出现明文。面板输入框永远为空（不回显已存 key），placeholder 用 `已配置(尾4位 xxxx)` 表达状态。

## 本地多上游网关

用途：DSH 里一个自定义 provider 只能填一个 base URL + 一个 key。想在**智谱额度用尽时自动换到 DeepSeek / 硅基流动 / OpenRouter**，就让它指向本插件的本地网关。

设置 → **AI 额度 → 网关**：

| 项 | 说明 |
|---|---|
| 启用本地网关 | 在 `127.0.0.1:<port>` 上监听；默认端口 `18434`，被占用时状态行会提示换端口 |
| 上游链路 | 按顺序排列的条目（名称 / Base URL / 模型 / key / 鉴权方式 / 包络类型），可上下移、禁用、删除；也可一键加全部预设 |
| 上游超时 | 10–600 秒，默认 120 秒（既管首字节，也管流式空闲间隔） |
| 冷却时长 | 硬失败的上游暂停多久，默认 5 分钟 |
| 低余量跳过 | 智谱余量低于该值时跳过该上游（联动监控页轮询数据）；0 = 关闭 |

**切换规则**：HTTP 401/402/403/429 → 立即硬失败；5xx 或网络错误 → 软失败，连续 2 次转硬失败；智谱风格的 `{code:401}` 业务包络（HTTP 200 里报鉴权失败）→ 硬失败。**400/404/422 这类请求本身的错误不会切换**，直接以归一化错误体返回（`error.type=upstream_error`）。链路全挂时返回 `502 / gateway_upstream_error / chain_exhausted`。

**流式**：首字节写出前都可以切换；一旦开始转发 SSE，上游中断只是结束本次响应并记一次软失败（不会把半截输出换成另一个上游）。

**接入 DSH**：

```text
Base URL：http://127.0.0.1:18434/v1
模型：auto-router
API key：任意占位值（网关不校验；真实上游 key 只存在下面的 gateway.json 里）
```

`GET /v1/models` 只返回 `auto-router` 一个条目，工具调用（`tool_calls`）原样透传。

**密钥位置**：上游 key 只写在 `$DSH_HOME/quota-pill/gateway.json`（与缓存同一信任域，文件权限与 DSH 家目录一致）。设置接口只回 `hasKey: true/false`，**任何接口和日志都不会回传 key**；页面上已保存的 key 显示为掩码，留空即保持不变。

### 上游实测备注（2026-11-26）

- **阿里云百炼（DashScope）**：按量付费 key（`sk-ws-` 开头的三段式格式）。已入链：
  `baseUrl=https://dashscope.aliyuncs.com/compatible-mode/v1`、`model=qwen-plus`、`authStyle=bearer`、`envelope=none`。
  额度口径是**每个模型独立的 100 万 token 免费额度**（70+ 可用模型 ≈ 7000 万+ token 总量，有效期 90 天，
  自开通起算）。百炼没有 key 级余额 API（`/api/v1/recharge/recharge-balance/query` 已下线，多路径实测 404；
  官方口径仅控制台可查），所以网关的「低余量跳过」对百炼条目天然不生效（envelope=none 不参与余量联动）。
  qwen-plus 的 1M 额度烧完后，网关 failover 会切下一家；**换模型名 = 换一个新的 1M 额度池**——在网关页把该
  条目的模型改成另一个未用过的模型即可。同口径候选：`qwen-flash`、`qwen-max`、`qwen3-coder-flash`
  （均在实测模型清单 191 个内），1M/模型的量级下 qwen-plus 甚至 qwen-max 都够撑多轮复杂任务。

- **硅基流动（SiliconFlow CN）**：`sk-rl…ubqz` key 有效（chat 终验 HTTP 200），已入链第二条（id `siliconflow-xing`，
  `baseUrl=https://api.siliconflow.cn/v1`、`model=XingChenAGI/Xing4.0-29B`、`authStyle=bearer`、`envelope=none`），
  但**默认 `enabled:false`**：模型列表已无 `/Free` 后缀（92 个模型全计费），Xing4.0-29B 是计费模型，failover
  触及会真实扣费。链上实际只走百炼；这条留作用户手动启用的备用位（设置面板网关 tab 打开即可）。用户明确
  「实在没钱」，故免费档 key 到手也不放计费档上链。

## key 归属与处置清单（探针结论，2026-11-26）

| key 形态 | 归属判定 | 探针结果 | 处置 |
|---|---|---|---|
| `AQ.` 前缀（53 位、单点分隔） | Google AI Studio 新版 Authentication Key | `generativelanguage.googleapis.com` 连接层失败（本机无代理，直连不通） | 暂不入链，待可用代理环境再探（x-goog-api-key 头或 ?key= 均可） |
| `sk-rl…ubqz`（硅基流动 CN 站） | 有效已入链（key 从控制台复制、未删除）；CN 站 `/v1/models` 端点需鉴权，无鉴权 401「Token is invalid」、带 key 200 实证；chat 终验 `XingChenAGI/Xing4.0-29B` HTTP 200（max_tokens=5） | 国际站 401 仅说明 key 归属 CN 站；CN 站 `user/info` 已 410 弃用；**免费档已缩水，模型列表无 `/Free` 后缀，Xing4.0-29B 为计费模型** | 有效已入链但默认禁用（failover 触及会真实扣费；用户接受付费可自行在设置面板启用） |

## 安装

> 目录名说明：本仓库曾用包名 `dsh-zhipu-status`，现包名为 `dsh-quota-pill`（仓库与功能已中性化）。本地 link 安装沿用历史目录 `E:\DeepSeek\dsh-zhipu-status`，包名以 package.json 为准。

### 方式一：npm（推荐，web profile）

```sh
dsh plugin --profile web add dsh-quota-pill
```

### 方式二：本地开发

```sh
dsh plugin --profile web add link:E:\DeepSeek\dsh-zhipu-status
```

### 方式三：GitHub 仓库

```sh
dsh plugin --profile web add github:QIRSHENG/dsh-quota-pill
```

### 官方桌面客户端（Electron / desktop profile）

桌面 profile 归应用自己的插件管理器管。升级自旧版 `dsh-zhipu-status` 时，先移除旧条目再按新包名添加：

```sh
dsh plugin --profile desktop remove dsh-zhipu-status
dsh plugin --profile desktop add link:E:\DeepSeek\dsh-zhipu-status
dsh plugin --profile desktop list   # 确认 dsh-quota-pill 已挂载
```

或在应用内 设置 → 插件 安装。桌面端支持为 best-effort：pill 走官方 client-module 加载（`dsh.client` 声明 + `/plugins` 组合图），页面相对请求如被桌面壳代理到本地宿主则正常工作。

## 旧版数据迁移（dsh-zhipu-status → dsh-quota-pill）

旧版插件把数据写在 `$DSH_HOME/zhipu-status/`。新版**首次启动时自动做一次性迁移**：

1. `config.json` / `cache.json` / `gateway.json` / `auth.json` / `debug.log` 原样复制到 `$DSH_HOME/quota-pill/`（原文件内容不变）；
2. 迁移完成后旧目录改名为 `zhipu-status.bak-<时间戳>` **永久保留，绝不删除**；
3. `$DSH_HOME/quota-pill/` 已有数据时跳过迁移（不覆盖新数据），并在日志中记录；
4. 迁移过程写入插件调试日志（无任何敏感内容）。

迁移后 pill 立即按旧缓存显示历史余量，轮询配置（间隔等）原样生效。

## 降级行为

| 情形 | pill 显示 | 行为 |
|---|---|---|
| 未配置 key | 未配置 API Key | 每 60s 重查凭据，不计失败 |
| key 无效（业务 401） | 凭据无效 | 计失败；连 3 次 → 降频 |
| 接口返回非预期业务码 | 额度 · 接口异常 | 计失败；连 3 次 → 降频 |
| 网络/超时/429 退避耗尽 | 额度 · 重试中 | 计失败；429 先 30s→60s 退避重试 |
| 接口可达但无数据 | 额度 · 暂无数据 | 正常轮询，不计失败 |
| 连续 3 次失败 | 末尾加「降频」 | 轮询自动放宽到 15 分钟；任一次成功即恢复设置间隔 |
| 重启 DSH | 立即显示上次缓存 | 先读 `$DSH_HOME/quota-pill/cache.json` 再刷新 |

所有失败都**静默降级**（pill 上的可读文案），不弹错误框。调试日志写在 `$DSH_HOME/quota-pill/debug.log`（状态码、响应字段名、到期候选字段；**绝不记录 key**），设置面板或 `GET /dsh-quota-pill/log` 可查看尾部 60 行。

## 数据来源与可靠性

- 端点 `https://open.bigmodel.cn/api/biz/tokenAccounts/list/my`（资源包余量，响应 `rows[].tokenBalance × tokensMagnitude`）与 `https://open.bigmodel.cn/api/monitor/usage/quota/limit`（Coding Plan 订阅窗口）**均为智谱控制台内部接口，非官方公开契约**，来自公开第三方逆向工程（glm-for-copilot、ZCode 官方集成文档、dsh-whale-widget 内置模板交叉印证），**随时可能变更或下线**。本插件不含任何官方背书。
- **实测记录（2026-11-25，假 key）**：三个端点对无效 key 均返回 **HTTP 200 + 业务包络 `{code:401, msg:"令牌已过期或验证不正确"}`**——鉴权失败不走 HTTP 401；插件已按业务包络分类（`readEnvelope`），无效 key 正确落到「凭据无效」而非「无数据」。
- **有效期字段**：资源包 rows 中未见明确到期字段（截至 2026-11-25）；插件会扫描每行的日期类字段并写入调试日志，解析不到显示「到期未知」。
- **鉴权**：优先 `Authorization: Bearer <key>`，失败自动尝试裸 key（智谱 monitor 端点历史上接受裸 key、拒绝 Bearer）；不支持也不读取浏览器 Cookie。若智谱未来改为登录态（Cookie）鉴权，插件会表现为「凭据无效」，需要等适配。
- 资源包账号（非 Coding Plan 订阅）调用订阅端点会返回「当前用户不存在 coding plan」——插件据此识别并继续以资源包数据为准。

## 字体与样式

pill 与设置面板**不声明任何 `font-family`**：字体、字号、行高全部跟随 DSH 主题（`font: inherit` + `--dsh-content-font-size-secondary` / `--dsh-content-font-delta-secondary`，与官方 ActivityPill/UsagePill 同一基线）；颜色用 `--dsw-alias-*` 主题变量。「文字大小」设置只通过内联 fontSize 覆盖 pill 字号。

## 设置持久化

设置存浏览器 `localStorage`（`dsh.quotaPill.settings.v1`；旧键 `dsh.zhipuStatus.settings.v1` 会自动读取），刷新后保留；轮询间隔同时 POST 给宿主持久化到 `$DSH_HOME/quota-pill/config.json`。改动即时生效，无需刷新页面。

## 路由一览（宿主本地）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-quota-pill/quota` | GET | 快照（packs/窗口/状态）+ key 投影（hasKey + 尾 4 位） |
| `/dsh-quota-pill/settings` | POST | `{ intervalMinutes }`（1..60，钳制） |
| `/dsh-quota-pill/key` | GET | key 投影 `{ hasKey, maskedHint }` |
| `/dsh-quota-pill/key` | POST | `{ apiKey }`（'' = 不改；`{ clear: true }` = 删除；新值替换并立即重轮询） |
| `/dsh-quota-pill/gateway` | GET/POST | 网关投影 / 补丁 → 落盘 → applyConfig() |
| `/dsh-quota-pill/log` | GET | 调试日志尾部 60 行（无敏感内容） |

## 开发

```sh
node scripts/build.mjs             # 语法 + 清单检查
node scripts/build.mjs --smoke     # + mock 上下文冒烟（路由/设置/key 链/栅栏/注册表/包络/网关配置）
node scripts/gateway-smoke.mjs     # 网关冒烟：/v1/models、假 key 双上游切换、归一化错误体、key 不外泄
node scripts/stream-check.mjs      # 流式透传 / 流式切换 / JSON→SSE / tool_calls 透传 / 400 不切换
node scripts/lifecycle-check.mjs   # 真实起停：start 绑定 → POST applyConfig() 重绑 → dispose 释放
node scripts/migration-check.mjs   # 旧数据迁移：zhipu-status/ → quota-pill/，.bak 保留，旧缓存可读
node scripts/client-check.mjs      # 客户端 bundle 渲染：pill + 单 section 双 tab + key/gateway 保存回传 + 无 font-family/旧 id 断言
node scripts/probe.mjs             # 假 key 真实链路探测（期待 auth-error；无密钥参与）
npm run verify                     # 上面除 probe 外全部串跑（CI 用这个）
```

零运行时依赖；宿主侧只需 Node ≥ 20 内置 fetch。目录结构：

```text
package.json        # dsh.bundle.patch + dsh.client 声明（platform: web）
cordis.patch.yml    # 宿主插件挂载行（id: dsh-quota-pill）
lib/index.js        # 宿主：轮询 + key 优先级链 + 路由 + 缓存 + 迁移 + 网关生命周期挂载
lib/gateway.js      # 宿主：OpenAI 兼容本地网关（链路切换 + 配置归一化/脱敏）
lib/providers.js    # provider 注册表（智谱为第 1 条；v2 扩展缝）
lib/client.js       # 浏览器：composer dock pill + 单设置 section（监控/网关双 tab）
scripts/            # build + 五个验证脚本 + probe
```

## Roadmap

- **v2: 多 provider 支持**（DeepSeek `/user/balance`、硅基流动 `/v1/user/info`、OpenRouter `/api/v1/key`；贴控制台 URL 自动按域名识别 provider）——数据源层已按 provider 注册表预留，只需新增条目。
- 网关侧：链路健康度可视化（每上游的成功率/最近错误）、按模型名分流到指定上游。
- 低余额阈值高亮的视觉打磨、到期字段适配（等智谱响应里出现明确字段）。

## 免责声明

本插件为社区项目，与 DeepSeek、智谱（Zhipu AI / Z.ai）及其他模型服务商无任何隶属或官方关系。所用内部接口非官方契约，余量数据仅供参考，不构成账单依据；接口变更导致的显示错误请先看调试日志与本 README 的「数据来源与可靠性」。请勿在公共/不受信任的网络环境下暴露 DSH 宿主端口。

## License

MIT
