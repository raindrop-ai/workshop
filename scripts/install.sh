#!/usr/bin/env bash
# install.sh — installs `raindrop` into ~/.raindrop/bin/raindrop.
#
# Pulled by users via:
#   curl -fsSL https://raw.githubusercontent.com/raindrop-ai/workshop/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/raindrop-ai/workshop/main/install.sh | bash -s -- --channel=beta
# (Once we own a brand-aligned domain, the URL above will move.)
#
# Naming: the binary is `raindrop` because it's the umbrella CLI for raindrop
# tooling. The local-debugger product underneath is `workshop`, accessed via
# `raindrop workshop <verb>`. Today workshop is the only product, but the
# install path is forward-compatible with multi-product raindrop tooling.
#
# Design notes (mirrors docs/specs/2026-04-29-packaging-design.md):
#   - Reads the manifest from $RAINDROP_MANIFEST_URL
#     (default: raw.githubusercontent.com/raindrop-ai/workshop/main/latest.json)
#   - Picks the entry for $RAINDROP_CHANNEL (default stable)
#   - Downloads the platform-appropriate binary to a temp file
#   - Verifies sha256 against the manifest
#   - Atomically renames into ~/.raindrop/bin/raindrop
#   - Persists ~/.raindrop/bin onto PATH for future terminals.
#   - Runs the installed binary's `setup` command directly so setup is one
#     linear flow from curl to IDE wiring.
#   - Critically: uses curl, NOT a browser/AirDrop/email — so the binary
#     does NOT carry the com.apple.quarantine xattr, so Gatekeeper does not
#     enforce notarization. Ad-hoc signing alone is sufficient.

set -euo pipefail

# Output style
# Default output is a product-shaped installer: a few clear steps, followed by
# the installed binary's own setup flow. Raw URLs, hashes, and platform keys are kept for
# --verbose so users can debug without everyone staring at manifest guts.
RAINDROP_VERBOSE="${RAINDROP_VERBOSE:-0}"
RAINDROP_QUIET="${RAINDROP_QUIET:-0}"
if [ -n "${NO_COLOR:-}" ]; then
  RAINDROP_NO_COLOR="${RAINDROP_NO_COLOR:-1}"
else
  RAINDROP_NO_COLOR="${RAINDROP_NO_COLOR:-0}"
fi

C_BLUE=""; C_GREEN=""; C_RED=""; C_DIM=""; C_BOLD=""; C_RESET=""

configure_colors() {
  if [ "$RAINDROP_NO_COLOR" = "1" ] || [ ! -t 1 ]; then
    C_BLUE=""; C_GREEN=""; C_RED=""; C_DIM=""; C_BOLD=""; C_RESET=""
    return
  fi
  C_BLUE=$'\033[38;5;111m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_DIM=$'\033[2;37m'
  C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'
}

log() {
  if [ "$RAINDROP_VERBOSE" = "1" ] && [ "$RAINDROP_QUIET" != "1" ]; then
    printf '%s%s%s\n' "$C_DIM" "[install] $*" "$C_RESET" >&2
  fi
}

err() { printf '[install] %s\n' "$*" >&2; }

print_intro() {
  if [ "$RAINDROP_QUIET" = "1" ]; then return; fi
  echo ""
  printf '%s◆%s %sInstalling Raindrop%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  echo ""
}

step_start() {
  if [ "$RAINDROP_QUIET" = "1" ]; then return; fi
  printf '%s◇%s %s\n\n' "$C_BLUE" "$C_RESET" "$1"
}

step_done() {
  if [ "$RAINDROP_QUIET" = "1" ]; then return; fi
  printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"
  echo ""
}

step_fail() {
  if [ "$RAINDROP_QUIET" = "1" ]; then return; fi
  printf '%s✕%s %s\n' "$C_RED" "$C_RESET" "$1"
  echo ""
}

note() {
  if [ "$RAINDROP_QUIET" = "1" ]; then return; fi
  printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"
}

run_with_spinner() {
  local label="$1"
  local success="$2"
  shift 2

  if [ "$RAINDROP_QUIET" = "1" ]; then
    "$@"
    return $?
  fi

  if [ "$RAINDROP_VERBOSE" != "1" ]; then
    local frames=( "⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏" )
    local i=0
    "$@" &
    local pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ -t 1 ]; then
        printf '\r%s%s%s %s' "$C_BLUE" "${frames[$((i % ${#frames[@]}))]}" "$C_RESET" "$label"
      elif [ "$i" -eq 0 ]; then
        printf '%s◇%s %s\n' "$C_BLUE" "$C_RESET" "$label"
      fi
      i=$((i + 1))
      sleep 0.1
    done
    local status=0
    wait "$pid" || status=$?
    if [ -t 1 ]; then
      printf '\r\033[K'
    fi
    if [ "$status" -eq 0 ]; then
      step_done "$success"
    else
      step_fail "$label"
    fi
    return "$status"
  fi

  step_start "$label"
  if "$@"; then
    step_done "$success"
    return 0
  fi
  step_fail "$label"
  return 1
}

