#!/usr/bin/env bash
#
# yt2pt installer
#
# Two modes:
#   Production (default):
#     Installs the yt2pt CLI and yt2ptd daemon to /usr/local, creates the
#     `yt2pt` system user and standard directories (/etc/yt2pt, /var/lib/yt2pt,
#     /var/log/yt2pt), installs the systemd unit, and reloads systemd.
#     Requires root. Copies yt2pt.production.toml → /etc/yt2pt/yt2pt.toml.
#
#   Development (--development):
#     Copies yt2pt.development.toml → yt2pt.toml in the repo root so the
#     daemon can be run from source.  Does NOT require root.
#
# Idempotent: safe to re-run. Never overwrites an existing yt2pt.toml.
#
# Usage:
#   sudo ./deploy/install.sh              # production
#   ./deploy/install.sh --development     # development
#

set -euo pipefail

# --- parse arguments ---------------------------------------------------------

INSTALL_MODE="production"
for arg in "$@"; do
  case "$arg" in
    --development) INSTALL_MODE="development" ;;
    --help|-h)
      echo "Usage: $0 [--development]"
      echo "  (default)       Production install (requires root)"
      echo "  --development   Development setup (no root needed)"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--development]" >&2
      exit 1
      ;;
  esac
done

# --- constants ---------------------------------------------------------------

PREFIX="/usr/local"
LIB_DIR="${PREFIX}/lib/yt2pt"
APP_DIR="${LIB_DIR}/app"
YTDLP_DIR="${LIB_DIR}/bin"
BIN_DIR="${PREFIX}/bin"

CONFIG_DIR="/etc/yt2pt"
DATA_DIR="/var/lib/yt2pt"
LOG_DIR="/var/log/yt2pt"

SERVICE_USER="yt2pt"
SERVICE_GROUP="yt2pt"
SERVICE_NAME="yt2ptd.service"
SYSTEMD_DIR="/etc/systemd/system"

# --- pretty printing ---------------------------------------------------------

c_red=$'\033[31m'
c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_reset=$'\033[0m'
if [[ ! -t 1 ]]; then c_red=""; c_green=""; c_yellow=""; c_reset=""; fi

