#!/usr/bin/env bash
# Ubuntu 22.04/24.04：sudo bash setup.sh。更新时保留线上数据和密码。
set -euo pipefail
APP_DIR=/opt/yizishuyu
APP_USER=yizishuyu
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE=/etc/yizishuyu.env
PORT="${PORT:-8080}"
[ "$(id -u)" -eq 0 ] || { echo '请运行 sudo bash setup.sh'; exit 1; }
command -v apt-get >/dev/null || { echo '请使用 Ubuntu 22.04/24.04 系统镜像'; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo 'PORT 应在 1024–65535 之间'; exit 1; }
for file in server.js index.html package.json backup.js smoke-test.js; do
  [ -f "$SRC_DIR/$file" ] || { echo "缺少 $file，请上传完整项目"; exit 1; }
done
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils openssl >/dev/null

# 使用已有 Node 的真实路径，避免 /usr/bin/node 与 /usr/local/bin/node 不一致。
NODE_BIN="$(command -v node || true)"
if [[ "$NODE_BIN" == /home/* || "$NODE_BIN" == /root/* || "$NODE_BIN" == /tmp/* ]]; then NODE_BIN=''; fi
if [ -z "$NODE_BIN" ] || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  case "$(uname -m)" in
    x86_64|amd64) NARCH=x64 ;;
    aarch64|arm64) NARCH=arm64 ;;
    *) echo '不支持的 CPU 架构'; exit 1 ;;
  esac
  task_download="$(mktemp -d)"
  trap 'rm -rf -- "$task_download"' EXIT
  NODE_VERSION="${NODE_VERSION:-$(curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | sed -n 's/^.*  node-\(v24\.[0-9]*\.[0-9]*\)-linux-x64.tar.xz$/\1/p')}"
  [[ "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || { echo '无法确定 Node 24 版本'; exit 1; }
  TARBALL="node-${NODE_VERSION}-linux-${NARCH}.tar.xz"
  curl -fsSL --retry 3 "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}" -o "$task_download/$TARBALL"
  curl -fsSL --retry 3 "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "$task_download/SHASUMS256.txt"
  (cd "$task_download"; grep "  ${TARBALL}$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/node
  tar -xJf "$task_download/$TARBALL" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  NODE_BIN=/usr/local/bin/node
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"
echo "Node: $($NODE_BIN -v) ($NODE_BIN)"

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data/backups"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  for file in server.js index.html package.json backup.js smoke-test.js loadtest.js integration-test.js frontend-test.js setup.sh setup-https.sh; do
    [ ! -f "$SRC_DIR/$file" ] || cp -f "$SRC_DIR/$file" "$APP_DIR/$file"
  done
fi
# 程序归 root，服务用户只能写数据；电脑演示数据不会覆盖线上数据。
chown root:root "$APP_DIR" "$APP_DIR"/*.js "$APP_DIR"/*.html "$APP_DIR"/*.json
chmod 755 "$APP_DIR"
chmod 644 "$APP_DIR"/*.js "$APP_DIR"/*.html "$APP_DIR"/*.json
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"
chmod 750 "$APP_DIR/data" "$APP_DIR/data/backups"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
ADMIN_PASSWORD=$(openssl rand -hex 16)
PORT=${PORT}
BIND_HOST=127.0.0.1
TRUST_PROXY=0
RATE_LIMIT_PER_HOUR=0
MAX_NOTES=5000
LOG_ACCESS=0
EOF
fi
chmod 600 "$ENV_FILE"
configured_port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
PORT="${configured_port:-$PORT}"

cat > /etc/systemd/system/yizishuyu.service <<EOF
[Unit]
Description=Yizishuyu campus book club
After=network-online.target
Wants=network-online.target
StartLimitBurst=10
StartLimitIntervalSec=60
[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=512
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
LimitNOFILE=16384
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${APP_DIR}/data
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
EOF

# systemd 显式使用北京时间，避免 cron 对 CRON_TZ 支持差异。
cat > /etc/systemd/system/yizishuyu-backup.service <<EOF
[Unit]
Description=Validated daily Yizishuyu data backup
[Service]
Type=oneshot
User=${APP_USER}
Group=${APP_USER}
UMask=0077
ExecStart=${NODE_BIN} ${APP_DIR}/backup.js ${APP_DIR}/data
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${APP_DIR}/data/backups
EOF
cat > /etc/systemd/system/yizishuyu-backup.timer <<'EOF'
[Unit]
Description=Daily backup at 03:00 Beijing time
[Timer]
OnCalendar=*-*-* 03:00:00 Asia/Shanghai
Persistent=true
[Install]
WantedBy=timers.target
EOF
rm -f /etc/cron.d/yizishuyu-backup
systemctl daemon-reload
systemctl enable --now yizishuyu-backup.timer
systemctl enable yizishuyu >/dev/null
systemctl restart yizishuyu
for attempt in {1..10}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health"; then break; fi
  sleep 1
done
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null || {
  journalctl -u yizishuyu -n 30 --no-pager; echo '启动失败，请处理日志中的错误'; exit 1;
}
systemctl start yizishuyu-backup.service
echo ''
echo '安装成功。后端只监听回环，暂不能从公网直接访问。'
echo "管理员密码：sudo cat $ENV_FILE（请私下保存，不要发布）"
echo '下一步：域名 A 记录指向公网 IP，云防火墙放行 TCP 80/443。'
echo "然后运行：sudo bash $APP_DIR/setup-https.sh 你的域名 你的邮箱"
