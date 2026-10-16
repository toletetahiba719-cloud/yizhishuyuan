#!/usr/bin/env bash
# sudo bash setup-https.sh shuyu.example.com me@example.com
set -euo pipefail
DOMAIN="${1:-}"
EMAIL="${2:-}"
ENV_FILE=/etc/yizishuyu.env
NGINX_SITE=/etc/nginx/sites-available/yizishuyu
[ "$(id -u)" -eq 0 ] || { echo '请用 sudo 运行'; exit 1; }
[ -f "$ENV_FILE" ] || { echo '请先运行 setup.sh'; exit 1; }
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$ ]] && [[ "$DOMAIN" != *..* ]] || {
  echo '请输入纯域名（不含 https://、端口或路径）'; exit 1;
}
[[ "$EMAIL" =~ ^[^[:space:]]+@[^[:space:]]+\.[^[:space:]]+$ ]] || { echo '请提供证书提醒邮箱作为第二个参数'; exit 1; }
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
PORT="${PORT:-8080}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo '配置中的 PORT 不合法'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx dnsutils >/dev/null
echo '请确认下列 A 记录指向本机公网 IP（如有 AAAA 也必须有效）：'
dig +short "$DOMAIN" A
if ! dig +short "$DOMAIN" A | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo '域名尚无可用的 A 记录，请添加并等待生效'; exit 1;
fi
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi
if [ -f "$NGINX_SITE" ]; then
  grep -qF "server_name ${DOMAIN};" "$NGINX_SITE" && grep -qF "proxy_pass http://127.0.0.1:${PORT};" "$NGINX_SITE" || {
    echo "已有站点与域名/端口不同，请检查 $NGINX_SITE，脚本不会覆盖已有证书配置"; exit 1;
  }
else
  cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
        client_max_body_size 32k;
    }
}
EOF
fi
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/yizishuyu
nginx -t
systemctl enable --now nginx
systemctl reload nginx
set_env() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE";
  else echo "$1=$2" >> "$ENV_FILE"; fi
}
set_env BIND_HOST 127.0.0.1
set_env TRUST_PROXY 1
systemctl restart yizishuyu
certbot --nginx --non-interactive -d "$DOMAIN" --redirect --agree-tos -m "$EMAIL"
systemctl enable --now certbot.timer
curl -fsS --retry 3 --retry-delay 1 --max-time 10 "https://$DOMAIN/api/health"
echo ''
echo "网站地址：https://$DOMAIN/"
echo '云防火墙关闭 8080 入站；TCP 80/443 保持开放，SSH 22 只对管理员来源开放。'
echo '执行 sudo certbot renew --dry-run 验证续期。'
echo '用校园网和手机流量分别在微信中扫码，验证提交、审核、公开、拆信和导出。'
echo '有效 HTTPS 不能保证微信永不拦截；风险提示需按提示页申诉并检查域名状态。'
