# dsh-zhipu-status

[![version](https://img.shields.io/badge/version-0.1.0-blue)]() [![dsh](https://img.shields.io/badge/DSH-0.2.2.x-green)]() [![license](https://img.shields.io/badge/license-MIT-lightgrey)]()

DeepSeek Harness（DSH）插件：把**智谱（GLM）Token 资源包余量与到期时间**显示在输入框下方的状态栏（composer dock）里，与官方的 tok/s、缓存命中统计 pill 并排，并在 **DSH 设置面板新增「智谱资源包」页**进行全部配置。

![screenshot placeholder：状态栏 pill + 设置面板截图（发布前替换 assets/screenshot.png）](assets/screenshot.png)

<!-- 发布前：截一张「状态栏 pill（如 `12.5M · 12-25`）」与「设置 → 智谱资源包」的图，存到 assets/screenshot.png -->

## 功能

- 📊 **状态栏 pill**：余量（`12.5M` 压缩格式）· 到期日期（`12-25`）· 降频标记；hover 显示每个资源包的完整明细；宽度受控，不遮挡官方统计 pill（dock 官方插槽 `conversation.composer.dock`，`replaceRisk: 'none'`，新增独立 id `zhipu-quota`）
- ⚙️ **设置面板**：DSH 设置 → 「智谱资源包」（官方 `settings.section` 插槽）
  - 在状态栏显示 / 隐藏 pill
  - 轮询间隔：1–60 分钟下拉，默认 **2 分钟**；低于 2 分钟会提示限流风险；改动即时生效（宿主轮询同步调整，无需刷新）
  - 文字大小：跟随主题 / 小 / 中 / 大
  - 显示内容开关：余量 / 到期 / 降频状态
  - 低余额提醒阈值：余量低于该值时数字高亮（0 = 关闭）
  - 状态行：数据模式、上次成功时间、降频状态
- 🔁 **自动降级链**：资源包余量 → Coding Plan 订阅窗口 → 可读的降级态（见下表）
- 🧩 **provider 注册表架构**：数据源层按 provider 注册表组织（域名匹配 / 端点 / 鉴权 / 解析 / 到期字段各为一个条目字段），智谱是 v1 的第一条；加新 provider 只需加注册表条目，不改核心
- 🔀 **本地多上游网关**（可选，默认关闭）：在本机开一个 OpenAI 兼容入口，把 DSH 的一条 provider 变成一个「按你排序的上游链路」，命中 401/402/403/429、智谱业务包络鉴权错误或 5xx 时自动切下一条

## 本地多上游网关

用途：DSH 里一个自定义 provider 只能填一个 base URL + 一个 key。想在**智谱额度用尽时自动换到 DeepSeek / 硅基流动 / OpenRouter**，就让它指向本插件的本地网关。

设置 → **智谱多上游网关**：

| 项 | 说明 |
|---|---|
| 启用本地网关 | 在 `127.0.0.1:<port>` 上监听；默认端口 `18434`，被占用时状态行会提示换端口 |
| 上游链路 | 按顺序排列的条目（名称 / Base URL / 模型 / key / 鉴权方式 / 包络类型），可上下移、禁用、删除；也可一键加全部预设 |
| 上游超时 | 10–600 秒，默认 120 秒（既管首字节，也管流式空闲间隔） |
| 冷却时长 | 硬失败的上游暂停多久，默认 5 分钟 |
| 低余量跳过 | 智谱余量低于该值时跳过该上游（联动上方资源包轮询数据）；0 = 关闭 |

**切换规则**：HTTP 401/402/403/429 → 立即硬失败；5xx 或网络错误 → 软失败，连续 2 次转硬失败；智谱风格的 `{code:401}` 业务包络（HTTP 200 里报鉴权失败）→ 硬失败。**400/404/422 这类请求本身的错误不会切换**，直接以归一化错误体返回（`error.type=upstream_error`）。链路全挂时返回 `502 / gateway_upstream_error / chain_exhausted`。

**流式**：首字节写出前都可以切换；一旦开始转发 SSE，上游中断只是结束本次响应并记一次软失败（不会把半截输出换成另一个上游）。

**接入 DSH**：

```text
Base URL：http://127.0.0.1:18434/v1
模型：auto-router
API key：任意占位值（网关不校验；真实上游 key 只存在下面的 gateway.json 里）
```

`GET /v1/models` 只返回 `auto-router` 一个条目，工具调用（`tool_calls`）原样透传。

**密钥位置**：上游 key 只写在 `$DSH_HOME/zhipu-status/gateway.json`（与缓存同一信任域，文件权限与 DSH 家目录一致）。设置接口只回 `hasKey: true/false`，**任何接口和日志都不会回传 key**；页面上已保存的 key 显示为掩码，留空即保持不变。

## 安装

### 方式一：npm（推荐，web profile）

```sh
dsh plugin --profile web add dsh-zhipu-status
```

### 方式二：本地开发

```sh
dsh plugin --profile web add link:E:\DeepSeek\dsh-zhipu-status
```

### 方式三：GitHub 仓库

```sh
dsh plugin --profile web add github:OWNER/dsh-zhipu-status
```

### 官方桌面客户端（Electron / desktop profile）

桌面 profile 归应用自己的插件管理器管，CLI 会拒绝 `--profile desktop`。请**在桌面端会话里让 DSH 自己装**（对话里让它调用 `plugin_manager` 的 `install_bundle`），或用应用内 设置 → 插件 安装。桌面端支持为 best-effort：pill 走官方 client-module 加载（`dsh.client` 声明 + `/plugins` 组合图），页面相对请求如被桌面壳代理到本地宿主则正常工作。

### 通过 dshmarket 安装

dshmarket 的安装源限制在其 registry（awesome-dsh-plugin）收录范围内；插件收录后可直接在 设置 → 插件市场 一键安装（见 Roadmap）。

## 配置 ZHIPU_API_KEY

宿主按以下顺序解析凭据，**任何一处都不落明文到插件配置**：

1. **DSH 官方凭据服务**，凭据名 `ZHIPU_API_KEY`。如果本机装了 dsh-whale-widget：在它的「小鲸鱼记账 → 模型 → 智谱 GLM Coding Plan（订阅）」模板里填一次 key，它会写进凭据服务的 `ZHIPU_API_KEY`，本插件直接共用。
2. **宿主环境变量** `ZHIPU_API_KEY`（启动 DSH 的进程环境里设置）。

两者都没有时，pill 显示「未配置 ZHIPU_API_KEY」，每 60 秒自动重查凭据（后配的 key 无需重启）。

## 降级行为

| 情形 | pill 显示 | 行为 |
|---|---|---|
| 未配置 key | 未配置 ZHIPU_API_KEY | 每 60s 重查凭据，不计失败 |
| key 无效（业务 401） | 智谱凭据无效 | 计失败；连 3 次 → 降频 |
| 接口返回非预期业务码 | 智谱 · 接口异常 | 计失败；连 3 次 → 降频 |
| 网络/超时/429 退避耗尽 | 智谱 · 重试中 | 计失败；429 先 30s→60s 退避重试 |
| 接口可达但无数据 | 智谱 · 暂无资源包 | 正常轮询，不计失败 |
| 连续 3 次失败 | 末尾加「降频」 | 轮询自动放宽到 15 分钟；任一次成功即恢复设置间隔 |
| 重启 DSH | 立即显示上次缓存 | 先读 `$DSH_HOME/zhipu-status/cache.json` 再刷新 |

所有失败都**静默降级**（pill 上的可读文案），不弹错误框。调试日志写在 `$DSH_HOME/zhipu-status/debug.log`（状态码、响应字段名、到期候选字段；**绝不记录 key**），设置面板或 `GET /dsh-zhipu-status/log` 可查看尾部 60 行。

## 数据来源与可靠性

- 端点 `https://open.bigmodel.cn/api/biz/tokenAccounts/list/my`（资源包余量，响应 `rows[].tokenBalance × tokensMagnitude`）与 `https://open.bigmodel.cn/api/monitor/usage/quota/limit`（Coding Plan 订阅窗口）**均为智谱控制台内部接口，非官方公开契约**，来自公开第三方逆向工程（glm-for-copilot、ZCode 官方集成文档、dsh-whale-widget 内置模板交叉印证），**随时可能变更或下线**。本插件不含任何官方背书。
- **实测记录（2026-11-25，假 key）**：三个端点对无效 key 均返回 **HTTP 200 + 业务包络 `{code:401, msg:"令牌已过期或验证不正确"}`**——鉴权失败不走 HTTP 401；插件已按业务包络分类（`readEnvelope`），无效 key 正确落到「凭据无效」而非「无数据」。
- **有效期字段**：资源包 rows 中未见明确到期字段（截至 2026-11-25）；插件会扫描每行的日期类字段并写入调试日志，解析不到显示「到期未知」。
- **鉴权**：优先 `Authorization: Bearer <key>`，失败自动尝试裸 key（智谱 monitor 端点历史上接受裸 key、拒绝 Bearer）；不支持也不读取浏览器 Cookie。若智谱未来改为登录态（Cookie）鉴权，插件会表现为「凭据无效」，需要等适配。
- 资源包账号（非 Coding Plan 订阅）调用订阅端点会返回「当前用户不存在 coding plan」——插件据此识别并继续以资源包数据为准。

## 设置持久化

设置存浏览器 `localStorage`（`dsh.zhipuStatus.settings.v1`），刷新后保留；轮询间隔同时 POST 给宿主持久化到 `$DSH_HOME/zhipu-status/config.json`。改动即时生效，无需刷新页面。

## 开发

```sh
node scripts/build.mjs          # 语法 + 清单检查
node scripts/build.mjs --smoke  # + mock 上下文冒烟（路由/设置/栅栏/注册表/包络分类/网关配置）
node scripts/gateway-smoke.mjs  # 网关冒烟：/v1/models、假 key 双上游切换、归一化错误体、key 不外泄
node scripts/stream-check.mjs   # 流式透传 / 流式切换 / JSON→SSE / tool_calls 透传 / 400 不切换
node scripts/lifecycle-check.mjs# 真实起停：start 绑定 → POST applyConfig() 重绑 → dispose 释放
node scripts/client-check.mjs   # 客户端 bundle 渲染：pill + 两个设置页 + 保存回传
node scripts/probe.mjs          # 假 key 真实链路探测（期待 auth-error；无密钥参与）
npm run verify                  # 上面除 probe 外全部串跑（CI 用这个）
```

零运行时依赖；宿主侧只需 Node ≥ 20 内置 fetch。目录结构：

```text
package.json        # dsh.bundle.patch + dsh.client 声明（platform: web）
cordis.patch.yml    # 宿主插件挂载行（id: dsh-zhipu-status）
lib/index.js        # 宿主：轮询 + 路由 + 缓存 + 调试日志 + 网关生命周期挂载
lib/gateway.js      # 宿主：OpenAI 兼容本地网关（链路切换 + 配置归一化/脱敏）
lib/providers.js    # provider 注册表（v2 扩展缝）
lib/client.js       # 浏览器：composer dock pill + 两个设置 section + 图标
scripts/            # build.mjs + 四个验证脚本 + probe.mjs
```

## Roadmap

- **v2: 多 provider 支持**（DeepSeek `/user/balance`、硅基流动 `/v1/user/info`、OpenRouter `/api/v1/key`；贴控制台 URL 自动按域名识别 provider）——数据源层已按 provider 注册表预留，只需新增条目。
- 网关侧：链路健康度可视化（每上游的成功率/最近错误）、按模型名分流到指定上游。
- 低余额阈值高亮的视觉打磨、到期字段适配（等智谱响应里出现明确字段）。

## 免责声明

本插件为社区项目，与 DeepSeek、智谱（Zhipu AI / Z.ai）无任何隶属或官方关系。所用内部接口非官方契约，余量数据仅供参考，不构成账单依据；接口变更导致的显示错误请先看调试日志与本 README 的「数据来源与可靠性」。请勿在公共/不受信任的网络环境下暴露 DSH 宿主端口。

## License

MIT
