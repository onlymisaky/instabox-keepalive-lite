# Squid HTTP 代理部署与使用

> 定位：系统代理接入（设备自带"网络代理"功能配置 HTTP 代理）的**主力实现**——提供成熟的裸 HTTP 代理（含 HTTP CONNECT）；sing-box 另保留一个备用 HTTP 入站（10810），二者并存、端口错开
> 总体设计：[index.md](index.md) 阶段 4a
> 本文结构：先部署 Squid 本体（装完即可本机使用），再在无公网 IP 的前提下，通过 Tailscale（内网入口）/ cpolar（公网入口）把代理暴露给其他设备

---

## 技术选型：为什么用 Squid 而不是 sing-box

| 维度 | Squid | sing-box HTTP 入站 |
|------|-------|--------------------|
| 定位 | 专职正向代理，20+ 年成熟度 | 通用代理核心的一个入站类型 |
| HTTP CONNECT | 原生完整支持，细节行为最兼容 | 支持但非主打 |
| 认证 | 内置 Basic 认证 + 独立密码文件（哈希存储） | `users` 字段明文写在配置里 |
| ACL 控制 | 网段/时段/端口/域名级精细控制 | 仅基础规则 |
| 缓存 | 可选磁盘缓存（默认建议关闭） | 无 |
| 生态 | 系统服务原生集成，logrotate 等开箱即用 | 需自行维护 systemd/日志 |
| 与其他能力的关系 | 无冲突：客户端订阅接入仍由 sing-box VLESS-WS 承担，私有组网由 Tailscale 承担 | sing-box 仍是订阅接入核心与 SOCKS 入站 |

结论：系统代理接入的"裸 HTTP 代理"用 Squid 更专业、更好维护，作为主力（10809）；sing-box 的 HTTP 入站降为备用（10810），配置统一、便于调试时对照。

---

## Squid 安装、配置与使用

### 步骤总览

1. 安装 Squid
2. （可选）创建认证密码文件
3. 编写 `squid.conf`（基础版：仅监听 loopback）
4. 启动并设置开机自启
5. 本机使用与验证
6. （可选）进阶配置
7. 回退 / 清理

### 1. 安装

```bash
sudo apt update
sudo apt install -y squid apache2-utils   # apache2-utils 提供 htpasswd，仅启用认证时需要
```

验证：

```bash
squid --version   # Debian 13 仓库为 Squid 6.x
```

### 2.（可选）创建认证密码文件

> 是否需要认证取决于后续选择的暴露方案：**Tailscale 方案可选，cpolar 方案必选**。若暂不确定，可以先跳过，后续随时补做。

```bash
# 创建密码文件并添加用户（-c 仅第一次使用，追加用户时去掉 -c）
sudo htpasswd -c /etc/squid/passwd myuser
# 按提示输入两次密码

sudo chown root:proxy /etc/squid/passwd
sudo chmod 640 /etc/squid/passwd
```

追加更多用户：

```bash
sudo htpasswd /etc/squid/passwd anotheruser
```

说明：

- 密码文件是"用户名 → APR1-MD5 哈希"的映射，Squid 通过 `basic_ncsa_auth` 帮助程序查它做认证校验，比明文写进配置更安全
- `chown root:proxy` + `chmod 640`：Squid 进程以 `proxy` 用户运行，必须可读；其他系统用户不可见

### 3. 编写配置

备份默认配置：

```bash
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.default
```

编辑 `/etc/squid/squid.conf`，写入以下内容（或精简保留默认文件头部 acl 后追加）。**认证相关行默认已注释**，需要认证时按注释提示放开即可：

```squid
# ===== 端口监听 =====
# 基础版仅监听 loopback：本机可用，对外暴露由后续的暴露方案决定
http_port 127.0.0.1:10809

# ===== 认证（默认关闭；启用前提见步骤 2，放开下面 5 行注释） =====
#auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
#auth_param basic realm Proxy Authentication Required
#auth_param basic credentialsttl 2 hours
#auth_param basic casesensitive on
#acl authenticated proxy_auth REQUIRED

# ===== ACL 定义 =====
acl localhost src 127.0.0.1/32
acl SSL_ports port 443
acl Safe_ports port 80          # http
acl Safe_ports port 443         # https
acl Safe_ports port 1025-65535  # 非特权端口

# ===== 访问控制 =====
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow localhost # 免认证（默认）：本机放行
#http_access allow authenticated localhost # 启用认证场景：放开本行，同时注释掉上一行（二者互斥，只能放行一个）
http_access deny all

# ===== 代理行为 =====
cache deny all          # 纯代理用，不启用磁盘缓存
forwarded_for delete    # 不向目标站暴露客户端内网 IP
via off
dns_v4_first on

# ===== 日志 =====
access_log daemon:/var/log/squid/access.log squid
```

