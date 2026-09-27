#!/usr/bin/env bash
# env.sh - print the facts that matter when reading the benchmark numbers.
# Read-only; safe to run as any user.
DIR=${1:-$(cd "$(dirname "$0")" && pwd)}

echo "== CPU";    lscpu | grep -E 'Model name|^CPU\(s\)|Thread|Socket|L1d|L2|L3|Hypervisor|Virtualization type' | sed 's/  */ /g'
echo "== Kernel"; uname -r
echo "== Virtualization"; (systemd-detect-virt 2>/dev/null || echo unknown)
echo "== Memory"; grep -E 'MemTotal|MemAvailable|SwapTotal' /proc/meminfo
echo "== Transparent huge pages"; cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null
echo "== Filesystem holding $DIR"; df -T "$DIR" | tail -1
echo "== Block devices"; lsblk -o NAME,SIZE,ROTA,TYPE,MOUNTPOINTS 2>/dev/null || lsblk
dev=$(df --output=source "$DIR" | tail -1); dev=${dev#/dev/}; base=$(lsblk -no PKNAME "/dev/$dev" 2>/dev/null); base=${base:-$dev}
if [ -d "/sys/block/$base" ]; then
    q=/sys/block/$base/queue
    echo "== /dev/$base queue: rotational=$(cat $q/rotational) scheduler=\"$(cat $q/scheduler)\" read_ahead_kb=$(cat $q/read_ahead_kb) write_cache=\"$(cat $q/write_cache 2>/dev/null)\" logical_block=$(cat $q/logical_block_size)"
    drv=$(readlink -f /sys/block/$base/device 2>/dev/null)
    echo "== /dev/$base device path: $drv"
    [ -r /sys/block/$base/device/vendor ] && echo "   vendor id: $(cat /sys/block/$base/device/vendor) (0x1af4 = virtio)"
    [ -r /sys/block/$base/device/model ]  && echo "   model: $(cat /sys/block/$base/device/model)"
fi
echo "== Active swap"; cat /proc/swaps
