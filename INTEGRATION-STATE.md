# 中性化 + key 面板 + 字体统一 + 栏目合并（tk-yxr5qr）

最后更新：2026-11-25 21:3x（本地时间）｜状态：**代码与验证完成，交付中（commit/push/profile 收尾）**

## 一、本轮改动（四改一合）

### 1. 设置面板直填 API Key（掩码存储 + 优先级链）

- 宿主新增 `$DSH_HOME/quota-pill/auth.json`：`{ apiKeyEncoded }` base64 掩码存储，无明文
- 新路由：`GET /dsh-quota-pill/key`（投影 `{hasKey, maskedHint}`）、`POST /dsh-quota-pill/key`
  （`''`=保持不变、`{clear:true}`=删除、新值=替换并立即重轮询）
- 优先级链：面板存储 > credentials.resolve > env ZHIPU_API_KEY
- 所有投影（GET /key、GET /quota、日志）只含 hasKey + 尾 4 位；全链路无明文
- 面板 UI：type=password、不回显、placeholder=`已配置(尾4位 xxxx)`、保存/清除按钮

### 2. 字体统一（去硬编码）

- 根因：状态行用 `pre`（浏览器默认 monospace）+ pill 自绘背景/行高
- 修复：全 CSS 无 `font-family`；`font: inherit` + `--dsh-content-font-size-secondary` /
  `--dsh-content-font-delta-secondary` / `--dsw-alias-*` 对齐原生 StatsPills（StatsPills.module.css 基线）
- 状态行 pre→div；字号仍由「文字大小」设置内联覆盖

### 3. 整体中性化（智谱降级为注册表第 1 条）

- 包名/cordis insert id：`dsh-zhipu-status` → `dsh-quota-pill`（目录名不变，README 有说明）
- 路由前缀 `/dsh-zhipu-status/*` → `/dsh-quota-pill/*`；数据目录 `$DSH_HOME/zhipu-status/` → `$DSH_HOME/quota-pill/`
- pill id `zhipu-quota` → `quota-pill`；owned_by/X-Title 中性化；UI 文案「智谱资源包」→「AI 额度」
- providers.js 语义：智谱条目字段（域名/端点/鉴权/包络解析）一字未动，仅架构身份改为注册表第 1 条
- 旧数据自动迁移：启动时 zhipu-status/ 文件原样复制 → 旧目录改名 `.bak-<ts>` 永久保留（绝不删除）；已有新数据则跳过

### 4. 设置栏目两栏合一

- 只注册一个 `settings.section`（id `quota-status`，label「AI 额度」，order 90）+ 一个 icon
- 内部 tab 切换「监控 / 网关」，tab 样式取自官方 settings-plugins 先例（--dsw-alias 变量，无自定义大样式）
- 默认监控 tab；localStorage 键 `dsh.quotaPill.settings.v1`（旧键兼容读取）

## 二、验证（全部全绿，npm run verify = exit 0）

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `build.mjs --smoke` | 清单/语法/5 路由/设置/栅栏/**key 链(存/投影/替换/清除/无明文/auth.json 掩码)**/注册表/包络/网关配置+脱敏+网关路由 | 26 项全绿 |
| `gateway-smoke.mjs` | /v1/models、假 key 双上游切换、归一化 502、冷却、key 不外泄、merge 保 key、applyConfig 重绑、stop 释放 | 9 项全绿 |
| `stream-check.mjs` | SSE 透传、流式前切换、JSON→SSE、tool_calls、400 不切换 | 5 项全绿 |
| `lifecycle-check.mjs` | start 绑定 → POST applyConfig 重绑 → dispose 释放；日志/投影无 key | 4 项全绿 |
| `migration-check.mjs`（新增） | 旧文件原样迁移、`.bak` 留存、GET /quota 读到旧缓存、二次启动跳过 | 4 项全绿 |
| `client-check.mjs` | 单 section 双 tab、pill 渲染、key 面板（password/掩码 placeholder/POST /key）、网关 tab 挂载与保存、渲染树无 key、**无 font-family、无 dsh-zhipu-status 字样** | 10 项全绿 |

过程中踩到的坑（已修）：路由 clear 分支先于 apiKey 必填校验；`chainEntryView` 丢 `hasKey` 导致链路 key 框永远显示未保存态（修复顺带让掩码 placeholder 真正生效）；PowerShell 5.1 无 `utf8NoBOM` 枚举 → 改用 `[IO.File]::WriteAllText` + UTF8Encoding($false)；本机 git 不在 PATH → MinGit。

## 三、收尾清单

- [x] 代码四改一合 + 全量验证绿（npm run verify = exit 0）
- [x] commit 1：a9264c7 feat: neutralize to dsh-quota-pill + panel key chain + theme font + merged tabs
- [x] INTEGRATION-STATE 提交（commit 2：822ff83）
- [x] desktop profile：`remove dsh-zhipu-status` → `add link:E:/DeepSeek/dsh-zhipu-status` → `list` 显示 `dsh-quota-pill@link:E:/DeepSeek/dsh-zhipu-status`（选了「目录不变、只改包名」路线；remove/add 一次通过，未触发目录改名备选）
- [x] push origin main（-c credential.helper=wincred；`2086f71..822ff83 main -> main`）

## 四、边界（沿用纪律）

- 没动 DSH checkout；网关路由/failover 逻辑、poller 结构未重构（只动 key 解析顺序与 UI/样式）
- 所有测试 key 均为 fake-*；真 key 不进代码/日志/报告
- 版本保持 0.1.0 不 bump
