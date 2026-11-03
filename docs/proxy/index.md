# 自建代理服务总体方案（无公网 IP 服务器）

> 目标服务器：Debian 13 (trixie) / x86_64 / 4C 8G / KVM 虚拟机
> 现状：出站网络正常、端口监听绑定正常、有 sudo、已装 Docker、`/dev/net/tun` 可用
> 唯一限制：**无公网 IP**（出站经 NAT，入站不可达）

---

## 一、需求与背景

当前有一台无公网 IP 的服务器，希望在其上部署代理服务，实现以下三项能力：

| # | 目标能力 | 关键约束 | 实现组件 |
|---|----------|----------|----------|
| 1 | **客户端订阅接入**：Clash 等代理客户端可直接订阅节点 | 需要公网可访问的订阅 URL + 节点入口 | **sing-box** +（有域名：**Cloudflare Tunnel**，TLS 加密、稳定；无域名：**cpolar** TCP 透传 VLESS-WS，零成本即用，无 TLS、免费版地址漂移） |
| 2 | **系统代理接入**：设备自带"网络代理"功能直接填 HTTP 代理 | 需要裸 TCP 可达（HTTP CONNECT），客户端不装任何软件 | **sing-box + Squid**，公网入口走 **cpolar**，内网入口走 Tailscale |
| 3 | **私有组网**：自己的设备加入 tailnet，互通 + Exit Node | — | **Tailscale** |

核心矛盾：无公网 IP → 订阅接入与系统代理的公网入口都必须借道第三方把流量"引入"本机；本机所有组件（sing-box、Squid、cloudflared、cpolar）均只发起**主动出站连接**（Tailscale 同理，靠 WireGuard 打洞/中继）。

---

## 二、两种"流量引入"方案对比

| 维度 | A. Cloudflare Tunnel + 托管域名 | B. cpolar 内网穿透 |
|------|-------------------------------|--------------------|
| 费用 | 域名 ~¥30/年 + CF 免费 | 免费版可用；固定 TCP 端口需付费 |
| 客户端订阅接入（Clash 订阅） | ✅ VLESS + WS + TLS 经 CF，完美支持，主流方案 | ✅ TCP 隧道透传 VLESS-WS（`security: none`，隐蔽性与 TLS 版有差距，免费版地址漂移） |
| 系统代理接入（裸 HTTP 代理） | ❌ **不支持**。CF Tunnel 只转发 HTTP 服务，无法透传 `CONNECT` 方法 | ✅ TCP 隧道透传 HTTP/SOCKS 代理端口 |
| 速度 | 经 CF 边缘节点，回源线路决定延迟 | 免费版 ~1Mbps 且地址漂移；付费版固定端口 |
| 稳定性 | 高，CF 免费、无用量限制 | 一般，依赖第三方平台 |
| 隐蔽性 | TLS 加密、伪装成正常 HTTPS 流量 | 平台可见全部流量（未加密透传） |
| 维护成本 | 低（cloudflared 单进程出站） | 极低（一条命令建隧道） |

### 结论

- **订阅接入的两条路径**：有域名 → Cloudflare Tunnel，`客户端 → CF 边缘(TLS) → cloudflared → 本机 VLESS-WS`，质量好、隐蔽性高；无域名/不想买域名 → cpolar TCP 隧道透传 VLESS-WS（无 TLS），注册即用、零额外成本，代价是隐蔽性下降和免费版地址漂移。
- **系统代理接入的公网入口 → cpolar**：CF Tunnel 不支持 `CONNECT`，cpolar TCP 隧道是无需 VPS、无需域名、客户端零安装的唯一路径；内网入口则由 Tailscale 覆盖（免公网、端到端加密，自己的设备优先用）。
- cpolar 与 CF 不冲突：有域名且追求质量用 CF（订阅接入），无域名或需要"设备自带代理"入口时用 cpolar；二者也可同时部署。

---

## 三、总体架构

```
   Clash 客户端 ──► CF 边缘 (wss/TLS) ──► cloudflared ══出站隧道══┐
   （订阅接入：vless-ws-tls + 订阅）                              │
                                                                ▼
   任意设备 ──► tcp.cpolar.top:xxxxx ══TCP 隧道═══►┌────────────────────────────┐
   （系统代理公网入口：裸 HTTP 代理）               │   本服务器（无公网 IP）      │
                                                │   sing-box (Docker)        │
   自己的设备 ══ WireGuard 打洞/中继 ═══════════► │   ├─ VLESS+WS     443     ◄┼── cloudflared 回源
   （私有组网：Tailscale / Exit Node）            │   ├─ HTTP(备用)  10810    ◄┼── cpolar tcp（可选）
                                                │   └─ SOCKS5      10808    ◄┼── cpolar tcp
                                                │   Squid：HTTP    10809    ◄┼── cpolar tcp / tailnet
                                                │   nginx 静态订阅  8081     ◄┼── cloudflared 回源
                                                └────────────────────────────┘
```

