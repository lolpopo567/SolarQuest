#!/usr/bin/env bash
# One-time setup on a fresh Oracle Cloud Always Free VM (Ubuntu 22.04/24.04, Ampere A1 or AMD micro).
#   curl -fsSL <raw url of this file> -o setup.sh && bash setup.sh
# or copy it over with scp. Run as the default "ubuntu" user. Safe to run again.
set -euo pipefail
REPO="git@github.com:lolpopo567/GeoQuest.git"
BRANCH="${BRANCH:-claude/solar-quest-data-layers-whezwl}"
DIR="$HOME/GeoQuest"

echo "== 1/6 Docker and git"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
sudo apt-get install -y -qq git sqlite3 netfilter-persistent >/dev/null

echo "== 2/6 Firewall: open ports 80 and 443 on the VM (Oracle's Ubuntu image blocks them)"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport $p -j ACCEPT
done
sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save >/dev/null

echo "== 3/6 Read-only deploy key for the private GitHub repo"
KEY="$HOME/.ssh/solarquest_deploy"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "solarquest-oracle" -f "$KEY" >/dev/null
  printf 'Host github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$KEY" >> "$HOME/.ssh/config"
fi
if [ ! -d "$DIR/.git" ]; then
  echo
  echo "Add this key on GitHub: GeoQuest repo > Settings > Deploy keys > Add deploy key (leave 'write access' off):"
  echo
  cat "$KEY.pub"
  echo
  read -rp "Press Enter once it is added... "
  ssh-keyscan github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
  # only the folders the game needs (the repo also holds GBs of survey data)
  git clone --filter=blob:none --no-checkout --branch "$BRANCH" "$REPO" "$DIR"
  git -C "$DIR" sparse-checkout set solarquest schemas web scripts assets data/levels deploy
  git -C "$DIR" checkout "$BRANCH"
fi

echo "== 4/6 Settings (typed here on the server, never sent anywhere else)"
cd "$DIR/deploy/oracle"
if [ ! -f .env ]; then
  read -rp "Domain for the game (e.g. solarquest.duckdns.org): " d
  read -rp "MapTiler key (Enter to skip): " mt
  read -rp "Mapillary client token (Enter to skip): " ml
  read -rp "DuckDNS token (Enter to skip): " dd
  umask 077
  printf 'SITE_DOMAIN=%s\nMAPTILER_KEY=%s\nMAPILLARY_TOKEN=%s\nDUCKDNS_TOKEN=%s\nANDROID_PACKAGE=\nANDROID_CERT_SHA256=\n' \
    "$d" "$mt" "$ml" "$dd" > .env
fi
set -a; . ./.env; set +a

echo "== 5/6 DuckDNS (optional) and nightly backups"
CRON=$(mktemp)
crontab -l 2>/dev/null | grep -v solarquest > "$CRON" || true
echo "17 3 * * * $DIR/deploy/oracle/backup.sh >/dev/null 2>&1  # solarquest" >> "$CRON"
if [ -n "${DUCKDNS_TOKEN:-}" ]; then
  sub="${SITE_DOMAIN%%.duckdns.org}"
  echo "*/10 * * * * curl -fsS 'https://www.duckdns.org/update?domains=$sub&token=$DUCKDNS_TOKEN' >/dev/null  # solarquest" >> "$CRON"
  curl -fsS "https://www.duckdns.org/update?domains=$sub&token=$DUCKDNS_TOKEN"; echo
fi
crontab "$CRON"; rm -f "$CRON"
chmod +x backup.sh update.sh

echo "== 6/6 Build and start (first build takes 5-10 minutes)"
mkdir -p data
sudo docker compose up -d --build
echo
echo "Done. Open https://$SITE_DOMAIN in a minute or two (the HTTPS certificate is fetched on first visit)."
echo "Update later with: $DIR/deploy/oracle/update.sh"
