# Cloudflare Tunnel 公网入口实施手册

> 对应总体设计：[index.md](index.md) 阶段 3（P2）
> 覆盖能力：客户端订阅接入（Clash 等客户端直接订阅）
> 前置条件：[sing-box-setup.md](sing-box-setup.md) 已完成（VLESS-WS 入站 443 + 订阅文件已生成）；一个域名（~¥30/年）。无域名/不想买域名时，订阅接入改由 cpolar 承载，见 [cpolar-setup.md](cpolar-setup.md) 第 6 节

---

## 步骤总览

1. 域名 NS 托管到 Cloudflare
2. 安装 cloudflared 并创建隧道
3. 配置 ingress 规则（节点 + 订阅两条路由）
4. 安装 nginx 托管订阅文件
5. 注册 systemd 服务并验证
6. 客户端导入订阅

---

## 1. 域名托管到 Cloudflare

1. 注册/登录 https://dash.cloudflare.com （免费版即可）。
2. Add a site → 输入域名 → 选择 Free 计划。
3. 到域名注册商处把 NS 记录改为 CF 分配的两个 NS，等待生效（几分钟到几小时）。

> 域名购买推荐：Cloudflare Registrar（成本价）或任意注册商；只要 NS 能改即可。

## 2. 安装 cloudflared 并创建隧道

```bash
# 安装（Debian/Ubuntu）
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version

# 登录（会给出一个 URL，浏览器授权你的域名）
cloudflared tunnel login

# 创建隧道（生成凭证文件 ~/.cloudflared/<TUNNEL_ID>.json）
cloudflared tunnel create proxy

# 把域名指向隧道（自动创建 CNAME 记录）
cloudflared tunnel route dns proxy sub.example.com
```

## 3. 配置 ingress 规则

写入 `/etc/cloudflared/config.yml`：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json   # 以 login 输出的实际路径为准

ingress:
  # 规则1：订阅文件 → 本地 nginx（带 path 的规则必须放在前面）
  - hostname: sub.example.com
    path: ^/sub/.*
    service: http://localhost:8081
  # 规则2：VLESS-WS 节点流量 → sing-box
  - hostname: sub.example.com
    service: http://localhost:443
  # 兜底（必须）
  - service: http_status:404
```

> 注意 ingress 按顺序匹配：不带 `path` 的 hostname 规则会命中该域名的**所有**请求，因此 `path` 规则必须放在同 hostname 的通配规则**之前**（上面顺序已正确，`/sub/` 命中规则1，其余命中规则2）。

校验配置并测试连通：

```bash
cloudflared tunnel ingress validate
cloudflared tunnel run proxy     # 前台跑一次，看到 "Registered tunnel connection" 即成功，Ctrl+C 后转 systemd
```

## 4. nginx 托管订阅文件

```bash
sudo apt install -y nginx
```

写入 `/etc/nginx/sites-available/sub`：

```nginx
server {
    listen 8081;
    server_name _;

    # 只暴露订阅目录；deny all 兜底防目录遍历
    location /sub/ {
        alias /data/home/vpn/sub/;
        default_type text/plain;
        add_header Cache-Control "no-store";
    }
    location / { return 404; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sub /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 5. 注册 systemd 服务并验证

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

端到端验证：

```bash
# 1) 订阅可访问（应输出 base64 字符串）
curl -s https://sub.example.com/sub/<随机串>

# 2) 错误路径返回 404（订阅不被枚举）
curl -s -o /dev/null -w "%{http_code}\n" https://sub.example.com/sub/wrongtoken

# 3) 节点 WS 握手经 CF 可达（返回 101 即已成功路由到 sing-box；返回 502/530 说明回源失败）
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  https://sub.example.com/<WS_PATH>
```

TLS 说明：本方案回源走 `http://localhost:443`（明文 HTTP），加密只存在于「客户端 → CF 边缘」这一段，CF 后台的 SSL/TLS 加密模式（如 `Full (strict)`）仅对 `https://` 回源生效，对 Tunnel + HTTP 回源**不适用，无需设置**；回源段为服务器本机内部流量，可接受。Edge Certificates → 最低 TLS 版本建议保持默认 1.2（设为 1.3 会拒连仅支持 1.2 的老客户端）。

## 6. 客户端导入订阅

Clash.Meta（mihomo）/ Shadowrocket / V2rayN 订阅地址（**原版 Clash 内核不支持 VLESS**，需 Clash.Meta 分支）：

```text
https://sub.example.com/sub/<随机串>
```

节点参数（若手动添加）：

| 参数 | 值 |
|---|---|
| 协议 | VLESS |
| 地址 / 端口 | `sub.example.com` / `443` |
| UUID | `<UUID>` |
| 传输 | ws，path `/<WS_PATH>` |
| TLS | 开启，SNI = `sub.example.com` |

---

## 排障速查

| 现象 | 排查 |
|---|---|
| 订阅 502 | `systemctl status nginx`；`curl 127.0.0.1:8081/sub/<随机串>` 本机先通 |
| 节点 502 | sing-box 是否运行、443 是否监听；`journalctl -u cloudflared -f` 看回源报错 |
| 隧道 Offline | `journalctl -u cloudflared`；检查凭证文件路径与 token；7844 端口出站是否被墙 |
| CF 边缘 530/1033 | 隧道未注册成功，重新 `cloudflared tunnel run` 观察 |
| 订阅更新后客户端不生效 | nginx `no-store` 已设置；客户端手动刷新订阅 |

## 回退 / 清理

```bash
sudo systemctl disable --now cloudflared
cloudflared tunnel delete proxy      # 删除隧道（连同 CF 侧配置）
sudo apt remove cloudflared nginx    # 完全卸载
```