启用认证的操作：先完成步骤 2（生成密码文件），再放开配置中两处注释——`auth_param` 5 行，以及访问控制区的 `http_access allow authenticated localhost`（同时注释掉 `http_access allow localhost`，二者互斥，只能放行一个）。

配置语法检查：

```bash
sudo squid -k parse     # 无 error 输出即为通过
```

要点说明：

- **端口 10809**：与总体设计中的系统代理主力 HTTP 端口保持一致，设备端配置不用因实现切换而改变（sing-box 备用 HTTP 入站为 10810，见 [sing-box-setup.md](sing-box-setup.md)）
- **基础版仅监听 loopback**：最保守的默认，装完即安全；后文各暴露方案只做"增量修改"，不推倒重来

### 4. 启动

```bash
sudo systemctl enable --now squid
sudo systemctl status squid
```

确认监听：

```bash
ss -tlnp | grep squid
# 应看到 127.0.0.1:10809
```

### 5. 本机使用与验证

```bash
# 免认证（默认）
curl -x http://127.0.0.1:10809 https://api.ipify.org
# 已启用认证
curl -x http://myuser:密码@127.0.0.1:10809 https://api.ipify.org
# 返回服务器出站 IP（与本机直连 `curl https://api.ipify.org` 的结果一致）即成功
```

浏览器（本机）配置代理 `127.0.0.1:10809` 后访问 IP 查询站，显示服务器出站 IP 即成功。

确认命中日志：

```bash
sudo tail -f /var/log/squid/access.log
```

### 6.（可选）进阶配置

#### 磁盘缓存（节省带宽，代理场景默认不需要）

```squid
cache_dir ufs /var/spool/squid 2048 16 256
# 并删除上面的 cache deny all
```

```bash
sudo squid -z          # 初始化缓存目录（首次）
sudo systemctl restart squid
```

#### 日志轮转

Debian 包自带 `/etc/logrotate.d/squid`，默认已配置，无需处理。

#### 限制可访问的目标端口（白名单模式）

默认配置允许 80/443/非特权端口。如需收紧，删除 `acl Safe_ports port 1025-65535` 并按需补充端口。

### 7. 回退 / 清理

```bash
sudo systemctl disable --now squid   # 停止并取消自启
sudo apt purge squid apache2-utils   # 完全卸载
sudo rm -rf /etc/squid /var/log/squid /var/spool/squid
```

---

## 无公网 IP 下的对外暴露

> 本服务器**无公网 IP**（出站经 NAT，入站不可达），前文配置只监听 loopback，仅本机可用。
> 要让其他设备使用代理，必须借道第三方把流量"引入"本机。以下两种方案均基于本机**主动出站**连接，无需公网 IP。

### 方案对比

| 维度 | A. Tailscale（推荐） | B. cpolar |
|------|---------------------|-----------|
| 原理 | 设备进 tailnet 后直连内网 IP | 公网 TCP 隧道透传到本机 |
| 设备要求 | 需安装 Tailscale 客户端并登录 | 无需装任何客户端，系统代理直接填 |
| 加密 | 端到端（WireGuard） | 隧道本身无加密，平台可见全部流量 |
| 成本 | 免费 | 免费版随机地址 + ~1Mbps；固定 TCP 端口需付费 |
| 认证要求 | 可选（网段 ACL 已限制） | **必选**（防开放代理被扫） |
| 适合场景 | 日常主力，自己的设备 | 无法装 Tailscale 的设备（他人/受管设备）兜底 |

### 方案 A：Tailscale（推荐）

前置：先完成 Tailscale 组网（[tailscale-setup.md](tailscale-setup.md)），获取服务器 tailnet IP（`tailscale ip -4`，形如 `100.x.y.z`）。

#### 配置变更（增量修改 squid.conf）

```squid
# 端口监听中追加一行（保留原 127.0.0.1 那行）
http_port 100.x.y.z:10809

# ACL 定义中追加
acl tailscale_net src 100.64.0.0/10     # Tailscale CGNAT 全段

