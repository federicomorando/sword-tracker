#!/usr/bin/env bash
# Installa il tracker come servizio systemd (Linux) dietro un reverse proxy / tunnel che arriva su 127.0.0.1:3000.
# Uso: sudo HOSTNAME_PUBLIC=tracker.example.org bash deploy/install.sh     (idempotente: si rilancia per aggiornare il codice)
# Variabili: HOSTNAME_PUBLIC (solo per i messaggi finali), RUN_USER (utente del servizio, default: chi ha lanciato sudo).
set -euo pipefail

HOSTNAME_PUBLIC="${HOSTNAME_PUBLIC:-tracker.example.org}"
APP_DIR=/opt/sword-tracker
DATA_DIR=/opt/sword-tracker-data
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${RUN_USER:-${SUDO_USER:-}}"

die() { echo "ERRORE: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "lancia con: sudo bash deploy/install.sh"
[[ -n $RUN_USER && $RUN_USER != root ]] || die "indica l'utente del servizio (non root): RUN_USER=nome sudo -E bash deploy/install.sh"
id "$RUN_USER" >/dev/null 2>&1 || die "utente $RUN_USER inesistente"
command -v node >/dev/null || die "node non trovato"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "serve Node >= 22.13 (node:sqlite senza flag) (trovato $(node -v))"
if ss -ltn 'sport = :3000' | grep -q LISTEN && ! systemctl is-active --quiet sword-tracker; then
  die "la porta 3000 è già occupata (un server di sviluppo?). Fermalo e rilancia."
fi

step "1/3 Copia del codice in $APP_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" "$APP_DIR" "$DATA_DIR"
cp -a "$SRC_DIR/server" "$SRC_DIR/client" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$APP_DIR/"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

step "2/3 Servizio systemd (utente: $RUN_USER)"
sed "s/^User=.*/User=$RUN_USER/" "$SRC_DIR/deploy/sword-tracker.service" > /etc/systemd/system/sword-tracker.service
chmod 644 /etc/systemd/system/sword-tracker.service
systemctl daemon-reload
systemctl enable sword-tracker >/dev/null
systemctl restart sword-tracker
sleep 2
systemctl is-active --quiet sword-tracker || { journalctl -u sword-tracker -n 20 --no-pager; die "il servizio non parte"; }
curl -fsS -o /dev/null http://127.0.0.1:3000/ || die "il tracker non risponde su 127.0.0.1:3000"
echo "tracker attivo su 127.0.0.1:3000"

step "3/3 Esposizione pubblica (a mano)"
# Se usi un Cloudflare Tunnel gestito dalla dashboard, controllo se la route esiste già nella configurazione in uso.
RUNNING_CFG="$(journalctl -u cloudflared --no-pager 2>/dev/null | grep 'Updated to new configuration' | tail -1 || true)"
ROUTE="$(grep -oE "${HOSTNAME_PUBLIC//./\\.}[^}]*" <<<"$RUNNING_CFG" | head -1 || true)"
if [[ -n $ROUTE ]]; then
  echo "route già attiva nella configurazione in uso da cloudflared"
  [[ $ROUTE == *"https://"* ]] && echo "ATTENZIONE: il servizio è configurato come HTTPS. Deve essere HTTP, altrimenti il tracker risponde 502."
else
  cat <<MSG
Il servizio ascolta solo su 127.0.0.1:3000: serve un reverse proxy o un tunnel che lo pubblichi su $HOSTNAME_PUBLIC (vedi README).
Esempio con Cloudflare Tunnel gestito da dashboard: Networking > Tunnels > (tunnel) > Routes > Published application,
hostname $HOSTNAME_PUBLIC, servizio HTTP (non HTTPS) localhost:3000. Non mettere il tracker dietro un login: la board deve restare aperta.
MSG
fi
printf '  sword-tracker  %s\n' "$(systemctl is-active sword-tracker)"
echo "Prova: https://$HOSTNAME_PUBLIC/prova"
