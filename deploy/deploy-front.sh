#!/usr/bin/env bash
# Streamly Academia · FRONTEND en el servidor que ya tiene nginx + pm2 (backend en ~/Back_Stream, pm2: streamly-back).
# Reemplaza el sitio nginx actual de $DOMAIN por Streamly (con respaldo y confirmación). No toca los demás sitios.
# Uso:  DOMAIN=cursos.geraldgarcia.ai EMAIL=tu@correo.com bash deploy-front.sh
set -euo pipefail

DOMAIN="${DOMAIN:-cursos.geraldgarcia.ai}"
EMAIL="${EMAIL:-}"
REPO_URL="https://github.com/UrieLBadilloG/Front_Stream.git"
SRC_DIR="$HOME/Front_Stream"
WEB_DIR="/var/www/streamly"
BACK_DIR="$HOME/Back_Stream"
PM2_NAME="streamly-back"
PORT=3000
BACKUP_DIR="$HOME/nginx-respaldo-$(date +%Y%m%d-%H%M%S)"
SITE_NAME="streamly-academia"

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "No lo ejecutes como root: usa tu usuario normal."
[ -f "$BACK_DIR/.env" ] || die "No encuentro $BACK_DIR/.env."
command -v pm2 >/dev/null || die "No encuentro pm2."
pm2 describe "$PM2_NAME" >/dev/null 2>&1 || die "pm2 no tiene la app $PM2_NAME. Arranca el backend primero."
curl -fsS -m 8 "http://127.0.0.1:$PORT/api/health" >/dev/null || die "El backend no responde en 127.0.0.1:$PORT."

git_try() {
  if git "$@" 2>/dev/null; then return 0; fi
  echo "No pude acceder al repositorio sin credenciales (¿es privado?). Pega un token de GitHub con permiso de lectura de contenido."
  local token auth
  read -rsp "Token: " token; echo
  auth="$(printf 'x-access-token:%s' "$token" | base64 -w0)"
  git -c http.extraHeader="Authorization: Basic $auth" "$@"
}

