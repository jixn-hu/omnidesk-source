#!/bin/sh
# OmniDesk 远端指标采集脚本
#
# 设计约束：
#   - 只用 POSIX sh + 常见工具，不假设有 python/jq
#   - 输出单个 JSON 对象到 stdout，不输出任何其他内容
#   - 采集失败时对应字段降级为空/0，绝不整体失败
#   - 目标机零依赖：脚本通过 SFTP 推送后执行，用完可删
#
# 用法：sh collect.sh [--with-processes] [--with-gpu]

LC_ALL=C
export LC_ALL

WITH_PROCESSES=0
WITH_GPU=0
for arg in "$@"; do
  case "$arg" in
    --with-processes) WITH_PROCESSES=1 ;;
    --with-gpu) WITH_GPU=1 ;;
  esac
done

# ---------------------------------------------------------------- #
# JSON 输出辅助                                                     #
# ---------------------------------------------------------------- #

# 转义字符串中的特殊字符，使其可安全放入 JSON
jesc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr -d '\000-\010\013\014\016-\037'
}

# 数字清洗：非数字一律归 0
jnum() {
  case "$1" in
    ''|*[!0-9.-]*) printf '0' ;;
    *) printf '%s' "$1" ;;
  esac
}

json_str() { printf '"%s"' "$(jesc "$1")"; }

# 读取文件内容，不存在则返回空
readf() { [ -r "$1" ] && cat "$1" 2>/dev/null || printf ''; }

# ---------------------------------------------------------------- #
# 系统信息                                                          #
# ---------------------------------------------------------------- #

HOSTNAME_V=$(hostname 2>/dev/null || printf 'unknown')

OS_NAME=""
if [ -r /etc/os-release ]; then
  OS_NAME=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -1)
fi
[ -z "$OS_NAME" ] && OS_NAME=$(uname -s 2>/dev/null || printf 'unknown')

KERNEL=$(uname -r 2>/dev/null || printf '')
ARCH=$(uname -m 2>/dev/null || printf '')

UPTIME_S=""
if [ -r /proc/uptime ]; then
  UPTIME_S=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)
fi
[ -z "$UPTIME_S" ] && UPTIME_S=0

VIRT=""
if command -v systemd-detect-virt >/dev/null 2>&1; then
  VIRT=$(systemd-detect-virt 2>/dev/null | head -1)
fi
[ "$VIRT" = "none" ] && VIRT=""

CPU_MODEL=""
if [ -r /proc/cpuinfo ]; then
  CPU_MODEL=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -1)
  [ -z "$CPU_MODEL" ] && CPU_MODEL=$(sed -n 's/^Hardware[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -1)
fi
[ -z "$CPU_MODEL" ] && CPU_MODEL=$(uname -p 2>/dev/null || printf '')

# ---------------------------------------------------------------- #
# CPU 使用率                                                        #
# ---------------------------------------------------------------- #
# 取两次 /proc/stat 快照，间隔 200ms 计算真实使用率
# （单次快照算出来的是"开机以来平均"，对监控毫无意义）

cpu_snapshot() {
  awk '/^cpu /{
    total=$2+$3+$4+$5+$6+$7+$8+$9
    idle=$5+$6
    printf "%s %s", total, idle
  }' /proc/stat 2>/dev/null
}

CPU_USAGE=0
S1=$(cpu_snapshot)
if [ -n "$S1" ]; then
  sleep 0.2 2>/dev/null || sleep 1
  S2=$(cpu_snapshot)
  if [ -n "$S2" ]; then
    CPU_USAGE=$(printf '%s\n%s\n' "$S1" "$S2" | awk '
      NR==1 { t1=$1; i1=$2 }
      NR==2 {
        dt=$1-t1; di=$2-i1
        if (dt>0) printf "%.1f", (dt-di)*100/dt; else printf "0"
      }')
  fi
fi
[ -z "$CPU_USAGE" ] && CPU_USAGE=0

# 分核使用率
PER_CORE=""
if [ -r /proc/stat ]; then
  PER_CORE=$(awk '/^cpu[0-9]+ /{
    total=$2+$3+$4+$5+$6+$7+$8+$9
    idle=$5+$6
    if (total>0) printf "%s%.1f", (n++?",":""), (total-idle)*100/total
  }' /proc/stat 2>/dev/null)
fi
[ -z "$PER_CORE" ] && PER_CORE="0"

CORES=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0')
[ "$CORES" = "0" ] && CORES=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || printf '0')

