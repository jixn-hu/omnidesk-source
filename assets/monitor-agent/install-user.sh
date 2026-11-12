#!/bin/sh
# All files and processes belong to the connected SSH user. No privilege changes.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
stage=$1
expected=$2
reset_state=${3:-0}
case "$stage" in /tmp/omnidesk-monitor-install-*) ;; *) exit 41 ;; esac
case "$reset_state" in 0|1) ;; *) exit 41 ;; esac
printf '%s  %s\n' "$expected" "$stage/agent" | sha256sum -c - >/dev/null || exit 44
base="$HOME/.local/share/omnidesk-monitor-agent"
unit_dir="$HOME/.config/systemd/user"
unit="$unit_dir/omnidesk-monitor-agent.service"
service=omnidesk-monitor-agent.service
marker='# Managed by OmniDesk user installer v1'
cron_marker='# OmniDesk user collector v1'
for path in "$HOME/.local" "$HOME/.local/share" "$HOME/.config" "$HOME/.config/systemd" "$unit_dir" "$unit" "$base" "$base/managed" "$base/agent" "$base/agent.new" "$base/agent.json" "$base/state.json" "$base/run.sh" "$base/start.sh" "$base/mode" "$base/run.pid" "$base/agent.pid" "$base/run.lock" "$base/install.lock" "$base/agent.log" "$base/backups"; do
  [ ! -L "$path" ] || exit 45
done
# Protect both the system scope and any unrecognized user installation.
[ ! -e /etc/omnidesk-monitor-agent ] && [ ! -e /usr/local/bin/omnidesk-monitor-agent ] && [ ! -e /etc/omnidesk-monitor/agent.json ] || exit 46
if [ -e "$base" ]; then
  [ -f "$base/managed" ] && grep -qx "$marker" "$base/managed" || exit 46
fi
if [ -e "$unit" ]; then grep -qx "$marker" "$unit" || exit 46; fi
install -d -m 0700 "$base"
printf '%s\n' "$marker" > "$base/managed"
exec 8>"$base/install.lock"
flock -n 8 || exit 48
install -d -m 0700 "$base/backups"
backup="$base/backups/$(basename "$stage")"
mkdir -m 0700 "$backup"
for file in agent agent.json start.sh run.sh mode; do
  if [ -e "$base/$file" ]; then [ -f "$base/$file" ] || exit 45; cp -p "$base/$file" "$backup/$file"; fi
done
if [ -e "$unit" ]; then cp -p "$unit" "$backup/agent.service"; fi
user_manager=0
systemctl --user show-environment >/dev/null 2>&1 && user_manager=1 || :
startup=none
if [ "$user_manager" = 1 ] && [ "$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null || :)" = yes ]; then startup=user-systemd; fi
# An existing unit must be controllable before another runner can replace it.
[ ! -e "$unit" ] || [ "$user_manager" = 1 ] || exit 49
old_active=0; old_enabled=0; changed=0; cron_changed=0; state_changed=0; old_config=0
[ ! -e "$backup/agent.json" ] || old_config=1
if [ -f "$base/start.sh" ]; then sh "$base/start.sh" status && old_active=1 || :; fi
if [ "$user_manager" = 1 ]; then systemctl --user is-enabled --quiet "$service" && old_enabled=1 || :; fi
cron_read=0
if command -v crontab >/dev/null; then
  if LC_ALL=C crontab -l > "$backup/crontab" 2> "$backup/cron-error"; then cron_read=1
  elif grep -q 'no crontab for' "$backup/cron-error"; then cron_read=1; fi
fi
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$result" -ne 0 ] && [ "$changed" = 1 ]; then
    sh "$base/start.sh" stop >/dev/null 2>&1
    if [ "$user_manager" = 1 ]; then systemctl --user disable --now "$service" >/dev/null 2>&1; fi
    for file in agent agent.json start.sh run.sh mode; do
      if [ -e "$backup/$file" ]; then
        cp -p "$backup/$file" "$base/$file.restore"
        mv -f "$base/$file.restore" "$base/$file"
      else rm -f "$base/$file"; fi
    done
    if [ "$state_changed" = 1 ]; then
      if [ -e "$backup/state.json" ]; then cp -p "$backup/state.json" "$base/state.json"; else rm -f "$base/state.json"; fi
    elif [ "$old_config" = 0 ]; then rm -f "$base/state.json"; fi
    if [ -e "$backup/agent.service" ]; then cp -p "$backup/agent.service" "$unit"; else rm -f "$unit"; fi
    if [ "$cron_changed" = 1 ]; then
      crontab -l > "$backup/cron-current" 2>/dev/null
      sed '\|# OmniDesk user collector v1$|d' "$backup/cron-current" > "$backup/cron-restore"
      grep '# OmniDesk user collector v1$' "$backup/crontab" >> "$backup/cron-restore"
      crontab "$backup/cron-restore"
    fi
    if [ "$user_manager" = 1 ]; then
      systemctl --user daemon-reload >/dev/null 2>&1
      if [ "$old_enabled" = 1 ]; then systemctl --user enable "$service" >/dev/null 2>&1; fi
    fi
    if [ "$old_active" = 1 ]; then sh "$base/start.sh" >/dev/null 2>&1; fi
    printf 'OMNIDESK_INSTALL_ROLLED_BACK\n'
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 47' HUP INT TERM
changed=1
if [ -f "$base/start.sh" ]; then sh "$base/start.sh" stop; fi
if [ -e "$unit" ]; then systemctl --user disable --now "$service" >/dev/null; fi
if [ "$reset_state" = 1 ]; then
  if [ -e "$base/state.json" ]; then cp -p "$base/state.json" "$backup/state.json"; fi
  state_changed=1
  rm -f "$base/state.json"
