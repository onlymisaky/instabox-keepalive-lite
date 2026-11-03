# cpolar 内网穿透实施手册

> 对应总体设计：[index.md](index.md) 阶段 4（P3）
> 覆盖能力：无域名场景的兜底公网入口——系统代理接入（设备自带"网络代理"功能直接填 HTTP 代理，客户端零安装）+ 订阅接入（第 6 节 VLESS-WS 节点）
> 前置条件：[squid-setup.md](squid-setup.md) 已完成（Squid HTTP 10809 已绑 `127.0.0.1`、启用认证并验证通过）；或 [sing-box-setup.md](sing-box-setup.md) 已完成（备用 HTTP 10810 / SOCKS 10808）。**注意：Squid 基础配置默认关闭认证，而走 cpolar 公网入口必须启用认证——若尚未开启，先回 [squid-setup.md](squid-setup.md) 步骤 2/3 启用，否则隧道一旦泄露即等于开放代理**
> 定位：**cpolar 的主要目的是兜底"没有域名"的场景**——没有域名时，用它同时提供订阅接入（第 6 节 VLESS-WS 节点）和系统代理公网入口（CF Tunnel 无法透传 HTTP `CONNECT`，TCP 隧道是唯一路径）。自己的设备优先走 Tailscale 内网入口（[tailscale-setup.md](tailscale-setup.md)）；有域名时主力流量走 CF Tunnel（[cf-tunnel-setup.md](cf-tunnel-setup.md)），cpolar 仅作无法组网设备/无域名场景的兜底

---

## 步骤总览

1. 注册账号并安装 cpolar
2. 配置 authtoken
3. 建立 TCP 隧道（HTTP 代理 + SOCKS）
4. 固化隧道为 systemd 常驻
5. 设备端配置与验证
6. cpolar 跑 VLESS-WS 节点（无域名时的订阅接入路径）

> 回源目标说明：HTTP 代理隧道默认指向 **Squid 10809**（系统代理主力，见 [squid-setup.md](squid-setup.md)）；尚未部署 Squid 时可临时指向 sing-box 备用 HTTP 入站 **10810**。SOCKS 隧道指向 sing-box **10808**。

---

## 1. 注册账号并安装

1. 注册 https://www.cpolar.com （免费版足够验证；固定 TCP 端口需付费套餐）。
2. 服务器上安装（以官方脚本为准，参考官网 Linux 安装页）：

```bash
curl -L https://www.cpolar.com/static/downloads/install-release-cpolar.sh | sudo bash
cpolar version
```

## 2. 配置 authtoken

注册后在官网后台"验证"页复制 authtoken：

```bash
cpolar authtoken <你的authtoken>
```

## 3. 建立 TCP 隧道

### 快速验证（前台命令，地址随机）

```bash
cpolar tcp 10809    # HTTP 代理入口
# 另开终端
cpolar tcp 10808    # SOCKS 入口（可选）
```

命令输出中会给出公网入口，形如 `tcp.cpolar.top:3xxxx`。此地址**每次重启都会变化**。

### 固化到配置文件（推荐）

编辑 `/usr/local/etc/cpolar/cpolar.yml`，在 authtoken 之下追加命名隧道：

```yaml
authtoken: <你的authtoken>
tunnels:
  http-proxy:          # Squid 裸 HTTP 代理（未部署 Squid 时改为 127.0.0.1:10810 走 sing-box）
    proto: tcp
    addr: 127.0.0.1:10809
  socks-proxy:         # sing-box SOCKS5
    proto: tcp
    addr: 127.0.0.1:10808
  vless-ws:            # 无域名时的订阅接入路径，见第 6 节
    proto: tcp
    addr: 127.0.0.1:443
```

## 4. 注册 systemd 常驻

```bash
sudo systemctl enable --now cpolar
sudo systemctl status cpolar
```

常驻后隧道管理走 Web UI：`http://<服务器IP>:9200`（在线隧道状态、查看当前公网地址；付费套餐可在后台把隧道升级为固定 TCP 端口，地址即不再漂移）。

## 5. 设备端配置与验证

在任意设备的系统设置 → 网络 → 代理中填写：

```
协议: HTTP
服务器: tcp.cpolar.top
端口:   <隧道映射端口>
账号:   <代理账号>      # Squid 的 myuser（未部署 Squid 时用 sing-box http-in 的 <USER>）
密码:   <代理密码>
```

验证：

```bash
# 任意能联网的设备/电脑上
curl -x http://<代理账号>:<代理密码>@tcp.cpolar.top:<端口> https://api.ipify.org
# 返回服务器出站 IP 即全链路（设备→cpolar→隧道→Squid/sing-box→出站）打通
```

行为说明：

- 支持 `CONNECT`，浏览器/系统代理正常走 HTTPS
- 只代理"遵守系统代理设置"的应用（浏览器、大部分 App）；P2P、部分游戏不走系统代理——这是系统代理机制的固有限制
- 免费版带宽 ~1Mbps：网页/IM 够用，大流量场景优先 Tailscale 内网入口或 Exit Node

## 6. cpolar 跑 VLESS-WS 节点（无域名时的订阅接入路径）

cpolar TCP 隧道可直接透传 443 的 VLESS-WS 入站：**没有域名/不想买域名时，这是实现客户端订阅接入（Clash 订阅）的路径**；有域名走 CF Tunnel（[cf-tunnel-setup.md](cf-tunnel-setup.md)）时，也可作为其故障期间的临时节点：

1. 启用 `cpolar.yml` 中的 `vless-ws` 隧道，得到 `tcp.cpolar.top:3xxxx`。
2. 客户端手动添加节点：

| 参数 | 值 |
|---|---|
| 地址 / 端口 | `tcp.cpolar.top` / `<映射端口>` |
| UUID / 传输 / path | 同 CF 链路（`<UUID>` / ws / `/<WS_PATH>`） |
| TLS | **关闭**（`security: none`，cpolar 边缘无 TLS 终止） |

3. 注意：无 TLS 时隐蔽性下降、全靠 UUID 挡扫描；且 cpolar 平台可见流量内容特征。适合无域名的轻量自用；预算允许时升级到 CF Tunnel（域名 ~¥30/年）可获得 TLS 隐蔽性与固定地址。

---

## 限制与付费说明

| 项 | 免费版 | 付费版 |
|---|---|---|
| 公网地址 | 每次重启**随机变化** | 固定 TCP 端口（后台绑定隧道） |
| 带宽 | ~1Mbps | 按套餐 |
| 隧道数 | 有限制（以官网为准） | 更多 |

> 地址漂移的影响：系统代理的设备端配置、VLESS 节点地址都需要跟着改。无域名场景下这是固有代价（可付费固定端口）；有域名场景主力流量建议走 CF Tunnel（域名固定）。

## 排障速查

| 现象 | 排查 |
|---|---|
| 隧道建立失败 | `cpolar authtoken` 是否配置；`journalctl -u cpolar -f` 看报错 |
| 代理 407 | 回源地址与端口匹配（Squid 10809 / sing-box 10810），且对应账号密码正确 |
| 能连上但很慢 | 免费版限速属预期；重流量切 CF 链路 |
| 重启后设备连不上 | 免费版地址漂移，Web UI（:9200）查看新地址并更新设备配置 |

## 回退 / 清理

```bash
sudo systemctl disable --now cpolar
sudo /usr/local/bin/cpolar/cpolar-uninstall.sh   # 或按官网卸载说明
```
