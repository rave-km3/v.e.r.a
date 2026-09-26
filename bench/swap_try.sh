#!/usr/bin/env bash
# swap_try.sh - try to turn a file on storage into "virtual RAM" (a swap file)
# the standard Linux way, and report exactly what happens at each step.
#
# If swap can be enabled, a short experiment runs swap_fault inside a memory
# cgroup whose limit is smaller than its working set, so part of its memory
# really lives in the swap file. Afterwards swap is turned off and the file
# deleted. Needs root. Also checks whether /proc/sys/vm/drop_caches is
# writable.
#
# Environment: SWAP_FILE (default ./tmp/swapfile), SWAP_MB (default 512),
#              WSET (swap_fault working set, default 512M),
#              LIMIT_MB (cgroup memory limit, default 128)
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
SWAP=${SWAP_FILE:-$DIR/tmp/swapfile}
SWAP_MB=${SWAP_MB:-512}
WSET=${WSET:-512M}
LIMIT_MB=${LIMIT_MB:-128}
CG=""

run() { echo "\$ $*"; "$@" 2>&1 | sed 's/^/    /'; local rc=${PIPESTATUS[0]}; echo "    -> exit code $rc"; return $rc; }

cleanup() {
    grep -q "^$SWAP " /proc/swaps 2>/dev/null && run swapoff "$SWAP"
    [ -e "$SWAP" ] && run rm -f "$SWAP"
    [ -n "$CG" ] && [ -d "$CG" ] && rmdir "$CG" 2>/dev/null
}
trap cleanup EXIT

mkdir -p "$(dirname "$SWAP")"
echo "== 1. Create and enable a ${SWAP_MB} MiB swap file at $SWAP"
if ! run fallocate -l "${SWAP_MB}M" "$SWAP"; then
    echo "   fallocate failed, falling back to dd"
    run dd if=/dev/zero of="$SWAP" bs=1M count="$SWAP_MB" status=none
fi
run chmod 600 "$SWAP"
run mkswap "$SWAP"
if run swapon "$SWAP"; then
    echo "   swap is ON:"; sed 's/^/    /' /proc/swaps

    # --- optional experiment: force a process to live partly in swap -------
    if [ -x "$DIR/swap_fault" ]; then
        echo "== 2. Baseline: swap_fault with a $WSET working set, no memory limit (all in RAM)"
        "$DIR/swap_fault" -s "$WSET" -r 3
        if [ -f /sys/fs/cgroup/cgroup.controllers ]; then           # cgroup v2
            CG=/sys/fs/cgroup/bench_swap
            mkdir -p "$CG" && echo "${LIMIT_MB}M" > "$CG/memory.max" && echo max > "$CG/memory.swap.max"
        elif [ -d /sys/fs/cgroup/memory ]; then                    # cgroup v1
            CG=/sys/fs/cgroup/memory/bench_swap
            mkdir -p "$CG" && echo "${LIMIT_MB}M" > "$CG/memory.limit_in_bytes"
        fi
        if [ -n "$CG" ] && [ -d "$CG" ]; then
            echo "== 3. Same program in a memory cgroup limited to ${LIMIT_MB} MiB -> the rest must live in swap"
            sh -c "echo \$\$ > '$CG/cgroup.procs' && exec '$DIR/swap_fault' -s '$WSET' -r 3"
            echo "== 3b. Same, but writing to the pages (swapped-in pages become dirty again)"
            sh -c "echo \$\$ > '$CG/cgroup.procs' && exec '$DIR/swap_fault' -s '$WSET' -r 3 -w"
        else
            echo "   no usable memory cgroup; skipping the forced-swap experiment"
        fi
    fi
    run swapoff "$SWAP"
else
    echo "   swapon failed: this environment does not allow enabling swap"
fi
run rm -f "$SWAP"

echo "== 4. Is dropping the page cache allowed? (echo 3 > /proc/sys/vm/drop_caches)"
sync
if err=$( (echo 3 > /proc/sys/vm/drop_caches) 2>&1 ); then
    echo "    allowed (guest page cache dropped; a hypervisor's own cache is NOT affected)"
else
    echo "    denied: $err"
fi