info()  { printf '%s[*]%s %s\n' "$c_green" "$c_reset" "$*"; }
warn()  { printf '%s[!]%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
error() { printf '%s[x]%s %s\n' "$c_red" "$c_reset" "$*" >&2; }

# --- preflight ---------------------------------------------------------------

if [[ "$(uname -s)" != "Linux" ]]; then
  error "This installer only supports Linux (detected: $(uname -s))."
  exit 1
fi

# Repo root = parent of the directory containing this script.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

# ── Development mode: just copy config template and exit ─────────────────────

if [[ "${INSTALL_MODE}" == "development" ]]; then
  DEV_CONFIG="${REPO_ROOT}/yt2pt.toml"
  DEV_TEMPLATE="${REPO_ROOT}/yt2pt.development.toml"

  if [[ ! -f "${DEV_TEMPLATE}" ]]; then
    error "Missing template: ${DEV_TEMPLATE}"
    exit 1
  fi

  if [[ -e "${DEV_CONFIG}" ]]; then
    info "Preserving existing config: ${DEV_CONFIG}"
  else
    info "Creating dev config: ${DEV_CONFIG}"
    cp "${DEV_TEMPLATE}" "${DEV_CONFIG}"
  fi

  cat <<EOF

${c_green}yt2pt development setup complete.${c_reset}

  Config:       ${DEV_CONFIG}
  Data dir:     ~/.local/share/yt2pt
  Log dir:      ~/.local/share/yt2pt/logs

  Edit your config:
    \$EDITOR ${DEV_CONFIG}

  Build the project:
    npm ci && npm run build:all

  Start the daemon:
    npx yt2ptd

  Use the CLI:
    npx yt2pt status
    npx yt2pt --help

  Open the web UI:
    http://localhost:8090

EOF
  exit 0
fi

# ── Production preflight ─────────────────────────────────────────────────────

if [[ ${EUID} -ne 0 ]]; then
  error "Production install must be run as root (try: sudo $0)."
  exit 1
fi

# Required build artifacts.
required_paths=(
  "${REPO_ROOT}/packages/cli/dist/index.js"
  "${REPO_ROOT}/packages/daemon/dist/yt2ptd.js"
  "${REPO_ROOT}/packages/shared/dist/index.js"
  "${REPO_ROOT}/packages/web/dist/index.html"
  "${REPO_ROOT}/node_modules"
  "${REPO_ROOT}/deploy/yt2ptd.service"
  "${REPO_ROOT}/yt2pt.production.toml"
)
missing=0
for p in "${required_paths[@]}"; do
  if [[ ! -e "$p" ]]; then
    error "Missing required artifact: ${p}"
    missing=1
  fi
done
if [[ ${missing} -ne 0 ]]; then
  error "Run 'npm ci && npm run build:all' from the repo root before installing."
  exit 1
fi

# Select the right yt-dlp binary for this host.
YTDLP_SRC="$(ls -1 "${REPO_ROOT}/bin"/yt-dlp-linux-* 2>/dev/null | head -n1 || true)"
if [[ -z "${YTDLP_SRC}" ]]; then
  error "No bundled Linux yt-dlp binary found under ${REPO_ROOT}/bin/"
  exit 1
fi

# Resolve a system-wide `node` that the daemon (running as the yt2pt user
# with systemd's ProtectHome=true) can actually execute.
#
# We check a few well-known system locations rather than trusting the
# caller's PATH, because `sudo` typically inherits the invoking user's
# PATH (including nvm under $HOME) which the service user cannot see.
NODE_BIN=""
for candidate in \
  /usr/local/bin/node \
  /usr/bin/node \
  /opt/node/bin/node \
  /snap/bin/node
do
  if [[ -x "$candidate" ]]; then
    NODE_BIN="$(readlink -f "$candidate")"
    break
  fi
done
if [[ -z "${NODE_BIN}" ]]; then
  error "No system-wide 'node' found in /usr/local/bin, /usr/bin, /opt/node/bin, or /snap/bin."
  error "The daemon runs as user '${SERVICE_USER}' with systemd ProtectHome=true, so"
  error "a node installed under \$HOME (e.g. nvm) is not reachable."
  error "Install Node.js system-wide, e.g.:"
  error "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  error "  sudo apt-get install -y nodejs"
  exit 1
fi
case "${NODE_BIN}" in
  /home/*|/root/*)
    error "Resolved node (${NODE_BIN}) lives under a home directory."
    error "Install Node.js system-wide (outside \$HOME) so the daemon can reach it."
    exit 1
    ;;
esac

info "Installing yt2pt from: ${REPO_ROOT}"
info "Using node:      ${NODE_BIN} ($("${NODE_BIN}" --version))"

# --- user & group ------------------------------------------------------------

if ! getent group  "${SERVICE_GROUP}" >/dev/null; then
  info "Creating system group '${SERVICE_GROUP}'"
  groupadd --system "${SERVICE_GROUP}"
fi
if ! getent passwd "${SERVICE_USER}" >/dev/null; then
  info "Creating system user '${SERVICE_USER}'"
  useradd --system --gid "${SERVICE_GROUP}" \
          --home-dir /nonexistent --no-create-home \
          --shell /usr/sbin/nologin \
          --comment "yt2pt daemon" \
          "${SERVICE_USER}"
fi

# --- directories -------------------------------------------------------------

info "Creating directories"
install -d -m 0755 -o root           -g root           "${LIB_DIR}"
install -d -m 0755 -o root           -g root           "${APP_DIR}"
install -d -m 0755 -o root           -g root           "${YTDLP_DIR}"
install -d -m 0750 -o root           -g "${SERVICE_GROUP}" "${CONFIG_DIR}"
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${DATA_DIR}"
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${LOG_DIR}"

# --- application payload -----------------------------------------------------

info "Copying application payload to ${APP_DIR}"
# Wipe the previous payload (everything inside app/) before copying to keep
# the install clean. The parent directory and its mode are preserved.
find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

# Root package manifests (needed so node can resolve workspace packages).
install -m 0644 "${REPO_ROOT}/package.json"      "${APP_DIR}/package.json"
if [[ -f "${REPO_ROOT}/package-lock.json" ]]; then
  install -m 0644 "${REPO_ROOT}/package-lock.json" "${APP_DIR}/package-lock.json"
fi

# Per-workspace dist + package.json (source not needed at runtime).
for pkg in shared daemon cli web; do
  src="${REPO_ROOT}/packages/${pkg}"
  dst="${APP_DIR}/packages/${pkg}"
  install -d -m 0755 "${dst}"
  install -m 0644 "${src}/package.json" "${dst}/package.json"
  if [[ -d "${src}/dist" ]]; then
    cp -a "${src}/dist" "${dst}/dist"
  fi
done

# node_modules: copy as-is. This preserves workspace symlinks that npm
# creates under node_modules/@yt2pt/*.
cp -a "${REPO_ROOT}/node_modules" "${APP_DIR}/node_modules"

chown -R root:root "${APP_DIR}"

# --- yt-dlp binary -----------------------------------------------------------

info "Installing yt-dlp binary: $(basename "${YTDLP_SRC}")"
install -m 0755 -o root -g root "${YTDLP_SRC}" "${YTDLP_DIR}/$(basename "${YTDLP_SRC}")"

# --- CLI / daemon wrappers ---------------------------------------------------

info "Installing /usr/local/bin wrappers"

cat > "${BIN_DIR}/yt2pt" <<EOF
#!/bin/sh
# yt2pt CLI wrapper (installed by deploy/install.sh)
exec ${NODE_BIN} ${APP_DIR}/packages/cli/dist/index.js "\$@"
EOF
chmod 0755 "${BIN_DIR}/yt2pt"

cat > "${BIN_DIR}/yt2ptd" <<EOF
#!/bin/sh
# yt2ptd daemon wrapper (installed by deploy/install.sh)
exec ${NODE_BIN} ${APP_DIR}/packages/daemon/dist/yt2ptd.js "\$@"
EOF
chmod 0755 "${BIN_DIR}/yt2ptd"

# --- default config ----------------------------------------------------------

CONFIG_FILE="${CONFIG_DIR}/yt2pt.toml"
if [[ -e "${CONFIG_FILE}" ]]; then
  info "Preserving existing config: ${CONFIG_FILE}"
else
  info "Installing default config: ${CONFIG_FILE}"
  install -m 0640 -o root -g "${SERVICE_GROUP}" \
    "${REPO_ROOT}/yt2pt.production.toml" "${CONFIG_FILE}"
fi

# --- systemd unit ------------------------------------------------------------

info "Installing systemd unit: ${SYSTEMD_DIR}/${SERVICE_NAME}"
install -m 0644 -o root -g root \
  "${REPO_ROOT}/deploy/${SERVICE_NAME}" \
  "${SYSTEMD_DIR}/${SERVICE_NAME}"

info "Running systemctl daemon-reload"
systemctl daemon-reload

# --- done --------------------------------------------------------------------

cat <<EOF

${c_green}yt2pt installed successfully.${c_reset}

  Paths:
    Config:       ${CONFIG_FILE}
    Data dir:     ${DATA_DIR}
    Log dir:      ${LOG_DIR}
    Binaries:     ${BIN_DIR}/yt2pt, ${BIN_DIR}/yt2ptd
    App dir:      ${APP_DIR}
    yt-dlp:       ${YTDLP_DIR}
    Systemd unit: ${SYSTEMD_DIR}/${SERVICE_NAME}

  Edit the config:
    sudo \$EDITOR ${CONFIG_FILE}

  Service management:
    sudo systemctl enable --now ${SERVICE_NAME}   # start + enable at boot
    sudo systemctl stop ${SERVICE_NAME}            # stop
    sudo systemctl restart ${SERVICE_NAME}         # restart
    sudo systemctl status ${SERVICE_NAME}          # status

  Logs:
    journalctl -u ${SERVICE_NAME} -f               # live journal logs
    tail -f ${LOG_DIR}/yt2ptd.log                   # log file

  CLI:
    yt2pt status
    yt2pt --help

  Web UI:
    http://<host>:8090

  Uninstall:
    sudo ${SCRIPT_DIR}/uninstall.sh
EOF