fi
install -m 0755 "$stage/agent" "$base/agent.new"
mv -f "$base/agent.new" "$base/agent"
install -m 0600 "$stage/agent.json" "$base/agent.json"
cat > "$base/run.sh" <<'RUN'
#!/bin/sh
umask 077
base=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec 9>"$base/run.lock"
flock -n 9 || exit 0
printf '%s\n' "$$" > "$base/run.pid"
child=
trap 'trap - HUP INT TERM; [ -z "$child" ] || kill "$child" 2>/dev/null; [ -z "$child" ] || wait "$child" 2>/dev/null; rm -f "$base/run.pid" "$base/agent.pid"; exit 0' HUP INT TERM
while :; do
  "$base/agent" -config "$base/agent.json" >> "$base/agent.log" 2>&1 8>&- 9>&- &
  child=$!
  printf '%s\n' "$child" > "$base/agent.pid"
  wait "$child" || :
  sleep 5 &
  child=$!
  wait "$child" || :
  child=
done
RUN
cat > "$base/start.sh" <<'START'
#!/bin/sh
umask 077
base=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
runner() {
  [ -f "$base/run.pid" ] || return 1
  pid=$(cat "$base/run.pid")
  case "$pid" in ''|*[!0-9]*|0|1) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null && tr '\000' '\n' < "/proc/$pid/cmdline" | grep -Fx "$base/run.sh" >/dev/null
}
agent() {
  [ -f "$base/agent.pid" ] || return 1
  apid=$(cat "$base/agent.pid")
  case "$apid" in ''|*[!0-9]*|0|1) return 1 ;; esac
  [ "$(readlink "/proc/$apid/exe" 2>/dev/null)" = "$base/agent" ] && kill -0 "$apid" 2>/dev/null
}
mode=$(cat "$base/mode" 2>/dev/null)
case "${1:-start}" in
  status)
    if [ "$mode" = user-systemd ]; then systemctl --user is-active --quiet omnidesk-monitor-agent.service
    else runner && agent; fi ;;
  stop)
    if [ "$mode" = user-systemd ]; then systemctl --user stop omnidesk-monitor-agent.service || exit 1; fi
    if runner; then
      kill "$pid" || exit 1
      tries=0
      while kill -0 "$pid" 2>/dev/null && [ "$tries" -lt 30 ]; do sleep 0.1; tries=$((tries+1)); done
      if runner; then exit 1; fi
    fi
    if agent; then kill "$apid" || exit 1; fi
    flock -w 3 "$base/run.lock" true || exit 1 ;;
  start)
    if [ "$mode" = user-systemd ]; then exec systemctl --user start omnidesk-monitor-agent.service; fi
    if runner; then exit 0; fi
    nohup sh "$base/run.sh" </dev/null >/dev/null 2>&1 8>&- &
    ;;
  *) exit 1 ;;
esac
START
chmod 0700 "$base/run.sh" "$base/start.sh"
# Remove only our managed cron entry; keep unrelated jobs, including during rollback.
if [ "$cron_read" = 1 ]; then
  sed '\|# OmniDesk user collector v1$|d' "$backup/crontab" > "$backup/cron-new"
  if [ "$startup" != user-systemd ]; then
    printf '%s\n' '@reboot sh "$HOME/.local/share/omnidesk-monitor-agent/start.sh" # OmniDesk user collector v1' >> "$backup/cron-new"
  fi
  if crontab "$backup/cron-new" 2>/dev/null; then
    cron_changed=1
    if [ "$startup" != user-systemd ]; then startup=cron; fi
  else
    # Do not claim boot persistence when this user cannot write a crontab.
    if grep -q '# OmniDesk user collector v1$' "$backup/crontab"; then exit 50; fi
  fi
fi
printf '%s\n' "$startup" > "$base/mode"
if [ "$startup" = user-systemd ]; then
  install -d -m 0700 "$unit_dir"
  # systemd expands %h without requiring shell escaping of arbitrary home paths.
  cat > "$unit" <<'UNIT'
# Managed by OmniDesk user installer v1
[Unit]
Description=OmniDesk monitoring collector (current user)
[Service]
ExecStart="%h/.local/share/omnidesk-monitor-agent/agent" -config "%h/.local/share/omnidesk-monitor-agent/agent.json"
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=default.target
UNIT
  chmod 0600 "$unit"
  systemctl --user daemon-reload
  systemctl --user enable --now "$service" >/dev/null
else
  if [ -e "$unit" ]; then rm -f "$unit"; systemctl --user daemon-reload; fi
  sh "$base/start.sh" 8>&-
fi
sleep 1
sh "$base/start.sh" status || exit 51
printf 'OMNIDESK_STARTUP=%s\nOMNIDESK_INSTALL_OK\n' "$startup"