say "1/7 DNS de $DOMAIN"
MYIP="$(curl -fsS -m 3 -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)"
echo "El dominio resuelve a: ${RESOLVED:-nada}   ·   IP de este servidor: ${MYIP:-desconocida}"
[ -n "$RESOLVED" ] || die "$DOMAIN no resuelve todavía."
if [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then die "$DOMAIN apunta a $RESOLVED y no a este servidor ($MYIP). Corrige el registro A y espera la propagación."; fi

say "2/7 Sitio nginx actual de $DOMAIN"
mapfile -t OLD_FILES < <(sudo grep -rlE "server_name[^;]*[[:space:]]${DOMAIN//./\\.}[;[:space:]]" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sort -u || true)
if [ "${#OLD_FILES[@]}" -gt 0 ]; then
  for f in "${OLD_FILES[@]}"; do
    [ "$(basename "$f")" = "$SITE_NAME" ] && continue
    echo "--- $f ---"
    sudo sed -n '1,45p' "$f"
    OTHERS="$(sudo grep -hE '^\s*server_name' "$f" | sed -E 's/^\s*server_name\s+//; s/;.*$//' | tr ' ' '\n' | grep -v '^$' | sort -u | grep -vx "$DOMAIN" || true)"
    [ -z "$OTHERS" ] || die "Ese archivo ($f) también sirve otros dominios ($OTHERS). No lo reemplazo automáticamente."
  done
  echo
  echo "Lo de arriba es lo que sirve hoy $DOMAIN. Se hará un respaldo en $BACKUP_DIR y se reemplazará por Streamly Academia."
  read -rp 'Escribe SI para continuar: ' ans
  [ "$ans" = "SI" ] || die "Cancelado; no se cambió nada."
else
  echo "No hay un sitio nginx para $DOMAIN: se creará uno nuevo."
fi

say "3/7 Código y compilación del frontend (VITE_API_URL=https://$DOMAIN)"
if [ -d "$SRC_DIR/.git" ]; then
  git_try -C "$SRC_DIR" fetch --prune origin
  git -C "$SRC_DIR" reset --hard origin/main
else
  git_try clone "$REPO_URL" "$SRC_DIR"
fi
git -C "$SRC_DIR" log --oneline -1
cd "$SRC_DIR"
npm ci --no-audit --no-fund
VITE_API_URL="https://$DOMAIN" VITE_PUBLIC_APP_URL="https://$DOMAIN" npm run build
[ -f dist/index.html ] || die "La compilación no generó dist/index.html."
sudo apt-get install -y rsync >/dev/null
sudo mkdir -p "$WEB_DIR"
sudo rsync -a --delete "$SRC_DIR/dist/" "$WEB_DIR/"

say "4/7 Respaldo y cambio de sitio en nginx"
mkdir -p "$BACKUP_DIR"
for f in "${OLD_FILES[@]:-}"; do
  [ -n "$f" ] || continue
  [ "$(basename "$f")" = "$SITE_NAME" ] && continue
  sudo cp -L "$f" "$BACKUP_DIR/$(basename "$f")"
  echo "$f" >> "$BACKUP_DIR/ORIGEN.txt"
  sudo rm -f "$f"
done
sudo tee "/etc/nginx/sites-available/$SITE_NAME" >/dev/null <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    root $WEB_DIR;
    index index.html;
    client_max_body_size 5m;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # API, enlaces compartibles de cursos (/c/...) y de constancias (/v/...)
    location ~ ^/(api|c|v)(/|\$) {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri /index.html;
    }
}
NGX
sudo ln -sf "/etc/nginx/sites-available/$SITE_NAME" "/etc/nginx/sites-enabled/$SITE_NAME"
if ! sudo nginx -t; then
  echo "nginx rechazó la configuración: restaurando el sitio anterior..."
  sudo rm -f "/etc/nginx/sites-enabled/$SITE_NAME"
  for b in "$BACKUP_DIR"/*; do
    [ "$(basename "$b")" = "ORIGEN.txt" ] && continue
    sudo cp "$b" "/etc/nginx/sites-enabled/$(basename "$b")"
  done
  sudo nginx -t && sudo systemctl reload nginx
  die "Se restauró el sitio anterior. Nada quedó cambiado."
fi
sudo systemctl reload nginx

say "5/7 HTTPS (Let's Encrypt; reutiliza el certificado si ya existía)"
if ! command -v certbot >/dev/null 2>&1; then sudo apt-get install -y certbot python3-certbot-nginx; fi
if [ -n "$EMAIL" ]; then CERT_MAIL=(-m "$EMAIL"); else CERT_MAIL=(--register-unsafely-without-email); fi
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos "${CERT_MAIL[@]}" --redirect
sudo nginx -t && sudo systemctl reload nginx

say "6/7 Backend: URLs públicas de producción"
ENV_FILE="$BACK_DIR/.env"
set_env() { local key="$1" val="$2"; if grep -q "^${key}=" "$ENV_FILE"; then sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"; else echo "${key}=${val}" >> "$ENV_FILE"; fi; }
set_env APP_URL "https://$DOMAIN"
set_env PUBLIC_API_URL "https://$DOMAIN"
set_env CORS_ORIGIN "https://$DOMAIN"
pm2 restart "$PM2_NAME" --update-env >/dev/null
pm2 save >/dev/null
sleep 3

say "7/7 Comprobando"
printf 'Sitio : '; curl -fsS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/"
printf 'API   : '; curl -fsS "https://$DOMAIN/api/health" && echo
echo
echo "Listo: https://$DOMAIN"
echo "Respaldo del sitio anterior: $BACKUP_DIR"
echo "Para volver atrás:  sudo rm /etc/nginx/sites-enabled/$SITE_NAME && sudo cp $BACKUP_DIR/* /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/ORIGEN.txt && sudo nginx -t && sudo systemctl reload nginx"
echo "Mercado Pago: registra el webhook en https://$DOMAIN/api/payments/webhook y pon su clave en MERCADOPAGO_WEBHOOK_SECRET de $ENV_FILE (luego: pm2 restart $PM2_NAME --update-env)."