run_dynamic_spinner() {
  local label="$1"
  local success_fn="$2"
  shift 2

  if [ "$RAINDROP_QUIET" = "1" ]; then
    "$@"
    return $?
  fi

  if [ "$RAINDROP_VERBOSE" != "1" ]; then
    if [ -t 1 ]; then
      printf '\r%s⠋%s %s' "$C_BLUE" "$C_RESET" "$label"
    else
      printf '%s◇%s %s\n' "$C_BLUE" "$C_RESET" "$label"
    fi
    local status=0
    "$@" || status=$?
    if [ -t 1 ]; then
      printf '\r\033[K'
    fi
    if [ "$status" -eq 0 ]; then
      step_done "$("$success_fn")"
    else
      step_fail "$label"
    fi
    return "$status"
  fi

  step_start "$label"
  if "$@"; then
    step_done "$("$success_fn")"
    return 0
  fi
  step_fail "$label"
  return 1
}

is_uint() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

format_bytes() {
  local bytes="${1:-0}"
  if ! is_uint "$bytes"; then
    bytes=0
  fi
  bytes=$((10#$bytes))

  if [ "$bytes" -ge 1048576 ]; then
    printf '%d.%01d MB' "$((bytes / 1048576))" "$(((bytes % 1048576) * 10 / 1048576))"
  elif [ "$bytes" -ge 1024 ]; then
    printf '%d.%01d KB' "$((bytes / 1024))" "$(((bytes % 1024) * 10 / 1024))"
  else
    printf '%d B' "$bytes"
  fi
}

render_download_progress() {
  local label="$1"
  local current="$2"
  local total="$3"

  if ! is_uint "$current"; then current=0; fi
  if ! is_uint "$total"; then return 1; fi

  current=$((10#$current))
  total=$((10#$total))
  if [ "$total" -le 0 ]; then return 1; fi
  if [ "$current" -gt "$total" ]; then current="$total"; fi

  local width=24
  local percent=$((current * 100 / total))
  local filled=$((current * width / total))
  local empty=$((width - filled))
  local bar=""
  local blank=""
  local i

  for ((i = 0; i < filled; i++)); do bar="${bar}█"; done
  for ((i = 0; i < empty; i++)); do blank="${blank}░"; done

  printf '\r%s↧%s %s %3d%% %s[%s%s]%s %s / %s' \
    "$C_BLUE" "$C_RESET" "$label" "$percent" "$C_BLUE" "$bar" "$blank" "$C_RESET" \
    "$(format_bytes "$current")" "$(format_bytes "$total")"
}

run_download_progress() {
  local label="$1"
  local success="$2"
  local url="$3"
  local out="$4"
  local total="$5"

  if [ "$RAINDROP_QUIET" = "1" ]; then
    fetch "$url" "$out"
    return $?
  fi

  if [ "$RAINDROP_VERBOSE" = "1" ] || [ ! -t 1 ] || ! is_uint "$total" || [ "$((10#$total))" -le 0 ]; then
    run_with_spinner "$label" "$success" fetch "$url" "$out"
    return $?
  fi

  render_download_progress "$label" 0 "$total"
  fetch "$url" "$out" &
  local pid=$!
  local status=0

  while kill -0 "$pid" 2>/dev/null; do
    local current=0
    if [ -f "$out" ]; then
      current=$(wc -c < "$out" | tr -d ' ')
    fi
    render_download_progress "$label" "$current" "$total"
    sleep 0.1
  done

  wait "$pid" || status=$?
  if [ -t 1 ]; then
    printf '\r\033[K'
  fi
  if [ "$status" -eq 0 ]; then
    step_done "$success"
  else
    step_fail "$label"
  fi
  return "$status"
}

# RAINDROP_SKIP_SETUP / --no-setup skip the automatic IDE setup command after
# download. This is mainly for local installer smoke tests and scripted binary
# installs that only want the executable on disk. Accept the older init name
# too so existing scripted installs do not suddenly start touching IDE config.
RAINDROP_NO_SETUP="${RAINDROP_SKIP_SETUP:-${RAINDROP_SKIP_INIT:-0}}"

# Install "mode" — derives intent from WHERE the user copied the command:
#   workshop site one-liner  -> default: `raindrop setup` (local debugger + daemon)
#   onboarding one-liner     -> --cloud: `raindrop cloud setup` (hosted MCP +
#                               cloud skills, write key in ./.env, NO daemon)
# Same binary, same installer; only the post-install command differs.
RAINDROP_CLOUD="${RAINDROP_CLOUD:-0}"

# Track whether the channel was set explicitly (env var or --channel flag).
# If the user took the default and it turns out the manifest has no entry
# for that channel (e.g. early-stage repo with only betas published), we
# fall back to beta with a clear message instead of failing dead. Explicit
# requests still fail loud — if a customer asked for stable and we don't
# have one, that's a real signal, not something to paper over.
if [ -n "${RAINDROP_CHANNEL+x}" ]; then
  RAINDROP_CHANNEL_EXPLICIT=1
else
  RAINDROP_CHANNEL_EXPLICIT=0
fi
RAINDROP_CHANNEL="${RAINDROP_CHANNEL:-stable}"
# Manifest URL: served from main of the releases repo via raw.githubusercontent.
# release.yml commits a fresh latest.json there on every release, so this URL
# always works regardless of channel/prerelease semantics.
RAINDROP_MANIFEST_URL="${RAINDROP_MANIFEST_URL:-https://raw.githubusercontent.com/raindrop-ai/workshop/main/latest.json}"
RAINDROP_INSTALL_DIR="${RAINDROP_INSTALL_DIR:-$HOME/.raindrop/bin}"

while [ $# -gt 0 ]; do
  case "$1" in
    --channel=*) RAINDROP_CHANNEL="${1#*=}"; RAINDROP_CHANNEL_EXPLICIT=1 ;;
    --channel) shift; RAINDROP_CHANNEL="$1"; RAINDROP_CHANNEL_EXPLICIT=1 ;;
    --manifest=*) RAINDROP_MANIFEST_URL="${1#*=}" ;;
    --manifest) shift; RAINDROP_MANIFEST_URL="$1" ;;
    --install-dir=*) RAINDROP_INSTALL_DIR="${1#*=}" ;;
    --install-dir) shift; RAINDROP_INSTALL_DIR="$1" ;;
    --verbose) RAINDROP_VERBOSE=1 ;;
    --quiet) RAINDROP_QUIET=1 ;;
    --no-color) RAINDROP_NO_COLOR=1 ;;
    --no-setup|--no-init) RAINDROP_NO_SETUP=1 ;;
    --cloud) RAINDROP_CLOUD=1 ;;
    -h|--help)
      cat <<'USAGE'
