#!/usr/bin/env bash
# =========================================================
# Fynd — the one way Fynd talks to Rakuten's Product Catalog SFTP server
#
#   rakuten-sftp.sh list  [<directory>]                 a directory listing
#   rakuten-sftp.sh fetch <remote file> <local file> [<max bytes>]
#                                                       a file, or its first
#                                                       <max bytes> (a sample)
#
# Environment (checked first by scripts/rakuten-preflight.js):
#   RAKUTEN_SFTP_HOST, RAKUTEN_SFTP_PORT (default 22)
#   RAKUTEN_SFTP_USER, RAKUTEN_SFTP_PASSWORD           never printed
#   RAKUTEN_SFTP_HOSTKEY_SHA256                         the server's fingerprint,
#                                                       from Rakuten
#
# The server's identity: curl as Ubuntu ships it (libssh) checks the host
# key only against ~/.ssh/known_hosts and ignores --hostpubsha256 — tried
# against a local server, a wrong --hostpubsha256 still connected. So the
# server's keys are read with ssh-keyscan, only a key whose SHA-256
# fingerprint equals RAKUTEN_SFTP_HOSTKEY_SHA256 is written to a
# known_hosts file of this run's own, and curl runs with that as its only
# trust. A server presenting any other key is refused before a password
# is sent.
#
# The credential goes to curl in a config file readable only by this user
# (never on a command line), and everything this writes outside the
# output file is removed on exit. Paths are plain: letters, digits,
# . _ - and /, no "..".
# =========================================================

set -euo pipefail
umask 077

die() { echo "rakuten-sftp: $1" >&2; exit "${2:-1}"; }

for v in RAKUTEN_SFTP_HOST RAKUTEN_SFTP_USER RAKUTEN_SFTP_PASSWORD RAKUTEN_SFTP_HOSTKEY_SHA256; do
  [ -n "${!v:-}" ] || die "$v is not set. Run scripts/rakuten-preflight.js first." 2
done
host="$RAKUTEN_SFTP_HOST"
port="${RAKUTEN_SFTP_PORT:-22}"
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || die "RAKUTEN_SFTP_HOST isn't a host name." 2
[[ "$port" =~ ^[0-9]{1,5}$ ]] || die "RAKUTEN_SFTP_PORT isn't a port." 2

plain_path() { [[ "$1" =~ ^[A-Za-z0-9._/~-]*$ && "$1" != *..* ]]; }
# a path as the URL carries it: "/x" from the server's root, "/~/x" from
# the login directory (what an SFTP client shows on connecting)
url_path() { if [[ "$1" == "~/"* ]]; then printf '/%s' "$1"; elif [[ "$1" == /* ]]; then printf '%s' "$1"; else printf '/%s' "$1"; fi; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home/.ssh"

# --- the server's key, accepted only by its fingerprint ---
want="${RAKUTEN_SFTP_HOSTKEY_SHA256#SHA256:}"
while [[ "$want" == *= ]]; do want="${want%=}"; done
want="SHA256:$want"
ssh-keyscan -T 15 -p "$port" "$host" 2>/dev/null > "$work/scanned" || true
[ -s "$work/scanned" ] || die "The server at $host:$port didn't present a host key (unreachable, or not an SSH server)." 3
seen=()
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  printf '%s\n' "$line" > "$work/one"
  fp="$(ssh-keygen -lf "$work/one" -E sha256 2>/dev/null | awk '{print $2}')" || continue
  seen+=("$fp")
  if [ "$fp" = "$want" ]; then printf '%s\n' "$line" >> "$work/home/.ssh/known_hosts"; fi
done < "$work/scanned"
if [ ! -s "$work/home/.ssh/known_hosts" ]; then
  echo "rakuten-sftp: no host key presented by $host:$port matches RAKUTEN_SFTP_HOSTKEY_SHA256 ($want)." >&2
  echo "rakuten-sftp: the server presented: ${seen[*]:-none}. Nothing was sent to it. Confirm the fingerprint with Rakuten." >&2
  exit 4
fi

# --- the credential, in a file only this user can read ---
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
printf 'user = "%s:%s"\n' "$(esc "$RAKUTEN_SFTP_USER")" "$(esc "$RAKUTEN_SFTP_PASSWORD")" > "$work/curl.cfg"

sftp_curl() {
  # -q first: no ~/.curlrc; HOME is this run's own, so is known_hosts
  HOME="$work/home" curl -q --fail --silent --show-error --proto '=sftp' \
    --connect-timeout 20 -K "$work/curl.cfg" "$@"
}

case "${1:-}" in
  list)
    dir="${2:-/}"
    plain_path "$dir" || die "Not a plain directory path: $dir" 2
    [[ "$dir" == */ ]] || dir="$dir/"
    sftp_curl --max-time 60 "sftp://$host:$port$(url_path "$dir")"
    ;;
  fetch)
    remote="${2:-}"; out="${3:-}"; max="${4:-}"
    [ -n "$remote" ] && [ -n "$out" ] || die "Usage: rakuten-sftp.sh fetch <remote file> <local file> [<max bytes>]" 2
    plain_path "$remote" && [[ "$remote" != */ ]] || die "Not a plain file path: $remote" 2
    range=()
    if [ -n "$max" ]; then
      [[ "$max" =~ ^[0-9]{1,10}$ && "$max" -gt 0 ]] || die "max bytes must be a positive number" 2
      range=(--range "0-$((max - 1))")
    fi
    sftp_curl --max-time 900 "${range[@]}" -o "$out" "sftp://$host:$port$(url_path "$remote")"
    echo "Fetched $(wc -c < "$out" | tr -d ' ') bytes of $remote${max:+ (at most $max: a sample)}."
    ;;
  *)
    die "Usage: rakuten-sftp.sh list [<directory>] | fetch <remote file> <local file> [<max bytes>]" 2
    ;;
esac
