#!/bin/sh
# Isolated filesystem and command fixture; it does not simulate Linux security or systemd itself.
set -eu
sandbox=$(cygpath -u "$1")
script=$(cygpath -u "$2")
mkdir -p "$sandbox/bin" "$sandbox/run/systemd/system" "$sandbox/usr/local/bin" "$sandbox/etc/systemd/system" "$sandbox/tmp"
export OMNIDESK_SCRIPT_TEST_ROOT="$sandbox"
cat > "$sandbox/bin/id" <<'MOCK'
#!/bin/sh
if [ "${1-}" = -u ]; then printf '0\n'; fi
exit 0
MOCK
cat > "$sandbox/bin/install" <<'MOCK'
#!/bin/sh
# The Windows filesystem cannot validate Unix account ownership.
if [ "${1-}" = -d ]; then
  shift
  mode=0755
  while [ "$#" -gt 0 ]; do
    case "$1" in -m) mode=$2; shift 2;; -o|-g) shift 2;; *) mkdir -p "$1"; chmod "$mode" "$1"; shift;; esac
  done
else
  mode=0755
  while [ "$#" -gt 0 ]; do
    case "$1" in -m) mode=$2; shift 2;; -o|-g) shift 2;; *) break;; esac
  done
  /usr/bin/install -m "$mode" "$@"
fi
MOCK
cat > "$sandbox/bin/systemctl" <<'MOCK'
#!/bin/sh
root=$OMNIDESK_SCRIPT_TEST_ROOT
case "$1" in
  cat) exit 1;;
  is-active) test -f "$root/active";;
  is-enabled) test -f "$root/enabled";;
  enable) touch "$root/enabled";;
  disable) rm -f "$root/enabled";;
  stop) rm -f "$root/active";;
  start) touch "$root/active";;
  restart) if [ -f "$root/fail-restart" ]; then rm "$root/fail-restart"; exit 1; fi; touch "$root/active";;
  daemon-reload) :;;
  *) exit 90;;
esac
MOCK
chmod +x "$sandbox/bin/"*
# Paths and PATH are rewritten by the Node launcher; all installer control flow is retained.
stage=$sandbox/tmp/omnidesk-monitor-install-fixture
mkdir "$stage"
printf 'agent-version-1' > "$stage/agent"
printf '{"fixture":1}' > "$stage/agent.json"
expected=$(sha256sum "$stage/agent" | cut -d ' ' -f 1)
# A failed first install must not leave an enabled service or new config/binary.
touch "$sandbox/fail-restart"
if sh "$script" "$stage" "$expected" > "$sandbox/first-failed.log" 2>&1; then exit 94; fi
grep -q OMNIDESK_INSTALL_ROLLED_BACK "$sandbox/first-failed.log"
[ ! -e "$sandbox/etc/systemd/system/omnidesk-monitor-agent.service" ]
[ ! -e "$sandbox/etc/omnidesk-monitor-agent/agent.json" ]
[ ! -e "$sandbox/usr/local/bin/omnidesk-monitor-agent" ]
[ ! -e "$sandbox/enabled" ] && [ ! -e "$sandbox/active" ]
sh "$script" "$stage" "$expected" > "$sandbox/first.log"
grep -q OMNIDESK_INSTALL_OK "$sandbox/first.log"
config=$sandbox/etc/omnidesk-monitor-agent/agent.json
binary=$sandbox/usr/local/bin/omnidesk-monitor-agent
unit=$sandbox/etc/systemd/system/omnidesk-monitor-agent.service
state=$sandbox/var/lib/omnidesk-monitor-agent/state.json
printf 'traffic-state-must-survive' > "$state"
cp "$config" "$sandbox/old-config"
cp "$unit" "$sandbox/old-unit"
printf 'agent-version-2' > "$stage/agent"
printf '{"fixture":2}' > "$stage/agent.json"
expected=$(sha256sum "$stage/agent" | cut -d ' ' -f 1)
touch "$sandbox/fail-restart"
if sh "$script" "$stage" "$expected" > "$sandbox/failed.log" 2>&1; then exit 91; fi
grep -q OMNIDESK_INSTALL_ROLLED_BACK "$sandbox/failed.log"
cmp "$config" "$sandbox/old-config"
cmp "$unit" "$sandbox/old-unit"
[ "$(cat "$binary")" = agent-version-1 ]
[ "$(cat "$state")" = traffic-state-must-survive ]
[ -f "$sandbox/active" ] && [ -f "$sandbox/enabled" ]
sh "$script" "$stage" "$expected" > "$sandbox/reinstall.log"
[ "$(cat "$binary")" = agent-version-2 ]
[ "$(cat "$state")" = traffic-state-must-survive ]
# Re-enrolling after server-side deletion resets only the state file, with rollback and backup.
touch "$sandbox/fail-restart"
if sh "$script" "$stage" "$expected" 1 > "$sandbox/reset-failed.log" 2>&1; then exit 95; fi
[ "$(cat "$state")" = traffic-state-must-survive ]
sh "$script" "$stage" "$expected" 1 > "$sandbox/reset.log"
[ ! -e "$state" ]
[ "$(cat "$sandbox/var/backups/omnidesk-monitor-agent/omnidesk-monitor-install-fixture/state.json")" = traffic-state-must-survive ]
printf 'traffic-state-must-survive' > "$state"
# Missing config with existing traffic state must not attach the state to another node.
cp "$config" "$sandbox/current-config"
rm "$config"
if sh "$script" "$stage" "$expected" > /dev/null 2>&1; then exit 93; fi
[ "$(cat "$state")" = traffic-state-must-survive ]
cp "$sandbox/current-config" "$config"
# A manual unit must remain untouched.
printf 'manual-unit' > "$unit"
if sh "$script" "$stage" "$expected" > /dev/null 2>&1; then exit 92; fi
[ "$(cat "$unit")" = manual-unit ]
[ "$(cat "$binary")" = agent-version-2 ]
printf 'PASS isolated shell fixture: fresh install, restart failure restores files/service state, reinstall preserves traffic state, manual unit refused\n'
