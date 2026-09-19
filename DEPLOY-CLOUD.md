# PlanTrace 云服务器部署指南（多用户 · 随时随地访问）

适用于：云服务器（阿里云 / 腾讯云 / VPS 等）+ 域名，多人在任何设备登录使用，数据集中在服务器上按账号隔离。

---

## 方式一：Docker Compose + 自动 HTTPS（推荐）

只需要一台装好 Docker 的 Linux 服务器和一个解析到它的域名。

```bash
# 1. 安装 Docker（以 Ubuntu 为例）
curl -fsSL https://get.docker.com | sh

# 2. 获取代码
git clone https://github.com/limonde/PlanTrace.git
cd PlanTrace

# 3. 配置域名
cp .env.example .env
vi .env            # 填 DOMAIN=plan.你的域名.com

# 4. 启动（首次会自动构建镜像）
docker compose up -d --build

# 5. 查看初始化令牌（首次部署才需要）
docker compose logs plantrace | grep -A2 "初始化令牌"
```

浏览器打开 `https://plan.你的域名.com`：

1. 用日志中的**初始化令牌**注册第一个账号（自动成为管理员）。
2. 右上角进入「用户管理」，关闭自助注册、按需创建账号。

HTTPS 证书由 Caddy 自动申请续期，无需手动配置。

**更新版本**：

```bash
git pull
docker compose up -d --build
```

**数据安全**：账号数据在 Docker 卷 `plantrace-data`（映射到容器 `/app/data`）中，备份在 `plantrace-backups`。重建容器、更新镜像都不会丢失；备份建议定期执行：

```bash
docker run --rm -v plantrace-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/plantrace-data-$(date +%F).tar.gz -C /data .
```

---

## 方式二：裸机 Node + systemd + Nginx/Caddy

服务器已装好 Node.js 20.19+ / 22.12+。

```bash
# 1. 获取代码并构建
sudo mkdir -p /opt/plantrace && sudo chown "$USER" /opt/plantrace
git clone https://github.com/limonde/PlanTrace.git /opt/plantrace
cd /opt/plantrace
npm ci
npm run build

# 2. 试运行（前台）
PLANTRACE_TRUST_PROXY=1 node server/index.js
# 首次启动日志中会打印初始化令牌

# 3. 注册为系统服务
sudo cp deploy/plantrace.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plantrace
```

### 反向代理 + HTTPS

**Caddy（自动证书，最简单）**：

```
plan.你的域名.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**：

```nginx
server {
    listen 443 ssl http2;
    server_name plan.你的域名.com;

    ssl_certificate     /etc/letsencrypt/live/plan.你的域名.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/plan.你的域名.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 80;
    server_name plan.你的域名.com;
    return 301 https://$host$request_uri;
}
```

> 代理必须传递 `X-Forwarded-Proto`，并且服务端设置 `PLANTRACE_TRUST_PROXY=1`，登录 Cookie 才会带 Secure 标记。

**更新版本**：

```bash
cd /opt/plantrace
git pull
npm ci && npm run build
sudo systemctl restart plantrace
```

也可以在管理员的「检查更新」弹窗中一键更新（需在 systemd 服务中加 `Environment=PLANTRACE_SELF_UPDATE=1`）。

---

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PLANTRACE_PORT` | `3000` | 监听端口 |
| `PLANTRACE_HOST` | `0.0.0.0` | 监听地址（配 Nginx 时可改 `127.0.0.1`） |
| `PLANTRACE_TRUST_PROXY` | 关 | 反向代理后设 `1`：信任 `X-Forwarded-For / X-Forwarded-Proto`（限流识别真实 IP、Cookie 加 Secure） |
| `PLANTRACE_SECURE_COOKIE` | 关 | 无代理但已 HTTPS 时设 `1` 强制 Secure Cookie |
| `PLANTRACE_SETUP_TOKEN` | 自动生成 | 首次注册管理员所需的初始化令牌 |
| `PLANTRACE_SELF_UPDATE` | 关 | 设 `1` 且为 git 检出时，允许应用内一键更新 |

---

## 安全清单

- [x] 首次注册需初始化令牌（防止公网部署被陌生人抢注管理员）
- [x] 密码 scrypt 加盐哈希，登录/注册接口按 IP 限流（防暴力破解）
- [x] HttpOnly + SameSite=Lax Cookie，HTTPS 下自动加 Secure
- [x] 所有用户数据接口按登录会话隔离，未登录一律 401
- [x] `data/`、`backups/` 不会被静态服务暴露
- [ ] 部署完成后在「用户管理」中关闭自助注册
- [ ] 建议定期备份 Docker 卷 / `data/` 目录
- [ ] 若使用 Nginx，建议再叠加 `limit_req` 与 fail2ban

## 多设备使用说明

- 同一账号可同时在手机、电脑登录；数据在服务器端按账号隔离。
- 两端同时编辑时，服务端按条目 ID 合并（同一条目以最后提交的一方为准），不会整份互相覆盖。
- 页面重新获得焦点时会自动拉取最新数据（本地有待保存改动时跳过）。

## 端口/防火墙

- Docker 方式：只开放 `80`、`443`（以及 SSH）。
- 裸机方式：只开放 `443`（以及 SSH），`3000` 仅监听本机。
