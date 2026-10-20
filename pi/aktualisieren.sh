#!/usr/bin/env bash
# Neuen Code und neue ppicng-Logos holen, Dienst neu starten: bash pi/aktualisieren.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
# ppicng auf den neuesten Stand (neue Logos von Gliederungen, AGs …)
git submodule update --init --remote ppicng
npm ci
sudo systemctl restart posting-bot
echo "Aktualisiert und neu gestartet. Neue Einstellungen stehen in .env.example – mit deiner .env vergleichen:"
echo "  diff <(grep -oE '^[A-Z_]+=' .env.example | sort) <(grep -oE '^[A-Z_]+=' .env | sort)"
