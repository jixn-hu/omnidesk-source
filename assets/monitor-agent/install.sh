#!/bin/sh
# Receives no credentials in arguments. The protected staging directory contains agent.json.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
stage=$1
expected=$2
reset_state=${3:-0}
case "$reset_state" in 0|1) ;; *) exit 41 ;; esac
case "$stage" in /tmp/omnidesk-monitor-install-*) ;; *) exit 41 ;; esac
[ "$(id -u)" = 0 ] || exit 42
[ -d /run/systemd/system ] || exit 43
printf '%s  %s\n' "$expected" "$stage/agent" | sha256sum -c - >/dev/null || exit 44
config=/etc/omnidesk-monitor-agent/agent.json
binary=/usr/local/bin/omnidesk-monitor-agent
unit=/etc/systemd/system/omnidesk-monitor-agent.service
state=/var/lib/omnidesk-monitor-agent
service=omnidesk-monitor-agent.service
user=omnidesk-monitor-agent
# Do not replace symlinks or an unrelated manual installation.
for path in /etc/omnidesk-monitor-agent "$config" "$binary" "$binary.new" "$unit" "$state" "$state/state.json"; do
  [ ! -L "$path" ] || exit 45
done
[ ! -e /etc/omnidesk-monitor/agent.json ] || exit 46
if [ -e "$unit" ]; then
  grep -qx '# Managed by OmniDesk SSH installer v1' "$unit" || exit 46
else
  [ ! -e "$binary" ] && [ ! -e "$config" ] && [ ! -e "$state/state.json" ] || exit 46
  ! systemctl cat "$service" >/dev/null 2>&1 || exit 46
fi
[ -e "$config" ] || [ ! -e "$state/state.json" ] || exit 46
backup=/var/backups/omnidesk-monitor-agent/$(basename "$stage")
install -d -m 0700 "$backup"
old_config=0; old_binary=0; old_unit=0; old_active=0; old_enabled=0
if [ -e "$config" ]; then cp -p "$config" "$backup/agent.json"; old_config=1; fi
if [ -e "$binary" ]; then cp -p "$binary" "$backup/agent"; old_binary=1; fi
if [ -e "$unit" ]; then cp -p "$unit" "$backup/agent.service"; old_unit=1; fi
systemctl is-active --quiet "$service" && old_active=1 || :
systemctl is-enabled --quiet "$service" && old_enabled=1 || :
changed=0
state_replaced=0
old_state=0
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$result" -ne 0 ] && [ "$changed" = 1 ]; then
    systemctl stop "$service" >/dev/null 2>&1 || :
    systemctl disable "$service" >/dev/null 2>&1 || :
    if [ "$state_replaced" = 1 ]; then
      if [ "$old_state" = 1 ]; then cp -p "$backup/state.json" "$state/state.json"; else rm -f "$state/state.json"; fi
    fi
    if [ "$old_config" = 1 ]; then cp -p "$backup/agent.json" "$config"; else rm -f "$config"; fi
    if [ "$old_binary" = 1 ]; then cp -p "$backup/agent" "$binary"; else rm -f "$binary"; fi
    if [ "$old_unit" = 1 ]; then cp -p "$backup/agent.service" "$unit"; else rm -f "$unit"; fi
    systemctl daemon-reload >/dev/null 2>&1 || :
    if [ "$old_enabled" = 1 ]; then systemctl enable "$service" >/dev/null 2>&1 || :; fi
    if [ "$old_active" = 1 ]; then systemctl start "$service" >/dev/null 2>&1 || :; fi
    printf 'OMNIDESK_INSTALL_ROLLED_BACK\n'
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 47' HUP INT TERM
# The dedicated account has no login shell. Existing accounts are never modified.
if ! id "$user" >/dev/null 2>&1; then useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /bin/false "$user"; fi
changed=1
if [ "$old_active" = 1 ]; then systemctl stop "$service"; fi
if [ "$reset_state" = 1 ]; then
  if [ -e "$state/state.json" ]; then cp -p "$state/state.json" "$backup/state.json"; old_state=1; fi
  state_replaced=1
  rm -f "$state/state.json"
fi
install -d -m 0700 -o "$user" -g "$user" /etc/omnidesk-monitor-agent
install -d -m 0700 -o "$user" -g "$user" "$state"
install -m 0600 -o "$user" -g "$user" "$stage/agent.json" "$config"
# Replace the executable via rename so an existing process cannot cause ETXTBSY.
install -m 0755 -o root -g root "$stage/agent" "$binary.new"
mv -f "$binary.new" "$binary"
cat > "$unit" <<'UNIT'
# Managed by OmniDesk SSH installer v1
[Unit]
Description=OmniDesk monitoring collector
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=omnidesk-monitor-agent
Group=omnidesk-monitor-agent
ExecStart=/usr/local/bin/omnidesk-monitor-agent -config /etc/omnidesk-monitor-agent/agent.json
Restart=on-failure
RestartSec=5
StateDirectory=omnidesk-monitor-agent
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$unit"
systemctl daemon-reload
systemctl enable "$service" >/dev/null
systemctl restart "$service"
systemctl is-active --quiet "$service"
printf 'OMNIDESK_INSTALL_OK\n'