# 负载
LOAD1=0; LOAD5=0; LOAD15=0
if [ -r /proc/loadavg ]; then
  set -- $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)
  LOAD1=$1; LOAD5=$2; LOAD15=$3
fi

# ---------------------------------------------------------------- #
# 内存                                                              #
# ---------------------------------------------------------------- #

MEM_TOTAL=0; MEM_FREE=0; MEM_AVAIL=0; MEM_BUFFERS=0; MEM_CACHED=0
SWAP_TOTAL=0; SWAP_FREE=0

if [ -r /proc/meminfo ]; then
  eval $(awk '
    /^MemTotal:/     { printf "MEM_TOTAL=%s;", $2 }
    /^MemFree:/      { printf "MEM_FREE=%s;", $2 }
    /^MemAvailable:/ { printf "MEM_AVAIL=%s;", $2 }
    /^Buffers:/      { printf "MEM_BUFFERS=%s;", $2 }
    /^Cached:/       { printf "MEM_CACHED=%s;", $2 }
    /^SwapTotal:/    { printf "SWAP_TOTAL=%s;", $2 }
    /^SwapFree:/     { printf "SWAP_FREE=%s;", $2 }
  ' /proc/meminfo 2>/dev/null)
fi

# kB -> bytes
MEM_TOTAL=$((MEM_TOTAL * 1024))
MEM_FREE=$((MEM_FREE * 1024))
MEM_AVAIL=$((MEM_AVAIL * 1024))
MEM_BUFFERS=$((MEM_BUFFERS * 1024))
MEM_CACHED=$((MEM_CACHED * 1024))
SWAP_TOTAL=$((SWAP_TOTAL * 1024))
SWAP_FREE=$((SWAP_FREE * 1024))

MEM_USED=$((MEM_TOTAL - MEM_AVAIL))
SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))

MEM_PCT=0
if [ "$MEM_TOTAL" -gt 0 ]; then
  MEM_PCT=$(awk "BEGIN{printf \"%.1f\", $MEM_USED*100/$MEM_TOTAL}")
fi

# ---------------------------------------------------------------- #
# 磁盘                                                              #
# ---------------------------------------------------------------- #
# 过滤掉伪文件系统与容器层，只保留用户真正关心的挂载点

