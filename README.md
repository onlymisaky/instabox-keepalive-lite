# instabox-keepalive-lite

[InstaBox](https://instabox.sh) 沙盒保活工具：通过定时续租「活动租约」（activity lease），防止沙盒因空闲被自动暂停；发现沙盒已暂停/已停止时，自动唤醒或启动并完成首次续租。

零依赖（Node.js ≥ 18 内置能力即可运行）。只需配置 GitHub Actions 即可完成保活：

- **GitHub Actions（必需）**：公开仓库的定时工作流，每 10 分钟续租一次，标准 runner 免费不限时长；
- **本机手动（可选）**：在 GitHub 失效（工作流被禁用、延迟过大等）或发现机器已被关闭时，随时手动执行一次 `instabox` 立即续租或拉起机器。不是必需配置。

> 设计原则：保活逻辑全部放在机器**外部**。沙盒被暂停时内部进程一并冻结，机内脚本无法叫醒自己；外部调用方是唯一能跨越「暂停/冷却」边界的执行者。机器内部不安装任何东西。

## 背景：InstaBox 的空闲暂停机制

InstaBox 沙盒在无活动时会自动暂停（免费套餐固定 30 分钟）。「活动租约」是平台提供的官方续命机制：持有有效租约的机器不计空闲。一次续租最长覆盖 **3600 秒**，因此每 10 分钟续租一次即可稳定覆盖。

| 平台限制 | 本工具能否解决 | 说明 |
|---|---|---|
| 空闲 30 分钟自动暂停 | ✅ 彻底防住 | 每 10 分钟续租 60 分钟租约 |
| 单次运行 480 分钟上限（免费套餐） | ⚠️ 部分缓解 | 到点必暂停；冷却结束后自动唤醒。每 8 小时约有 15–30 分钟断档（5–20 分钟强制冷却 + 最多 10 分钟等待） |
| 当月免费时长耗尽（`credit_exhausted`） | ❌ 无法解决 | 脚本会失败、Actions 运行标红，需等下月或升级套餐 |

即本工具的准确承诺是：**「空闲永不暂停 + 每次运行上限后自动恢复」**，而非无断档 7×24。断档来自平台策略，不是本工具的缺陷。

## 工作原理

```
GitHub Actions (cron */10)
        │
        ▼
GET /v1/machines/{id}   查询状态
        │
┌───────┼──────────────────┐
▼       ▼                  ▼
running  suspended       stopped
│        │                │
│   冷却中？──否──► wake   start
▼        │                │
续租 3600s 跳过（exit 0）  │
│        └────────┬───────┘
└─────────────────┤
                  ▼
     轮询至 running → 续租 3600s
```

保活调用是幂等的：无论定时触发还是手动执行，续租只是延长租约，多次调用互不冲突、不会叠加副作用。

## 准备工作

1. **创建 API Key**：在 [Dashboard → API keys](https://dashboard.instabox.sh/dashboard/api-keys) 创建，权限至少要勾选 `machines:read` + `machines:write` 这两项。如需两个执行方（GitHub + 本机），建议创建两个 key（如 `gha-keepalive` 与 `mac-manual`），可单独吊销互不影响。
2. **记下机器 ID**：`m_` 开头的 26 位小写 base32 串（沙盒 HOME 目录下 `MACHINE.md` 中有）。

## GitHub Actions 配置（必需）

> **必须使用公开仓库**：GitHub 按分钟向上取整计费，`*/10` 定时任务一个月约 4320 分钟，私有仓库会超出 Free 计划 2000 分钟/月的额度；公开仓库的标准 runner 免费且不限时长。Key 放在 Secrets 中不会暴露，日志自动脱敏。

1. 将本仓库推送到 GitHub **公开仓库**（工作流必须在默认分支上）。
2. 仓库 `Settings → Secrets and variables → Actions` 添加：
   - `INSTABOX_API_KEY` = `ibk_...`
   - `INSTABOX_MACHINE_ID` = `m_...`
3. （可选）**失败邮件提醒**：[github.com/settings/notifications](https://github.com/settings/notifications) → Actions 勾选「失败运行的通知」。不开也不会影响保活，只是脚本失败（如额度耗尽）时你不会第一时间知道。
4. 手动触发一次验证：`Actions → instabox-keepalive → Run workflow`，日志中应出现 `lease_ok` 事件及未来的 `expiresAt`。

### 已知注意事项

- **60 天不活跃自动禁用**：公开仓库连续 60 天无活动，定时工作流会被 GitHub 自动停用。每隔一两个月手动 `Run workflow` 一次（或随便提交一次）即可保持活跃。
- **cron 有延迟**：GitHub 的 `schedule` 高峰期会延迟 5–15 分钟，本方案以 60 分钟租约、10 分钟间隔留足了容错。
- **定时任务只在默认分支生效**；若开启了失败通知，邮件发给最后修改 cron 行的账号。

## 可选：本机手动触发（macOS / Linux / Windows）

> 本节**不是必需配置**。仅完成上面的 GitHub Actions 配置即可正常保活。本机命令的用途：
> 1. GitHub Actions 失效或长时间延迟时，随时手动触发一次保活兜底；
> 2. 发现机器被关闭时，一条命令直接拉起。

脚本本体是零依赖 Node.js，三个系统安装方式完全一致（Windows 上 `npm link` 会额外生成 `insta-box.cmd` / `insta-box.ps1` shim，PowerShell 与 CMD 中可直接敲 `insta-box`）：

```bash
git clone https://github.com/<你>/instabox-keepalive-lite
cd instabox-keepalive-lite
npm link       # 通过 package.json 的 bin 字段注册全局命令 insta-box
```

凭据：脚本正常运行需要拿到**两个值**——API Key（`ibk_...`）和机器 ID（`m_...`）。三种方式任选其一（优先级：启动参数 > 环境变量 > 源码常量）：

### 方式 1：启动参数（临时用一次）

```bash
insta-box keepalive --api-key ibk_xxx --machine-id m_xxx
```

参数会留在 shell 历史记录里，仅建议临时使用。

### 方式 2：环境变量（推荐）

把这两个值写入环境变量后，直接敲 `insta-box` 即可：

```bash
# macOS / Linux（想永久生效，把 export 两行加进 ~/.zshrc 或 ~/.bashrc）
export INSTABOX_API_KEY=ibk_xxx
export INSTABOX_MACHINE_ID=m_xxx
```

```powershell
# Windows（写入用户环境变量，重开终端生效）
setx INSTABOX_API_KEY "ibk_xxx"
setx INSTABOX_MACHINE_ID "m_xxx"
```

### 方式 3：写进源码常量

编辑 [src/config.mjs](src/config.mjs) 顶部的两个常量，保存即生效：

```js
const FALLBACK_API_KEY = "ibk_xxx";
const FALLBACK_MACHINE_ID = "m_xxx";
```

> 注意：公开仓库**不要**用方式 3，key 会随代码一起公开。

### 使用

```bash
insta-box              # 续租一次；发现已暂停则 wake、已停止则 start，然后轮询到 running 并续租
insta-box status       # 只读查看：state、冷却剩余秒数、空闲阈值
insta-box on           # 与 keepalive 等价，语义上强调"把机器拉起来"
```

「发现服务器被关了，从本机直接启动」就是 `insta-box` 一条命令——全程约 10–60 秒。

## 各状态下的行为

| 机器状态 | 动作 | 退出码 |
|---|---|---|
| `running` | 续租活动租约 | `0` |
| `suspended` + 冷却中 | 不做任何写操作（此时唤醒必被 `409 machine_cooldown` 拒绝） | `0`（良性跳过，不告警） |
| `suspended` + 冷却结束 | `POST /wake` → 轮询至 running → 续租 | `0` |
| `stopped` | `POST /start` → 轮询至 running → 续租 | `0` |
| 过渡态（`starting`/`resuming`/…） | 跳过，等下一轮 | `0` |
| `402 credit_exhausted` 等确定性失败 | 无动作 | `1`（Actions 运行标红；如已开启失败通知会收到邮件） |
| 网络错误 / 429 / 5xx | 退避重试 3 次（尊重 `Retry-After`） | 仍失败则 `1` |
| 配置缺失 / 参数错误 | — | `2` |

退出码约定：**正常现象（冷却期、过渡态）按 0 退出，只有确定性失败才返回 1**。若你开启了 GitHub 失败通知，告警只会来自真正需要人工介入的问题，不会被冷却期这类正常现象轰炸。

## 配置项

全部通过环境变量提供：

| 变量 | 必填 | 说明 |
|---|---|---|
| `INSTABOX_API_KEY` | ✅ | API Key（`ibk_...`），scope：`machines:read` + `machines:write` |
| `INSTABOX_MACHINE_ID` | ✅ | 机器 ID（`m_` + 26 位小写 base32） |
| `INSTABOX_API_BASE` | 否 | API 根地址，默认 `https://api.instabox.sh` |
| `INSTABOX_LOG` | 否 | 日志格式：`json` 单行 JSON（CI 默认）/ `text` 人类可读（终端默认），不设则自动判断 |
