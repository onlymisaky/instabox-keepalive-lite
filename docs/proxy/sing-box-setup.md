# sing-box 部署与使用手册

> 对应总体设计：[index.md](index.md) 阶段 1（P0 核心）
> 覆盖能力：客户端订阅接入的 VLESS-WS 节点；系统代理的备用 HTTP（10810）与 SOCKS（10808）入站——系统代理的裸 HTTP 主力由 Squid 承担（10809），见 [squid-setup.md](squid-setup.md)
> 前置条件：Debian 13 / 已装 Docker / 有 sudo
> 引入方式：Cloudflare Tunnel（阶段 3）接 VLESS-WS 入站；cpolar（阶段 4）接 HTTP/SOCKS 入站——本阶段先完成部署与本机验证

---

## 步骤总览

1. 生成认证材料（UUID、随机路径、代理账号密码）
2. 编写 sing-box 配置文件
3. Docker Compose 部署
4. 本机验证三个入站
5. 生成订阅文件（配合阶段 3）
6. 日常维护与排障

---

## 1. 生成认证材料

```bash
# 节点 UUID（vless 认证用）
docker run --rm ghcr.io/sagernet/sing-box generate uuid

# WS 路径随机串（防扫描）
openssl rand -hex 8

# HTTP/SOCKS 入站的账号密码
openssl rand -base64 12
```

把生成的值填入下文配置的 `<UUID>`、`<WS_PATH>`、`<USER>`、`<PASS>`。

## 2. 编写配置文件

创建目录并写入 `/data/home/vpn/sing-box/config.json`：

```bash
mkdir -p /data/home/vpn/sing-box
```

```json
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "remote",
        "type": "https",
        "server": "1.1.1.1",
        "detour": "direct"
      }
    ],
    "final": "remote",
    "strategy": "prefer_ipv4"
  },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-ws-in",
      "listen": "::",
      "listen_port": 443,
      "users": [
        { "uuid": "<UUID>", "flow": "" }
      ],
      "transport": {
        "type": "ws",
        "path": "/<WS_PATH>"
      }
    },
    {
      "type": "http",
      "tag": "http-in",
      "listen": "127.0.0.1",
      "listen_port": 10810,
      "users": [
        { "username": "<USER>", "password": "<PASS>" }
      ]
    },
    {
      "type": "socks",
      "tag": "socks-in",
      "listen": "127.0.0.1",
      "listen_port": 10808,
      "users": [
        { "username": "<USER>", "password": "<PASS>" }
      ]
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "rules": [
      {
        "inbounds": ["http-in", "socks-in", "vless-ws-in"],
        "action": "sniff"
      },
      {
        "protocol": "dns",
        "action": "hijack-dns"
      }
    ],
    "final": "direct"
  }
}
```

配置要点（对应设计文档阶段 1）：

| 项 | 说明 |
|---|---|
| `listen: "127.0.0.1"`（HTTP/SOCKS） | **只绑回环地址，不暴露到宿主机任何网卡**。cpolar 客户端在本机回源（`cpolar tcp 10810` 即转发到 `127.0.0.1:10810`），恰好够用；外部无法绕过 cpolar 直接访问。10809 已规划给 Squid（系统代理主力），此处用 10810 避免端口冲突 |
| VLESS `listen: "::"` | 绑全部接口，供 cloudflared 经 `localhost:443` 回源（阶段 3） |
| `dns.final: remote` | 远端 DoH 解析，防止 DNS 泄漏 |
| `action: sniff` | 嗅探流量真实域名，配合远端 DNS 保证解析正确 |
| `users` | 三个入站全部启用认证，防止公网扫描（443 经 CF 有 UUID 挡，10810/10808 由 cpolar 入口 + 认证双重防护） |

> 升级选项：把 `transport.type` 从 `ws` 换成 `httpupgrade`（客户端同步修改），隐蔽性更好，CF 兼容。

## 3. Docker Compose 部署

写入 `/data/home/vpn/sing-box/docker-compose.yml`：

```yaml
services:
  sing-box:
    image: ghcr.io/sagernet/sing-box:v1.14.4   # 固定版本：新版可能弃用旧配置格式，升级时手动改 tag 并先做配置校验
    container_name: sing-box
    restart: unless-stopped
    network_mode: host        # host 模式：直接绑宿主机回环端口，配合 cpolar 本机回源
    volumes:
      - ./config.json:/etc/sing-box/config.json:ro
    command: ["run", "-c", "/etc/sing-box/config.json"]
```