DISKS=""
DISKS=$(df -kP 2>/dev/null | awk '
  NR>1 {
    dev=$1; total=$2; used=$3; avail=$4; mount=$6
    # 跳过伪文件系统
    if (dev ~ /^(tmpfs|devtmpfs|squashfs|nsfs|ramfs|proc|sysfs|devfs|debugfs|tracefs|securityfs|configfs|fusectl|mqueue|pstore|hugetlbfs|autofs|rpc_pipefs|cgroup|cgroup2|overlay|none|udev)$/) next
    if (mount ~ /^\/(proc|sys|dev|run|snap|var\/lib\/docker|var\/lib\/containers|var\/lib\/kubelet|var\/lib\/flatpak|var\/lib\/snapd)/) next
    if (mount ~ /^\/boot\/(efi|firmware)$/) next
    # 跳过 loop / ram 设备
    if (dev ~ /^\/dev\/(loop|ram|zram)/) next
    if (total <= 0) next
    pct = used*100/total
    printf "%s%s|%s|%s|%s|%s|%.1f", (n++?",":""), dev, mount, total, used, avail, pct
  }' 2>/dev/null)

# ---------------------------------------------------------------- #
# 网络                                                              #
# ---------------------------------------------------------------- #

NET=""
if [ -r /proc/net/dev ]; then
  NET=$(awk -F: '
    NR>2 {
      iface=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", iface)
      if (iface == "lo") next
      if (iface ~ /^(docker|br-|veth|virbr|tun|tap|kube)/) next
      counters=$2
      sub(/^[[:space:]]+/, "", counters)
      split(counters, values, /[[:space:]]+/)
      rx=values[1]; tx=values[9]
      printf "%s%s|%s|%s", (n++?",":""), iface, rx, tx
    }' /proc/net/dev 2>/dev/null)
fi

# ---------------------------------------------------------------- #
# 进程 TOP                                                          #
# ---------------------------------------------------------------- #

PROCS=""
if [ "$WITH_PROCESSES" = "1" ]; then
  PROCS=$(ps -eo pid=,user=,pcpu=,pmem=,args= 2>/dev/null | sort -k3 -rn 2>/dev/null | head -15)
fi

# ---------------------------------------------------------------- #
# 输出                                                              #
# ---------------------------------------------------------------- #

printf '{'
printf '"hostname":%s,' "$(json_str "$HOSTNAME_V")"
printf '"os":%s,' "$(json_str "$OS_NAME")"
printf '"kernel":%s,' "$(json_str "$KERNEL")"
printf '"arch":%s,' "$(json_str "$ARCH")"
printf '"uptime":%s,' "$(jnum "$UPTIME_S")"
printf '"virtualization":%s,' "$(json_str "$VIRT")"

printf '"cpu":{"usage":%s,"cores":%s,"model":%s,' "$(jnum "$CPU_USAGE")" "$(jnum "$CORES")" "$(json_str "$CPU_MODEL")"
printf '"perCore":[%s],' "$PER_CORE"
printf '"loadAvg":[%s,%s,%s]},' "$(jnum "$LOAD1")" "$(jnum "$LOAD5")" "$(jnum "$LOAD15")"

printf '"memory":{"total":%s,"used":%s,"free":%s,"available":%s,"buffers":%s,"cached":%s,' \
  "$MEM_TOTAL" "$MEM_USED" "$MEM_FREE" "$MEM_AVAIL" "$MEM_BUFFERS" "$MEM_CACHED"
printf '"swapTotal":%s,"swapUsed":%s,"usagePercent":%s},' "$SWAP_TOTAL" "$SWAP_USED" "$(jnum "$MEM_PCT")"

printf '"disks":['
if [ -n "$DISKS" ]; then
  FIRST=1
  printf '%s\n' "$DISKS" | tr ',' '\n' | while IFS='|' read -r dev mount total used avail pct; do
    [ -z "$dev" ] && continue
    [ "$FIRST" = "0" ] && printf ','
    FIRST=0
    printf '{"device":"%s","mount":"%s","fsType":"","total":%s,"used":%s,"available":%s,"usagePercent":%s}' \
      "$(jesc "$dev")" "$(jesc "$mount")" "$((total * 1024))" "$((used * 1024))" "$((avail * 1024))" "$(jnum "$pct")"
  done
fi
printf '],'

printf '"network":['
if [ -n "$NET" ]; then
  FIRST=1
  printf '%s\n' "$NET" | tr ',' '\n' | while IFS='|' read -r iface rx tx; do
    [ -z "$iface" ] && continue
    [ "$FIRST" = "0" ] && printf ','
    FIRST=0
    printf '{"name":"%s","rxBytes":%s,"txBytes":%s}' "$(jesc "$iface")" "$(jnum "$rx")" "$(jnum "$tx")"
  done
fi
printf ']'

if [ "$WITH_PROCESSES" = "1" ]; then
  printf ',"processes":['
  if [ -n "$PROCS" ]; then
    FIRST=1
    printf '%s\n' "$PROCS" | while read -r pid user cpu mem command; do
      [ -z "$pid" ] && continue
      [ "$FIRST" = "0" ] && printf ','
      FIRST=0
      command=$(printf '%s' "$command" | cut -c1-200)
      printf '{"pid":%s,"user":"%s","cpu":%s,"mem":%s,"command":"%s"}' \
        "$(jnum "$pid")" "$(jesc "$user")" "$(jnum "$cpu")" "$(jnum "$mem")" "$(jesc "$command")"
    done
  fi
  printf ']'
fi

printf '}\n'
