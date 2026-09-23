#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/../tool-versions.sh"

bench_only=false
if [[ ${1:-} == "--bench-only" ]]; then
  bench_only=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--bench-only]" >&2
  exit 2
fi

current_version() {
  local binary=$1
  "$binary" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true
}

install_exact() {
  local package=$1
  local binary=$2
  local required=$3
  shift 3

  local current=""
  local installed=false
  if command -v "$binary" &>/dev/null; then
    installed=true
    current=$(current_version "$binary")
  fi

  if [[ $current == "$required" ]]; then
    echo "$binary $current already available"
    return
  fi

  local force=()
  if [[ $installed == true ]]; then
    force=(--force)
  fi
  echo "Installing $package $required..."
  cargo install "$package@$required" --locked "${force[@]}" "$@"
}

install_git() {
  local package=$1
  local url=$2
  local revision=$3
  shift 3

  echo "Installing $package from $url at $revision..."
  cargo install "$package" --git "$url" --rev "$revision" --locked --force "$@"
}

install_wasm_tools() {
  local current=""
  local installed=false
  if command -v wasm-tools &>/dev/null; then
    installed=true
    current=$(current_version wasm-tools)
  fi

  if [[ -n $current ]] && printf '%s\n' "$WASM_TOOLS_MIN_VERSION" "$current" | sort -V -C; then
    echo "wasm-tools $current already available"
    return
  fi

  local force=()
  if [[ $installed == true ]]; then
    force=(--force)
  fi
  echo "Installing wasm-tools $WASM_TOOLS_MIN_VERSION..."
  cargo install "wasm-tools@$WASM_TOOLS_MIN_VERSION" --locked "${force[@]}"
}

if [[ $bench_only == false ]]; then
  install_wasm_tools

  if [[ -n $HYPERLIGHT_WASM_AOT_GIT_REV ]]; then
    install_git hyperlight-wasm-aot "$HYPERLIGHT_WASM_AOT_GIT_URL" "$HYPERLIGHT_WASM_AOT_GIT_REV"
  else
    install_exact hyperlight-wasm-aot hyperlight-wasm-aot "$HYPERLIGHT_WASM_AOT_VERSION"
  fi

  if [[ -n $COMPONENTIZE_QJS_GIT_REV ]]; then
    install_git componentize-qjs-cli "$COMPONENTIZE_QJS_GIT_URL" "$COMPONENTIZE_QJS_GIT_REV" --no-default-features
  elif command -v componentize-qjs &>/dev/null && grep -q "componentize-qjs-cli $COMPONENTIZE_QJS_VERSION" "${CARGO_HOME:-$HOME/.cargo}/.crates2.json"; then
    echo "componentize-qjs $COMPONENTIZE_QJS_VERSION already available"
  else
    echo "Installing componentize-qjs-cli $COMPONENTIZE_QJS_VERSION..."
    cargo install "componentize-qjs-cli@$COMPONENTIZE_QJS_VERSION" --locked --force --no-default-features
  fi

  install_exact cargo-hyperlight cargo-hyperlight "$CARGO_HYPERLIGHT_VERSION"
fi

install_exact oha oha "$OHA_VERSION"