Usage: install.sh [--channel=stable|beta] [--manifest=URL] [--install-dir=DIR] [--cloud] [--verbose] [--quiet] [--no-color] [--no-setup]

Environment overrides:
  RAINDROP_CHANNEL         stable | beta            (default: stable)
  RAINDROP_MANIFEST_URL    URL of latest.json
                           (default: https://raw.githubusercontent.com/raindrop-ai/workshop/main/latest.json)
  RAINDROP_INSTALL_DIR     install dir              (default: ~/.raindrop/bin)
  RAINDROP_SKIP_SETUP      1 to skip automatic setup
  RAINDROP_CLOUD           1 to run `raindrop cloud setup` instead of `setup`
  RAINDROP_VERBOSE         1 to print URLs, hashes, and platform details
  RAINDROP_QUIET           1 to suppress success output
  NO_COLOR                 disable ANSI color

install.sh downloads, sha256-verifies, installs the `raindrop`
binary, adds it to PATH for new terminals, then runs `raindrop setup`.

  --verbose shows release URLs, platform keys, and checksums.
  --quiet suppresses progress and success output, but still prints errors.
  --no-color disables ANSI color.

  --no-setup / RAINDROP_SKIP_SETUP=1 skip automatic `raindrop setup`.
  --no-init / RAINDROP_SKIP_INIT=1 are accepted as old names for --no-setup.

  --cloud / RAINDROP_CLOUD=1 connect this project to Raindrop cloud instead of
  the local debugger: runs `raindrop cloud setup` (signs in, writes the write
  key to ./.env, installs the hosted MCP + cloud skills) and does NOT start a
  daemon. Use this for the onboarding one-liner.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
  shift
done

configure_colors

if [ "$RAINDROP_CHANNEL" != "stable" ] && [ "$RAINDROP_CHANNEL" != "beta" ]; then
  echo "Invalid channel: $RAINDROP_CHANNEL (expected stable|beta)" >&2
  exit 2
fi

# Detect platform
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

platform_label() {
  case "$1" in
    darwin-arm64) echo "macOS Apple Silicon" ;;
    darwin-x64) echo "macOS Intel" ;;
    linux-x64) echo "Linux x64" ;;
    linux-arm64) echo "Linux ARM64" ;;
    windows-x64) echo "Windows x64" ;;
    *) echo "$1" ;;
  esac
}

