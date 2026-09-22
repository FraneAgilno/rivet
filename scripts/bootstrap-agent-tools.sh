#!/usr/bin/env bash
set -euo pipefail

# Installs common CLI prerequisites for working with this capabilities repo
# and installs Ops prerequisites used by the troubleshooting skills.
# Optional model CLIs (Claude Code, Codex) are installed when npm is available.

log() { printf "\n[%s] %s\n" "setup" "$*"; }
warn() { printf "\n[%s] %s\n" "warn" "$*"; }

HAS_BREW=0
HAS_APT=0
APT_UPDATED=0
WITH_OPTIONAL=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/bootstrap-agent-tools.sh [--with-optional]

Options:
  --with-optional   Also install optional capability tools (gh, docker, psql).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-optional)
      WITH_OPTIONAL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      warn "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if command -v brew >/dev/null 2>&1; then
  HAS_BREW=1
elif command -v apt-get >/dev/null 2>&1; then
  HAS_APT=1
fi

apt_update_once() {
  if [[ "$APT_UPDATED" -eq 0 ]]; then
    sudo apt-get update -y
    APT_UPDATED=1
  fi
}

install_cmd() {
  local cmd="$1"
  local brew_pkg="${2:-$1}"
  local apt_pkg="${3:-$brew_pkg}"

  if command -v "$cmd" >/dev/null 2>&1; then
    log "Already installed: $cmd"
    return 0
  fi

  if [[ "$HAS_BREW" -eq 1 ]]; then
    log "Installing with Homebrew: $brew_pkg"
    brew install "$brew_pkg"
    return 0
  fi

  if [[ "$HAS_APT" -eq 1 ]]; then
    log "Installing with apt-get: $apt_pkg"
    apt_update_once
    sudo apt-get install -y "$apt_pkg"
    return 0
  fi

  warn "No supported package manager found for $cmd. Install it manually."
  return 1
}

log "Installing base prerequisites"
install_cmd git || true
install_cmd curl || true
install_cmd jq || true
install_cmd rg ripgrep ripgrep || true
install_cmd node node nodejs || true
install_cmd npm npm npm || true

log "Installing Ops prerequisites used by this repo's troubleshooting skills"
install_cmd aws awscli awscli || true
install_cmd kubectl kubectl kubectl || true

if [[ "$WITH_OPTIONAL" -eq 1 ]]; then
  log "Installing optional capability tools"
  install_cmd gh gh gh || true
  install_cmd docker docker docker.io || true
  install_cmd psql postgresql postgresql-client || true
else
  log "Skipping optional capability tools (pass --with-optional to include gh, docker, psql)"
fi

# Ensure npm exists before attempting model CLI installs.
if command -v npm >/dev/null 2>&1; then
  log "Installing optional model CLIs (Claude Code, Codex)"

  if ! command -v claude >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code || warn "Failed to install Claude Code CLI."
  else
    log "Already installed: claude"
  fi

  if ! command -v codex >/dev/null 2>&1; then
    npm install -g @openai/codex || warn "Failed to install Codex CLI."
  else
    log "Already installed: codex"
  fi
else
  warn "npm not found; skipping Claude/Codex CLI installation."
fi

log "Done."
log "Quick verification:"
for cmd in git curl jq rg node npm aws kubectl gh docker psql claude codex; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf "  - %s: OK\n" "$cmd"
  else
    printf "  - %s: missing\n" "$cmd"
  fi
done

log "AWS auth check: aws sts get-caller-identity --profile <profile>"
log "EKS kubeconfig: aws eks update-kubeconfig --name <cluster> --profile <profile> --region <region>"