关键点：

- cloudflared / cpolar / tailscaled 全部是**本机主动出站连接**，绕过无公网 IP 的限制。
- 对外的入站（HTTP 10809、备用 HTTP 10810、SOCKS 10808）只绑 `127.0.0.1`（或 Tailscale 网卡），cpolar 客户端在本机回源可达，**不暴露到宿主机其他接口**；tailnet 内访问走 Tailscale 网卡绑定。
- VLESS+WS 绑 `:::443`，供 cloudflared 经 `localhost:443` 回源。

---

## 四、技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 代理核心（订阅接入） | **sing-box**（Docker 部署） | 单二进制提供 VLESS-WS 节点 + SOCKS 调试入站 + HTTP 备用入站，配置统一，Clash 兼容性好 |
| 系统代理 HTTP 服务 | **Squid**（系统服务） | 专职正向代理：CONNECT 完整支持、哈希密码文件、ACL 精细控制、logrotate 开箱即用，比 sing-box 的 HTTP 入站更专业 |
| CF 隧道 | cloudflared | 官方工具，出站连接，免费 |
| 内网穿透 | cpolar（TCP 隧道） | 补齐 CF 无法透传裸 TCP 的缺口 |
| 组网 | Tailscale | WireGuard 端到端加密、打洞直连、免费额度够用，兼作系统代理的内网入口与 Exit Node |
| 订阅 | nginx 静态托管 base64 订阅（经同一条 CF Tunnel 发布） | 先简单，之后人多再上 Sub-Store/Marzban |

> 选型说明：
> - 为什么不用 squid 等传统正向代理做核心——它无法实现订阅接入所需的 VLESS 协议；sing-box 一个进程覆盖节点 + SOCKS + 备用 HTTP。
> - 系统代理为什么主推 Squid——sing-box 的 HTTP 入站可用但非主打（认证明文写配置、无 ACL）；Squid 专职正向代理 20+ 年成熟度，二者并存、端口错开（Squid 10809 主力，sing-box 10810 备用），不冲突。

---

## 五、端口与组件规划

| 端口 | 组件 | 绑定 | 用途 | 接入方 |
|------|------|------|------|--------|
| 443 | sing-box VLESS+WS | `::` | 订阅接入节点 | cloudflared 回源（无域名时经 cpolar 透传） |
| 10809 | **Squid HTTP 代理** | `127.0.0.1`（Tailscale 暴露时加绑 tailnet IP） | 系统代理主力 | cpolar TCP 隧道 / tailnet 设备 |
| 10810 | sing-box HTTP 代理（备用） | `127.0.0.1` | 系统代理备用 | cpolar TCP 隧道（可选） |
| 10808 | sing-box SOCKS5 | `127.0.0.1` | 调试/备用 | cpolar TCP 隧道 |
| 8081 | nginx 静态订阅 | `127.0.0.1` | 订阅接入分发 | cloudflared 回源 |
| 9200 | cpolar Web UI | 所有网卡（建议防火墙/ACL 限制来源） | 隧道管理 | 本机/管理网段（浏览器访问 `http://<服务器IP>:9200`） |

走 cpolar 公网入口的入站**必须启用认证**（Tailscale 内网入口可选，见各子文档）；DNS 远端解析防泄漏。

---

## 六、分阶段实施

### 阶段 1（P0）：sing-box 核心——订阅接入与系统代理共用的本地代理引擎

Docker Compose 部署 VLESS-WS（443）+ SOCKS（10808）+ HTTP 备用（10810），本机验证。详见 **[sing-box-setup.md](sing-box-setup.md)**。

### 阶段 2（P1）：Tailscale 私有组网（兼作系统代理的内网入口）

服务器与自己的设备加入同一 tailnet；设备可用 Exit Node 全局接管，或（在完成阶段 4 后）把系统代理指向服务器的 tailnet IP:10809（Squid）。组网本身与阶段 3/4 无依赖，可随时做。详见 **[tailscale-setup.md](tailscale-setup.md)**。

