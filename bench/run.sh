#!/usr/bin/env bash
# run.sh - build and run the whole "can storage act as RAM?" benchmark suite.
#
#   ./run.sh | tee results.txt          # everything except the swap test
#   sudo SWAP_TEST=1 ./run.sh | tee results.txt   # also try a real swap file
#
# Environment:
#   FILE_SIZE  size of the storage test file (default 2G). Use something
#              larger than your RAM-backed disk caches if you can.
#   BENCH_TMP  directory for the test file (default ./tmp). It must be on the
#              storage device you want to measure (not tmpfs!).
#   SWAP_TEST  1 = also run swap_try.sh (needs root; enables a temporary
#              swap file, then disables and deletes it)
#
# Uses about FILE_SIZE (+512 MiB with SWAP_TEST) of disk; everything under
# BENCH_TMP is deleted at the end. Write tests overwrite only the test file.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
TMP=${BENCH_TMP:-$DIR/tmp}
FILE=$TMP/testfile
FILE_SIZE=${FILE_SIZE:-2G}
NPROC=$(nproc)

cleanup() { rm -f "$FILE"; rmdir "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

section() { printf '\n######## %s ########\n' "$*"; }

make -C "$DIR" --no-print-directory
mkdir -p "$TMP"
case "$(df --output=fstype "$TMP" | tail -1)" in
    tmpfs|ramfs) echo "WARNING: $TMP is in RAM ($(df --output=fstype "$TMP" | tail -1));" \
                      "storage numbers will be meaningless. Set BENCH_TMP to a disk path." >&2 ;;
esac

section "Environment";            "$DIR/env.sh" "$TMP"

section "1. RAM latency (dependent random loads)"
"$DIR/ram_latency" 16K 1G
"$DIR/ram_latency" -H 1G          # same, with transparent huge pages

section "2. RAM bandwidth (sequential)"
"$DIR/ram_bandwidth" -t 1
[ "$NPROC" -gt 1 ] && "$DIR/ram_bandwidth" -t "$NPROC"

section "Creating ${FILE_SIZE} test file"
"$DIR/mkfile" "$FILE" "$FILE_SIZE"

section "3. Storage latency (random 4 KiB, queue depth 1)"
"$DIR/storage_latency" -f "$FILE" -m read
"$DIR/storage_latency" -f "$FILE" -m write
"$DIR/storage_latency" -f "$FILE" -m write-sync -n 5000

section "4. Storage bandwidth (sequential, 1 MiB blocks)"
"$DIR/storage_bandwidth" -f "$FILE" -m read

section "5. mmap page faults (storage mapped as memory)"
"$DIR/mmap_fault" -f "$FILE" -a random
"$DIR/mmap_fault" -f "$FILE" -a normal -n 200

if [ "${SWAP_TEST:-0}" = 1 ]; then
    section "6. Swap file (real 'virtual RAM')"
    SWAP_FILE="$TMP/swapfile" "$DIR/swap_try.sh"
else
    section "6. Swap file: skipped (run with SWAP_TEST=1 as root to try it)"
fi
