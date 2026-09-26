# WebSwap benchmark

**Every WebSwap configuration is slower than RAM. The value is finishing instead of crashing.**

Environment: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 15.7 GiB RAM, Linux 6.18.44-fc-v37, Node v22.22.2. Cloud VM (Firecracker/KVM) with a virtio disk; file-backend reads may be served by the OS page cache. Numbers are indicative.

| Workload | Configuration | Heap MiB | Real Memory MiB | Time ms | vs RAM | Projected on slower storage | Storage reads | Read MiB | Written MiB | Result |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sort | RAM | 128 | 129 | 733 | 1x | — | — | — | — | ok |
| sort | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| sort | V100 mem | 128 | 165 | 1372 | 1.9x | 1372 ms (2x) | 0 | 0 | 0 | ok, same checksum |
| sort | V25 mem | 128 | 37 | 1387 | 1.9x | 13125 ms (18x) | 68863 | 754 | 324 | ok, same checksum |
| sort | V25 file | 128 | 37 | 1651 | 2.3x | — | 68863 | 754 | 324 | ok, same checksum |
| sort | V6 mem | 128 | 13 | 1115 | 1.5x | 12834 ms (18x) | 68490 | 771 | 324 | ok, same checksum |
| sort | V6 file | 128 | 13 | 1114 | 1.5x | — | 68490 | 771 | 324 | ok, same checksum |
| sort | V25 delay SIMULATED | 128 | 37 | 13713 | 18.7x | — | 68863 | 754 | 324 | ok, same checksum |
| blur | RAM | 128 | 129 | 473 | 1x | — | — | — | — | ok |
| blur | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| blur | V100 mem | 128 | 165 | 872 | 1.8x | 872 ms (2x) | 0 | 0 | 0 | ok, same checksum |
| blur | V25 mem | 128 | 37 | 772 | 1.6x | 4920 ms (10x) | 17411 | 128 | 128 | ok, same checksum |
| blur | V25 file | 128 | 37 | 761 | 1.6x | — | 17411 | 128 | 128 | ok, same checksum |
| blur | V6 mem | 128 | 13 | 772 | 1.6x | 4920 ms (10x) | 17411 | 128 | 128 | ok, same checksum |
| blur | V6 file | 128 | 13 | 745 | 1.6x | — | 17411 | 128 | 128 | ok, same checksum |
| blur | V25 delay SIMULATED | 128 | 37 | 5064 | 10.7x | — | 17411 | 128 | 128 | ok, same checksum |
| hash | RAM | 128 | 129 | 328 | 1x | — | — | — | — | ok |
| hash | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| hash | V100 mem | 128 | 165 | 567 | 1.7x | 567 ms (2x) | 0 | 0 | 0 | ok, same checksum |
| hash | V25 mem | 128 | 37 | 16528 | 50.4x | 526942 ms (1607x) | 3881098 | 15209 | 12358 | ok, same checksum |
| hash | V25 file | 128 | 37 | 20197 | 61.6x | — | 3881098 | 15209 | 12358 | ok, same checksum |
| hash | V6 mem | 128 | 13 | 16974 | 51.8x | 644845 ms (1967x) | 4791335 | 18954 | 15168 | ok, same checksum |
| hash | V6 file | 128 | 13 | 22446 | 68.5x | — | 4791335 | 18954 | 15168 | ok, same checksum |
| rand | RAM | 128 | 129 | 151 | 1x | — | — | — | — | ok |
| rand | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| rand | V100 mem | 128 | 165 | 200 | 1.3x | 200 ms (1x) | 0 | 0 | 0 | ok, same checksum |
| rand | V25 mem | 128 | 37 | 895 | 5.9x | 26829 ms (178x) | 153290 | 709 | 714 | ok, same checksum |
| rand | V25 file | 128 | 37 | 1031 | 6.8x | — | 153290 | 709 | 714 | ok, same checksum |
| rand | V6 mem | 128 | 13 | 835 | 5.5x | 32361 ms (214x) | 189753 | 861 | 861 | ok, same checksum |
| rand | V6 file | 128 | 13 | 1095 | 7.2x | — | 189753 | 861 | 861 | ok, same checksum |
| chase | RAM | 128 | 129 | 1030 | 1x | — | — | — | — | ok |
| chase | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| chase | V100 mem | 128 | 165 | 2671 | 2.6x | 2671 ms (3x) | 0 | 0 | 0 | ok, same checksum |
| chase | V25 mem | 128 | 37 | 58933 | 57.2x | 2104980 ms (2043x) | 13718350 | 53591 | 53130 | ok, same checksum |
| chase | V25 file | 128 | 37 | 74584 | 72.4x | — | 13718350 | 53591 | 53130 | ok, same checksum |
| chase | V6 mem | 128 | 13 | 85184 | 82.7x | 3949418 ms (3833x) | 25864271 | 101067 | 100430 | ok, same checksum |
| chase | V6 file | 128 | 13 | 124615 | 120.9x | — | 25864271 | 101067 | 100430 | ok, same checksum |
| sort | HEADLINE RAM | 2048 | 2049 | 18062 | 1x | — | — | — | — | ok |
| sort | HEADLINE RAM-cap 256 MiB | 2048 | — | — | — | — | — | — | — | failed: out of memory |
| sort | HEADLINE V file 64 MiB | 2048 | 69 | 35660 | 2.0x | — | 1077131 | 12288 | 5124 | ok, same checksum |

Notes:
- `mem`: pages kept in JS memory; measures the paging policy and translation cost only.
- `file`: a real file; the OS page cache may serve reads, so a cold disk would be slower.
- `delay`: `mem` plus a fixed 50 µs per read and 100 µs per write (SIMULATED slower storage).
- "Projected on slower storage" (mem rows only) = measured time + storage reads x 50 µs + writes x 100 µs. It is an estimate; compare it with the measured `delay` rows of the same workload to see how close it is.
- Single run per cell (not a median); expect run-to-run noise of 10-30% on a shared VM.
