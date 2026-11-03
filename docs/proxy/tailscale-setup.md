# Tailscale 组网实施步骤

> 对应总体设计：[index.md](index.md) 阶段 2（P1）
> 覆盖能力：Tailscale 私有组网 / Exit Node；同时提供系统代理接入的内网入口（设备把系统代理指向服务器 tailnet IP）
> 前置条件：服务器出站网络正常、有 sudo、`/dev/net/tun` 可用（已确认）；系统代理内网方式需先完成 [squid-setup.md](squid-setup.md)

---

## 步骤总览

1. 安装 Tailscale（服务器端）
2. 登录并启动（获取 tailnet IP）
3. 管理后台开启所需功能（MagicDNS / Exit Node 审批 / 关闭 Key expiry）
4. 安装 Tailscale（设备端）并验证
5. 设备侧使用代理（两种方式）
6. 关于自建 DERP（本方案下不可行，仅作说明）

---

## 1. 服务器端安装

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

验证安装：

```bash
tailscale version
```

## 2. 启动并登录

```bash
sudo tailscale up --advertise-exit-node
```

- 命令会输出一个登录 URL，在浏览器打开并用 Google/GitHub/微软等账号登录（免费个人版够用，最多 100 台设备、3 个用户）
- `--advertise-exit-node`：把本机声明为 Exit Node，供其他设备全流量接管

登录成功后确认状态：

```bash
tailscale status        # 查看本机 tailnet IP（100.x.y.z）与在线设备
tailscale ip -4         # 单独打印本机 IPv4
```

设置开机自启（安装脚本默认已启用 tailscaled，确认即可）：

```bash
sudo systemctl enable --now tailscaled
```

## 3. 管理后台配置

登录 https://login.tailscale.com 后进入管理控制台：

| 操作 | 位置 | 作用 |
|------|------|------|
| 批准 Exit Node | Machines → 本服务器 → Edit route settings → 勾选 "Use as exit node" | 允许其他设备把本机当出口 |
| 开启 MagicDNS | DNS 页 → Enable MagicDNS | 设备间可用主机名互访，不依赖 100.x IP 记忆 |
| 关闭 Key expiry | Machines → 本服务器 → Disable key expiry | 服务器密钥不过期，避免失效后断网 |

## 4. 设备端安装与加入

各平台客户端：https://tailscale.com/download

| 平台 | 方式 |
|------|------|
| Windows / macOS | 官方客户端安装包，登录同一账号 |
| iOS / Android | 应用商店搜 Tailscale，登录同一账号 |
| Linux 设备 | `curl -fsSL https://tailscale.com/install.sh \| sh && sudo tailscale up` |

设备加入后，在服务器上 `tailscale status` 应能看到新设备。

## 5. 设备侧使用代理（两种方式）

### 方式 A：Exit Node 全局接管（推荐，无需配代理）

设备客户端里：菜单 → Use Exit Node → 选择本服务器。

- 全部流量自动经服务器出站，无需在系统里配置任何代理
- 手机开启后相当于"回家组网 + 全局代理"二合一

### 方式 B：系统自带 HTTP 代理（系统代理接入的内网入口）

前提：服务器上已部署 Squid（[squid-setup.md](squid-setup.md)，按其"Tailscale 暴露方案"在 squid.conf 中追加绑定 tailnet IP）。sing-box 的备用 HTTP 入站（10810）默认仅绑定 `127.0.0.1`，tailnet 设备无法直接访问，如需改用须自行将其 `listen` 改绑 tailnet IP，一般不建议。

设备连接 tailnet 后，在系统"网络代理"设置中填：

```
协议: HTTP
服务器: 100.x.y.z        # 服务器的 tailnet IP（或 MagicDNS 主机名）
端口:   10809            # Squid（主力）
账号:   myuser           # Squid 启用认证时填写，免认证留空
密码:   ********
```

- 该方式只代理"支持系统代理的应用"，不走系统代理的流量（如部分游戏、P2P）不生效——这正是方式 A 存在的意义
- 两者可并存：日常用方式 A，需要精细分流时切方式 B

## 6. 验证清单

服务器端：

```bash
tailscale status                 # 设备全部在线
tailscale ping <设备IP>          # 打洞成功显示 "via XXX"，若显示 "via DERP" 说明走了中继（可用但降速）
```

设备端：

```bash
# 方式 A 验证：浏览器访问 ip 查询站，显示的应为服务器出站 IP（与本机直连 `curl https://api.ipify.org` 的结果一致；出站经 NAT 时此 IP 可能变化）
# 方式 B 验证：
curl -x http://100.x.y.z:10809 https://api.ipify.org   # 返回服务器出站 IP 即成功（启用认证时加 -x http://myuser:密码@...）
```

## 7.（可选）自建 DERP 改善中继降速

打洞失败时流量走官方 DERP（多数在海外），可自建 derper 中继改善。但**本方案下不可行**：

- DERP 依赖非标准的 `Upgrade: DERP` 连接升级，Cloudflare Tunnel 只支持 WebSocket 升级，**无法承载 DERP 流量**（CF Tunnel 的能力边界见 [cf-tunnel-setup.md](cf-tunnel-setup.md)）
- 本服务器无公网 IP，自建 DERP 需要一个客户端可直连的 TCP+TLS 入口；cpolar 免费版（限速、地址漂移）也不适合承载中继流量

结论：当前条件下保持官方 DERP（可用但降速）；若未来获得带公网 IP 的入口（如 VPS），再部署 derper 并在管理后台 ACL 的 `derpMap` 中注册自建节点。

---

## 回退 / 清理

```bash
sudo tailscale down                # 停止（保留配置）
sudo tailscale logout              # 退出登录
sudo apt remove tailscale          # 完全卸载
```