### 阶段 3（P2）：Cloudflare Tunnel（订阅接入的有域名公网入口）

1. 域名 NS 托管到 Cloudflare（免费版即可）。
2. 服务器上 `cloudflared tunnel login / create / route dns`，配置 `config.yml`：
   - `sub.example.com` → `http://localhost:443`（VLESS-WS 入站，CF 边缘终止 TLS）
   - `sub.example.com/sub/<随机串>` → `http://localhost:8081`（nginx 静态订阅）
3. Clash/Shadowrocket/V2rayN 导入订阅 URL 即用。

详见 **[cf-tunnel-setup.md](cf-tunnel-setup.md)**。

### 阶段 4（P3）：Squid + cpolar（系统代理的公网入口；无域名时订阅接入也由 cpolar 承载）

1. 部署 Squid（`127.0.0.1:10809`，启用认证）。
2. 注册 cpolar 账号，安装客户端并配置 authtoken。
3. 建 TCP 隧道：`127.0.0.1:10809`（HTTP 代理）与 `127.0.0.1:10808`（SOCKS）。
4. 任意设备在系统"网络代理"里填 `tcp.cpolar.top:<端口>` + 代理账号密码。

详见 **[squid-setup.md](squid-setup.md)** 与 **[cpolar-setup.md](cpolar-setup.md)**。

---

## 七、方案落地优先级

| 优先级 | 动作 | 覆盖能力 | 前置条件 | 文档 |
|--------|------|----------|----------|------|
| P0 | sing-box 三入站部署 + 本机验证 | 订阅接入 / 系统代理基础 | 无 | [sing-box-setup.md](sing-box-setup.md) |
| P1 | Tailscale 组网 + 设备接入 | 私有组网（兼系统代理内网入口） | 注册 Tailscale 账号 | [tailscale-setup.md](tailscale-setup.md) |
| P2 | 域名托管 CF + cloudflared + VLESS-WS-TLS + 订阅发布 | 订阅接入（有域名路径） | 一个域名（~¥30/年）；无域名可跳过，用 P3 的 cpolar 承载订阅接入 | [cf-tunnel-setup.md](cf-tunnel-setup.md) |
| P3 | Squid 部署 + cpolar TCP 隧道 | 系统代理（公网兜底）；无域名时兼作订阅接入 | 注册 cpolar 账号（固定端口需付费） | [squid-setup.md](squid-setup.md)、[cpolar-setup.md](cpolar-setup.md) |

---

## 八、风险与注意事项

- **合规**：自建代理仅限自用/授权范围，勿对外提供服务、勿用于绕过审计。
- **DNS 泄漏**：sing-box 启用远端 DoH 解析；设备端注意浏览器/WebRTC 泄漏。
- **订阅安全**：订阅 URL 带长随机路径/token；节点 UUID 定期轮换。
- **cpolar 免费版限制**：地址每次重启漂移（代理配置要跟着改）、带宽 ~1Mbps、平台可见流量——只适合轻量与临时使用，重流量走 CF Tunnel（订阅接入）或 Tailscale（系统代理内网）。
- **cpolar 信任边界**：TCP 透传未加密部分对平台可见，走 cpolar 的代理入口必须启用认证，敏感场景优先走 Tailscale/CF 链路。
- **Tailscale**：服务器关闭 key expiry 防止密钥过期断网；打洞失败走官方 DERP 会降速，必要时自建中继。
- **资源**：Docker + sing-box + cloudflared + cpolar + nginx + squid 总占用 < 1G，无压力。

---

## 附：文档索引

| 文档 | 内容 |
|------|------|
| index.md（本文） | 需求背景、架构、选型与实施路线 |
| [sing-box-setup.md](sing-box-setup.md) | 阶段 1：核心代理引擎部署与验证（订阅接入节点 + 系统代理备用入站） |
| [tailscale-setup.md](tailscale-setup.md) | 阶段 2：Tailscale 私有组网（兼系统代理内网入口） |
| [cf-tunnel-setup.md](cf-tunnel-setup.md) | 阶段 3：Cloudflare Tunnel 订阅接入入口（有域名路径） |
| [squid-setup.md](squid-setup.md) | 阶段 4a：Squid 裸 HTTP 代理（系统代理主力实现） |
| [cpolar-setup.md](cpolar-setup.md) | 阶段 4b：cpolar 内网穿透（系统代理公网入口；无域名时的订阅接入路径） |