print_intro
detect_platform_step() {
  PLATFORM="$(detect_platform)"
}

platform_success() {
  platform_label "$PLATFORM"
}

if [ "$RAINDROP_VERBOSE" = "1" ]; then
  run_dynamic_spinner "Detecting platform" platform_success detect_platform_step
else
  detect_platform_step
fi
log "platform=$PLATFORM channel=$RAINDROP_CHANNEL"

# Tooling: prefer curl, fall back to wget
need() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  # fetch <url> <out-path>
  # Production: hard-pin to https + tls1.2+. Set RAINDROP_INSECURE_PROTO=1 only
  # in tests against a local HTTP server.
  if need curl; then
    if [ "${RAINDROP_INSECURE_PROTO:-0}" = "1" ]; then
      curl -fsSL -o "$2" "$1"
    else
      curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
    fi
  elif need wget; then
    wget -qO "$2" "$1"
  else
    echo "Need curl or wget" >&2
    exit 1
  fi
}

if ! need shasum && ! need sha256sum; then
  echo "Need shasum or sha256sum to verify download" >&2
  exit 1
fi

sha256_of() {
  if need sha256sum; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Read manifest
TMP_DIR="$(mktemp -d -t raindrop-install-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

MANIFEST="$TMP_DIR/manifest.json"
log "manifest=$RAINDROP_MANIFEST_URL"
if [ "$RAINDROP_VERBOSE" = "1" ]; then
  run_with_spinner "Fetching latest $RAINDROP_CHANNEL release" "Release manifest fetched" fetch "$RAINDROP_MANIFEST_URL" "$MANIFEST"
else
  fetch "$RAINDROP_MANIFEST_URL" "$MANIFEST"
fi

# Tiny JSON parser via python3 (preinstalled on macOS+most Linux).
# We parse two strings (url, sha256) and one int (size). No jq dep.
parse_field() {
  python3 - "$MANIFEST" "$RAINDROP_CHANNEL" "$PLATFORM" "$1" <<'PY'
import json, sys
manifest_path, channel, platform, field = sys.argv[1:5]
m = json.load(open(manifest_path))
value = (((m.get(channel) or {}).get("platforms") or {}).get(platform) or {})
for part in field.split("."):
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(part)
    if value is None:
        break
print(value or "")
PY
}

read_version() {
  python3 - "$MANIFEST" "$RAINDROP_CHANNEL" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
print((m.get(sys.argv[2]) or {}).get("version") or "")
PY
}

resolve_release() {
  VERSION="$(read_version)"
  URL="$(parse_field url)"
  EXPECTED_SHA="$(parse_field sha256)"
  EXPECTED_SIZE="$(parse_field size)"
  GZIP_URL="$(parse_field gzip.url)"
  EXPECTED_GZIP_SHA="$(parse_field gzip.sha256)"
  EXPECTED_GZIP_SIZE="$(parse_field gzip.size)"

  # Implicit-default fallback: if the user didn't ask for a specific channel
  # and the default (stable) has no entry for this platform, try beta before
  # bailing. Keeps `curl … | bash` working in early-stage projects that ship
  # only betas. See the RAINDROP_CHANNEL_EXPLICIT comment block above.
  if [ -z "$URL" ] || [ -z "$EXPECTED_SHA" ] || [ -z "$EXPECTED_SIZE" ]; then
    if [ "$RAINDROP_CHANNEL_EXPLICIT" = "0" ] && [ "$RAINDROP_CHANNEL" = "stable" ]; then
      note "No stable release is published yet; trying beta."
      log "no stable release published; falling back to beta channel"
      RAINDROP_CHANNEL=beta
      VERSION="$(read_version)"
      URL="$(parse_field url)"
      EXPECTED_SHA="$(parse_field sha256)"
      EXPECTED_SIZE="$(parse_field size)"
      GZIP_URL="$(parse_field gzip.url)"
      EXPECTED_GZIP_SHA="$(parse_field gzip.sha256)"
      EXPECTED_GZIP_SIZE="$(parse_field gzip.size)"
    fi
  fi

  if [ -z "$URL" ] || [ -z "$EXPECTED_SHA" ] || [ -z "$EXPECTED_SIZE" ]; then
    err "manifest missing entry for channel=$RAINDROP_CHANNEL platform=$PLATFORM"
    if [ "$RAINDROP_VERBOSE" != "1" ]; then
      err "re-run with --verbose to show manifest diagnostics"
    fi
    return 1
  fi

  DOWNLOAD_URL="$URL"
  DOWNLOAD_SHA="$EXPECTED_SHA"
  DOWNLOAD_SIZE="$EXPECTED_SIZE"
  DOWNLOAD_IS_GZIP=0
  if [ -n "$GZIP_URL" ] && [ -n "$EXPECTED_GZIP_SHA" ] && [ -n "$EXPECTED_GZIP_SIZE" ]; then
    if ! need gzip; then
      log "gzip metadata present but gzip command is unavailable; falling back to raw binary"
      return 0
    fi
    DOWNLOAD_URL="$GZIP_URL"
    DOWNLOAD_SHA="$EXPECTED_GZIP_SHA"
    DOWNLOAD_SIZE="$EXPECTED_GZIP_SIZE"
    DOWNLOAD_IS_GZIP=1
  elif [ -n "${GZIP_URL}${EXPECTED_GZIP_SHA}${EXPECTED_GZIP_SIZE}" ]; then
    log "ignoring incomplete gzip metadata; falling back to raw binary"
  fi
}

release_success() {
  echo "Raindrop $VERSION ($RAINDROP_CHANNEL)"
}

if [ "$RAINDROP_VERBOSE" = "1" ]; then
  run_dynamic_spinner "Resolving release" release_success resolve_release
else
  resolve_release
fi

log "version=$VERSION"
log "raw url=$URL"
log "raw expected sha256=$EXPECTED_SHA"
log "raw expected size=$EXPECTED_SIZE"
if [ "$DOWNLOAD_IS_GZIP" = "1" ]; then
  log "download url=$DOWNLOAD_URL (gzip)"
  log "download expected sha256=$DOWNLOAD_SHA"
  log "download expected size=$DOWNLOAD_SIZE"
else
  log "download url=$DOWNLOAD_URL"
fi

# Download + verify
DOWNLOAD="$TMP_DIR/raindrop"
DOWNLOAD_PAYLOAD="$TMP_DIR/raindrop.download"
run_download_progress "Downloading Raindrop" "Raindrop downloaded" "$DOWNLOAD_URL" "$DOWNLOAD_PAYLOAD" "$DOWNLOAD_SIZE"

verify_download() {
  ACTUAL_SHA="$(sha256_of "$DOWNLOAD_PAYLOAD")"
  if [ "$ACTUAL_SHA" != "$DOWNLOAD_SHA" ]; then
    err "sha256 mismatch: expected $DOWNLOAD_SHA got $ACTUAL_SHA"
    return 1
  fi
  log "actual download sha256=$ACTUAL_SHA"

  ACTUAL_SIZE=$(wc -c < "$DOWNLOAD_PAYLOAD" | tr -d ' ')
  if [ "$ACTUAL_SIZE" != "$DOWNLOAD_SIZE" ]; then
    err "size mismatch: expected $DOWNLOAD_SIZE got $ACTUAL_SIZE"
    return 1
  fi
  log "actual download size=$ACTUAL_SIZE"

  if [ "$DOWNLOAD_IS_GZIP" = "1" ]; then
    if ! gzip -dc "$DOWNLOAD_PAYLOAD" > "$DOWNLOAD"; then
      err "gzip decompression failed"
      return 1
    fi
  else
    mv -f "$DOWNLOAD_PAYLOAD" "$DOWNLOAD"
  fi

  ACTUAL_RAW_SHA="$(sha256_of "$DOWNLOAD")"
  if [ "$ACTUAL_RAW_SHA" != "$EXPECTED_SHA" ]; then
    err "sha256 mismatch after unpack: expected $EXPECTED_SHA got $ACTUAL_RAW_SHA"
    return 1
  fi
  log "actual raw sha256=$ACTUAL_RAW_SHA"

  ACTUAL_RAW_SIZE=$(wc -c < "$DOWNLOAD" | tr -d ' ')
  if [ "$ACTUAL_RAW_SIZE" != "$EXPECTED_SIZE" ]; then
    err "size mismatch after unpack: expected $EXPECTED_SIZE got $ACTUAL_RAW_SIZE"
    return 1
  fi
  log "actual raw size=$ACTUAL_RAW_SIZE"
}

checksum_success() {
  echo "Checksum verified"
}

if [ "$RAINDROP_VERBOSE" = "1" ]; then
  run_dynamic_spinner "Verifying download" checksum_success verify_download
else
  verify_download
fi

# Install atomically
DEST="$RAINDROP_INSTALL_DIR/raindrop"
if [ "$PLATFORM" = "windows-x64" ]; then
  DEST="${DEST}.exe"
fi

install_binary() {
  mkdir -p "$RAINDROP_INSTALL_DIR"
  chmod +x "$DOWNLOAD"

  # Atomic rename. If a previous binary exists, keep it as raindrop.prev for rollback.
  if [ -e "$DEST" ]; then
    mv -f "$DEST" "${DEST}.prev" || true
  fi
  mv -f "$DOWNLOAD" "$DEST"
  chmod +x "$DEST"
}

run_with_spinner "Installing binary" "Installed to $DEST" install_binary
log "installed: $DEST"

# Persist PATH for future terminals
# `curl ... | bash` runs in a child process, so it cannot mutate the user's
# already-open parent shell. We do the durable part here for future terminals.

path_literal_for_rc() {
  case "$RAINDROP_INSTALL_DIR" in
    "$HOME"/*) printf '$HOME/%s' "${RAINDROP_INSTALL_DIR#$HOME/}" ;;
    *)         printf '%s' "$RAINDROP_INSTALL_DIR" ;;
  esac
}

file_mentions_install_dir() {
  local file="$1"
  local literal="$2"
  [ -f "$file" ] || return 1
  case "$(cat "$file")" in
    *"$RAINDROP_INSTALL_DIR"*|*"$literal"*) return 0 ;;
    *) return 1 ;;
  esac
}

append_posix_path() {
  local file="$1"
  local literal="$2"
  mkdir -p "$(dirname "$file")"
  if file_mentions_install_dir "$file" "$literal"; then
    return 0
  fi
  {
    printf '\n# Added by Raindrop installer\n'
    printf 'export PATH="%s:$PATH"\n' "$literal"
    printf '# End Raindrop installer\n'
  } >> "$file"
}

append_fish_path() {
  local file="$1"
  local literal="$2"
  mkdir -p "$(dirname "$file")"
  if file_mentions_install_dir "$file" "$literal"; then
    return 0
  fi
  {
    printf '\n# Added by Raindrop installer\n'
    printf 'fish_add_path "%s"\n' "$literal"
    printf '# End Raindrop installer\n'
  } >> "$file"
}

configure_path() {
  local shell_name literal
  shell_name="$(basename "${SHELL:-bash}")"
  literal="$(path_literal_for_rc)"

  case "$shell_name" in
    fish)
      append_fish_path "$HOME/.config/fish/config.fish" "$literal"
      ;;
    zsh)
      append_posix_path "$HOME/.zshrc" "$literal"
      ;;
    bash)
      append_posix_path "$HOME/.bashrc" "$literal"
      ;;
    *)
      append_posix_path "$HOME/.profile" "$literal"
      ;;
  esac
}

path_success() {
  echo "PATH configured"
}

if [ "$RAINDROP_VERBOSE" = "1" ]; then
  run_dynamic_spinner "Configuring PATH" path_success configure_path
else
  configure_path
fi

case ":$PATH:" in
  *":$RAINDROP_INSTALL_DIR:"*) ;;
  *) export PATH="$RAINDROP_INSTALL_DIR:$PATH" ;;
esac

# IDE setup
run_agent_setup() {
  if [ "$RAINDROP_NO_SETUP" = "1" ]; then
    log "skipping automatic raindrop setup because RAINDROP_SKIP_SETUP=1 or --no-setup was set"
    return 0
  fi

  if [ "$RAINDROP_QUIET" != "1" ]; then
    echo ""
  fi
  # Derive the post-install command from the install mode. Cloud mode connects
  # to Raindrop cloud (no daemon); default mode is the local debugger setup.
  local -a setup_cmd
  if [ "$RAINDROP_CLOUD" = "1" ]; then
    setup_cmd=(cloud setup)
  else
    setup_cmd=(setup)
  fi

  if [ -t 0 ]; then
    "$DEST" "${setup_cmd[@]}"
  elif [ -r /dev/tty ] && [ -t 1 ]; then
    RAINDROP_SETUP_TTY=1 "$DEST" "${setup_cmd[@]}"
  else
    "$DEST" "${setup_cmd[@]}"
  fi
}

run_agent_setup