启动与检查：

```bash
cd /data/home/vpn/sing-box
docker compose up -d

# 配置校验 + 运行状态
# 注意：docker exec 不经过镜像 ENTRYPOINT，必须写全 `sing-box check`
docker compose exec sing-box sing-box check -c /etc/sing-box/config.json
docker compose logs -f --tail 50
```

## 4. 本机验证

```bash
# 1) 端口监听确认：应看到 443（::）、10808/10810（127.0.0.1）
ss -tlnp | grep -E '443|10808|10810'

# 2) HTTP 入站（本机直连测试）
curl -x http://<USER>:<PASS>@127.0.0.1:10810 https://api.ipify.org
# 返回服务器出站 IP 即成功

# 3) SOCKS 入站
curl -x socks5://<USER>:<PASS>@127.0.0.1:10808 https://api.ipify.org

# 4) VLESS+WS 入站（未接 CF 前先验证 WS 握手）
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  http://127.0.0.1:443/<WS_PATH>
# 返回 101 Switching Protocols 即成功；错误路径应返回 404
```

## 5. 生成订阅文件（配合阶段 3）

VLESS 节点分享链接格式：

```text
vless://<UUID>@sub.example.com:443?encryption=none&security=tls&sni=sub.example.com&type=ws&host=sub.example.com&path=%2F<WS_PATH>#self-node
```

生成 base64 订阅（Clash.Meta（mihomo）/V2rayN/Shadowrocket 通用；**原版 Clash 内核不支持 VLESS**）：

```bash
NODE='vless://<UUID>@sub.example.com:443?encryption=none&security=tls&sni=sub.example.com&type=ws&host=sub.example.com&path=%2F<WS_PATH>#self-node'
mkdir -p /data/home/vpn/sub
echo -n "$NODE" | base64 -w0 > /data/home/vpn/sub/<随机串>
```

- 该文件由阶段 3 的 CF Tunnel（nginx 静态托管）对外发布
- `<随机串>` 即订阅 token，用 `openssl rand -hex 16` 生成
- 若使用 cpolar 跑 VLESS（阶段 4，无域名时的订阅接入路径），另生成一条 `security=none`、地址为 cpolar 地址的链接

## 6. 日常维护

```bash
# 改配置后重启
docker compose restart

# 升级镜像（版本已固定，需手动改 compose 中的 tag，改完先执行配置校验再 up）
docker compose pull && docker compose up -d

# 查看实时连接日志
docker compose logs -f
```

### 轮换认证信息

1. 重新生成 UUID / 密码，更新 `config.json` 中对应字段
2. `docker compose restart`
3. 重新生成订阅文件并同步到所有客户端

---

## 排障速查

| 现象 | 排查 |
|---|---|
| `curl` 测试 407 | 认证错误，检查 `<USER>/<PASS>` 是否有特殊字符未转义 |
| VLESS 握手 404 | WS path 不匹配（注意 URL 编码 `%2F`）；检查 CF Tunnel 回源地址是否 `http://localhost:443` |
| 客户端能连但无法上网 | 日志看 DNS 报错；`1.1.1.1` DoH 不可达时把 `server` 换成 `8.8.8.8`，或把 `type` 从 `https` 换成 `tls` |
| 443 被占用 | `ss -tlnp | grep 443` 找出占用进程；改用 8443 后需同步修改 CF Tunnel 回源地址 |
| cpolar 隧道通了但代理 407 | cpolar 回源地址须与本机入站匹配（Squid 10809 / sing-box HTTP 10810 / SOCKS 10808），且对应账号密码正确 |
| 客户端报 time out / 连接被重置 | 经 CF 链路时检查隧道与回源（见 [cf-tunnel-setup.md](cf-tunnel-setup.md) 排障）；直连时用 tcpdump/日志确认请求是否到达本机（VLESS 本身不校验时间，无需对时） |

## 回退 / 清理

```bash
docker compose down            # 停止并移除容器（配置文件保留）
# 完全清理：删除 /data/home/vpn/sing-box/ 目录与 /data/home/vpn/sub/
```
