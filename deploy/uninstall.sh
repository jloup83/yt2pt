#!/usr/bin/env bash
#
# yt2pt uninstaller (Linux)
#
# Stops and disables the yt2ptd service, removes binaries installed by
# deploy/install.sh, and removes /usr/local/lib/yt2pt.
#
# By default, configuration, data, logs, and the `yt2pt` system user
# are preserved. Pass --purge to remove them as well.
#
# Usage:
#   sudo ./deploy/uninstall.sh          # keep config/data/logs/user
#   sudo ./deploy/uninstall.sh --purge  # remove everything
#

set -euo pipefail

# --- constants ---------------------------------------------------------------

PREFIX="/usr/local"
LIB_DIR="${PREFIX}/lib/yt2pt"
BIN_DIR="${PREFIX}/bin"

CONFIG_DIR="/etc/yt2pt"
DATA_DIR="/var/lib/yt2pt"
LOG_DIR="/var/log/yt2pt"

SERVICE_USER="yt2pt"
SERVICE_GROUP="yt2pt"
SERVICE_NAME="yt2ptd.service"
SYSTEMD_DIR="/etc/systemd/system"

# --- flags -------------------------------------------------------------------

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: sudo $0 [--purge]" >&2
      exit 2
      ;;
  esac
done

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
  error "This uninstaller only supports Linux (detected: $(uname -s))."
  exit 1
fi

if [[ ${EUID} -ne 0 ]]; then
  error "This uninstaller must be run as root (try: sudo $0)."
  exit 1
fi

# --- stop service ------------------------------------------------------------

if [[ -e "${SYSTEMD_DIR}/${SERVICE_NAME}" ]]; then
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    info "Stopping ${SERVICE_NAME}"
    systemctl stop "${SERVICE_NAME}" || true
  fi
  if systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
    info "Disabling ${SERVICE_NAME}"
    systemctl disable "${SERVICE_NAME}" || true
  fi
  info "Removing ${SYSTEMD_DIR}/${SERVICE_NAME}"
  rm -f "${SYSTEMD_DIR}/${SERVICE_NAME}"
  systemctl daemon-reload
else
  info "No systemd unit installed; skipping service stop/disable."
fi

# --- remove binaries and payload --------------------------------------------

for name in yt2pt yt2ptd; do
  if [[ -e "${BIN_DIR}/${name}" ]]; then
    info "Removing ${BIN_DIR}/${name}"
    rm -f "${BIN_DIR}/${name}"
  fi
done

if [[ -d "${LIB_DIR}" ]]; then
  info "Removing ${LIB_DIR}"
  rm -rf "${LIB_DIR}"
fi

# --- purge -------------------------------------------------------------------

if [[ ${PURGE} -eq 1 ]]; then
  warn "--purge: removing configuration, data, logs, and system user."
  for d in "${CONFIG_DIR}" "${DATA_DIR}" "${LOG_DIR}"; do
    if [[ -d "$d" ]]; then
      info "Removing $d"
      rm -rf "$d"
    fi
  done
  if getent passwd "${SERVICE_USER}" >/dev/null; then
    info "Removing user '${SERVICE_USER}'"
    userdel "${SERVICE_USER}" 2>/dev/null || true
  fi
  if getent group "${SERVICE_GROUP}" >/dev/null; then
    info "Removing group '${SERVICE_GROUP}'"
    groupdel "${SERVICE_GROUP}" 2>/dev/null || true
  fi
else
  cat <<EOF

${c_yellow}Configuration, data, logs, and the '${SERVICE_USER}' user were preserved:${c_reset}
  ${CONFIG_DIR}
  ${DATA_DIR}
  ${LOG_DIR}

Re-run with --purge to remove them.
EOF
fi

info "yt2pt uninstalled."