# 访问控制中，在 deny all 之前追加
http_access allow tailscale_net
```

重启生效：`sudo systemctl restart squid`

要点：

- **只绑定 Tailscale 网卡**：配合 ACL 双重限制，即使配错也不会暴露到其他网卡（本机无公网 IP，属于纵深防御）
- **免认证即可用**：放行仅限 tailnet 网段，纯自用场景可不做认证；tailnet 有共享设备或想纵深防御时，再启用认证（放开配置中的认证注释，并把 `http_access allow tailscale_net` 换成 `http_access allow authenticated tailscale_net`）

#### 设备端配置与验证

设备先连接 tailnet（[tailscale-setup.md](tailscale-setup.md) 步骤 4），然后在系统"网络代理"设置中填：

```
协议: HTTP
服务器: 100.x.y.z        # 服务器的 tailnet IP 或 MagicDNS 主机名
端口:   10809
用户名: myuser           # 仅启用认证时填写，免认证留空
密码:   ********
```

```bash
# 免认证（默认）
curl -x http://100.x.y.z:10809 https://api.ipify.org
# 已启用认证
curl -x http://myuser:密码@100.x.y.z:10809 https://api.ipify.org
```

浏览器访问 IP 查询站，显示服务器出站 IP 即成功。

### 方案 B：cpolar（公网级兜底）

> 适用场景：无法安装 Tailscale 的设备（他人设备、受管设备），又需要裸 HTTP 代理。
> 原理：cpolar 提供裸 TCP 隧道透传，Squid 原生支持 HTTP CONNECT。

```
设备（系统代理设置）──► cpolar 公网地址:port ──► 本机 cpolar 客户端 ──► 127.0.0.1:10809 (Squid) ──► 出站
```

#### 前提：认证必须启用

cpolar 客户端在本机连接 Squid，Squid 看到的来源 IP 是 `127.0.0.1`，会命中配置里的 `http_access allow localhost`。隧道地址本身无加密鉴权，一旦泄露等于**开放代理被任何人扫到即用**。

因此走本方案时，**必须**完成步骤 2（生成密码文件）并启用认证（放开配置中的认证注释，见步骤 3 的提示）；免认证状态不得用于此场景。

#### 配置变更

**Squid 无需改动**——基础版监听的 `127.0.0.1:10809` 正是 cpolar 转发的目标，反而避免了监听公网网卡。

#### 安装并启动 cpolar

```bash
# 安装（以官方脚本为例，版本号以 cpolar 官网为准）
curl -L https://www.cpolar.com/static/downloads/install-release-cpolar.sh | sudo bash
# 认证 token（官网控制台获取）
cpolar authtoken <你的token>
# 建立隧道，指向本地 Squid 端口
cpolar tcp 10809
```

- **免费版**：分配随机地址和端口，每次重启都会变化，带宽约 1Mbps——只适合临时验证
- **付费版**：在官网控制台预留固定 TCP 端口后，隧道地址稳定，设备端配置一次写死

生产使用建议注册为 systemd 服务（安装脚本通常已自动注册，确认 `systemctl status cpolar` 即可）。

#### 设备端配置与验证

在系统"网络代理"设置中填（地址和端口为 cpolar 分配/预留的公网值）：

```
协议: HTTP
服务器: <N.tcp.cpolar.top>   # cpolar 公网地址
端口:   <cpolar 分配的端口>
用户名: myuser               # 必填（认证版）
密码:   ********
```

```bash
curl -x http://myuser:密码@<N.tcp.cpolar.top>:<端口> https://api.ipify.org
```

返回服务器出站 IP 即成功。

---

## 与总体设计的衔接

| 能力 | 实现组件 | 文档 |
|------|----------|------|
| 客户端订阅接入（Clash 订阅，公网可达） | sing-box VLESS-WS + CF Tunnel | [sing-box-setup.md](sing-box-setup.md) / [cf-tunnel-setup.md](cf-tunnel-setup.md) |
| 系统代理接入（裸 HTTP 代理） | **Squid（本文档，主力，10809）** + sing-box 备用入站（10810） | 本文档 / [sing-box-setup.md](sing-box-setup.md) |
| 私有组网（Tailscale / Exit Node） | Tailscale | [tailscale-setup.md](tailscale-setup.md) |

- 系统代理接入的两个入口：Tailscale 内网（本文档"方案 A"，自己的设备优先）与 cpolar 公网（本文档"方案 B"/[cpolar-setup.md](cpolar-setup.md)，无法组网设备的兜底）。
- sing-box 的 HTTP 备用入站（10810）与 Squid（10809）端口错开、互不影响；SOCKS5（10808）仍由 sing-box 提供。