# bench: how far is storage from RAM?

Small, dependency-free C benchmarks that measure the gap between RAM and
storage on a Linux machine, and what a program actually experiences when
storage is used *as* memory (mmap page faults, swap). They were written to
back a feasibility study of "turning storage into (virtual) RAM".

## Build and run

Requirements: Linux, `gcc`, `make`, `bash`. Root is needed only for the swap test.

```sh
cd bench
make                                   # builds all binaries (gcc -O2)
./run.sh | tee results.txt             # full suite, ~2-3 minutes
sudo SWAP_TEST=1 ./run.sh | tee results.txt   # also try a real swap file
```

`run.sh` settings (environment variables):

| Variable    | Default   | Meaning |
|-------------|-----------|---------|
| `BENCH_TMP` | `./tmp`   | Where the test file goes. It must be on the disk you want to measure, not on tmpfs. |
| `FILE_SIZE` | `2G`      | Size of the test file. Larger is better if the disk has a big cache. |
| `SWAP_TEST` | `0`       | `1` runs `swap_try.sh`: enables a temporary 512 MiB swap file, runs an experiment, then disables and deletes it. |

Disk use is about `FILE_SIZE`, plus 512 MiB when `SWAP_TEST=1`. Everything
under `BENCH_TMP` is deleted at the end. The write tests only overwrite the
test file. `make clean` removes the binaries.

Each program prints one line per repetition and a `RESULT` line with the
median. Every program also runs on its own; `-h` or a bad flag prints its
usage.

## The benchmarks

| Program | What it measures | How |
|---------|------------------|-----|
| `ram_latency` | Time of one dependent random memory load (ns) | Pointer chasing through a random single-cycle permutation (Sattolo) of 64-byte elements. Defeats caches and prefetchers. Default sizes are 16K (L1 cache) and 1G (DRAM). `-H` asks for transparent huge pages, which removes most TLB-miss cost. |
| `ram_bandwidth` | Sequential RAM read, write (memset) and copy (memcpy), GB/s | 1 GiB buffers, pre-faulted. `-t N` splits the work across N threads. |
| `mkfile` | Creates the test file | Pseudo-random non-zero data (not sparse, not compressible), then `fsync` and `POSIX_FADV_DONTNEED`. |
| `storage_latency` | Random 4 KiB I/O at queue depth 1: avg, p50, p90, p99, p99.9 and max in µs | `O_DIRECT` with 4096-aligned buffers (`posix_memalign`). Three modes: `read`, `write`, and `write-sync` (`fdatasync` after every write). If `O_DIRECT` is rejected, it falls back to buffered I/O with `POSIX_FADV_DONTNEED` and reports `direct=no`. |
| `storage_bandwidth` | Sequential read (or write + `fdatasync`) with 1 MiB blocks, GB/s | `O_DIRECT`, single thread, one request at a time. |
| `mmap_fault` | Cost of touching storage mapped as memory | Maps the file with `mmap`, evicts it from the page cache and checks with `mincore` that nothing is resident. It then touches N random pages three times. **cold**: major fault, the page is read from disk. **warm**: the page is in RAM; CPU caches are scrubbed first. **minor**: after a remap, the page is in the page cache but not in the page tables. `-a random` uses `MADV_RANDOM` (1 page per fault). `-a normal` keeps the kernel's read-ahead and reports how many pages each fault pulled in. |
| `swap_fault` | Random touches on ordinary `malloc`-style memory | Run inside a memory cgroup smaller than the working set, part of the memory lives in swap. It reports the latency per touch and the share of touches that went to disk. |
| `swap_try.sh` | Can a swap file be enabled here? | Runs `fallocate`/`dd`, `chmod 600`, `mkswap` and `swapon`, and prints every command with its exit code. If swap works, it runs `swap_fault` in and out of a memory-limited cgroup, then runs `swapoff` and deletes the file. It also tests whether `drop_caches` is writable. |
| `env.sh` | Environment record | CPU, RAM, filesystem type, block device, read-ahead, write-cache mode, THP. |

## Reading the numbers (caveats)

* **Results from a VM with a virtualized disk are only indicative.** The
  "disk" may be a file on the host. Reads can come from the host's page cache,
  and the hypervisor may rate-limit I/O. Both can make storage look faster, or
  more jittery, than the real device. Guest-side `drop_caches` and
  `O_DIRECT` do not affect the host's cache.
* Virtualization also makes RAM look slower. With nested (EPT) page tables a
  TLB miss costs much more than on bare metal, so the 1 GiB random-load
  latency in a VM can be 2-3x the bare-metal figure (bare metal is typically
  about 80-120 ns).
* Queue depth 1 is the right model for a single thread that stalls on a page
  fault. Parallel I/O gives higher throughput but the same per-access
  latency.
* The kernel's read-ahead setting (`/sys/block/<dev>/queue/read_ahead_kb`)
  strongly affects `mmap_fault -a normal`.

## Example: results from the development container

Environment: a Firecracker/KVM microVM with 4 vCPUs (Intel Xeon, 2.1 GHz,
Sapphire Rapids class) and 15.7 GiB RAM, kernel 6.18. Storage is ext4 on a
256 GiB virtio-blk disk (`/dev/vda`) with `read_ahead_kb=8192` and a
"write back" cache. All values are medians of 3 repetitions (5 for RAM
bandwidth). Treat them as indicative only; see the caveats above.

| Metric | Result |
|--------|--------|
| RAM load latency, 16 KiB (L1 cache) | 1.6 ns |
| RAM load latency, 1 GiB random (4 KiB pages / huge pages) | 285 ns / 220 ns |
| RAM sequential read, 1 thread / 4 threads | 10.7 / 36.8 GB/s |
| RAM sequential write, 1 thread / 4 threads | 8.4 / 32.9 GB/s |
| Storage random 4 KiB read, QD1, `O_DIRECT` (avg / p50 / p99) | 41.6 / 37.3 / 96.7 µs (about 24k IOPS) |
| Storage random 4 KiB write, QD1, no flush (avg / p50 / p99) | 161 / 80 / 2027 µs (stalls up to 210 ms) |
| Storage random 4 KiB write + `fdatasync` (avg / p50 / p99) | 270 / 234 / 691 µs |
| Storage sequential read / write, 1 MiB blocks | 2.57 / 0.61 GB/s |
| mmap major fault, `MADV_RANDOM` (avg / p50 / p99) | 45.2 / 42.1 / 115 µs |
| mmap warm touch (same pages, in RAM) | 362 ns, so a major fault costs about 125x a warm touch |
| mmap minor fault (in page cache, not mapped) | 1.4 µs |
| mmap major fault, default read-ahead | 1.8 ms: 1385 pages (5.4 MiB) read per fault |
| Swap: 512 MiB working set, 128 MiB cgroup limit | 75% of touches fault, averaging 53 µs each, versus 0.34 µs in RAM |
