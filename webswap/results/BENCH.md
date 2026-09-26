# WebSwap benchmark

**Every WebSwap configuration is slower than RAM. The value is finishing instead of crashing.**

Environment: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 15.7 GiB RAM, Linux 6.18.44-fc-v37, Node v22.22.2. Cloud VM (Firecracker/KVM) with a virtio disk; file-backend reads may be served by the OS page cache. Numbers are indicative.

| Workload | Configuration | Heap MiB | Real Memory MiB | Time ms | vs RAM | Projected on slower storage | Storage reads | Read MiB | Written MiB | Result |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sort | RAM | 128 | 129 | 668 | 1x | — | — | — | — | ok |
| sort | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| sort | V100 mem | 128 | 165 | 1218 | 1.8x | 1218 ms (2x) | 0 | 0 | 0 | ok, same checksum |
| sort | V25 mem | 128 | 37 | 1374 | 2.1x | 13111 ms (20x) | 68862 | 754 | 324 | ok, same checksum |
| sort | V25 file | 128 | 37 | 1445 | 2.2x | — | 68862 | 754 | 324 | ok, same checksum |
| sort | V6 mem | 128 | 13 | 1217 | 1.8x | 12936 ms (19x) | 68489 | 771 | 324 | ok, same checksum |
| sort | V6 file | 128 | 13 | 1223 | 1.8x | — | 68489 | 771 | 324 | ok, same checksum |
| sort | V25 delay SIMULATED | 128 | 37 | 13601 | 20.4x | — | 68862 | 754 | 324 | ok, same checksum |
| blur | RAM | 128 | 129 | 528 | 1x | — | — | — | — | ok |
| blur | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| blur | V100 mem | 128 | 165 | 895 | 1.7x | 895 ms (2x) | 0 | 0 | 0 | ok, same checksum |
| blur | V25 mem | 128 | 37 | 705 | 1.3x | 4853 ms (9x) | 17409 | 128 | 128 | ok, same checksum |
| blur | V25 file | 128 | 37 | 728 | 1.4x | — | 17409 | 128 | 128 | ok, same checksum |
| blur | V6 mem | 128 | 13 | 714 | 1.4x | 4862 ms (9x) | 17409 | 128 | 128 | ok, same checksum |
| blur | V6 file | 128 | 13 | 709 | 1.3x | — | 17409 | 128 | 128 | ok, same checksum |
| blur | V25 delay SIMULATED | 128 | 37 | 5140 | 9.7x | — | 17409 | 128 | 128 | ok, same checksum |
| hash | RAM | 128 | 129 | 325 | 1x | — | — | — | — | ok |
| hash | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| hash | V100 mem | 128 | 165 | 564 | 1.7x | 564 ms (2x) | 0 | 0 | 0 | ok, same checksum |
| hash | V25 mem | 128 | 37 | 14836 | 45.7x | 529999 ms (1632x) | 3912757 | 15332 | 12481 | ok, same checksum |
| hash | V25 file | 128 | 37 | 18756 | 57.8x | — | 3912757 | 15332 | 12481 | ok, same checksum |
| hash | V6 mem | 128 | 13 | 15300 | 47.1x | 648076 ms (1996x) | 4824035 | 19082 | 15296 | ok, same checksum |
| hash | V6 file | 128 | 13 | 20603 | 63.5x | — | 4824035 | 19082 | 15296 | ok, same checksum |
| rand | RAM | 128 | 129 | 141 | 1x | — | — | — | — | ok |
| rand | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| rand | V100 mem | 128 | 165 | 196 | 1.4x | 196 ms (1x) | 0 | 0 | 0 | ok, same checksum |
| rand | V25 mem | 128 | 37 | 848 | 6.0x | 26782 ms (190x) | 153289 | 709 | 714 | ok, same checksum |
| rand | V25 file | 128 | 37 | 994 | 7.0x | — | 153289 | 709 | 714 | ok, same checksum |
| rand | V6 mem | 128 | 13 | 875 | 6.2x | 32402 ms (230x) | 189752 | 861 | 861 | ok, same checksum |
| rand | V6 file | 128 | 13 | 1142 | 8.1x | — | 189752 | 861 | 861 | ok, same checksum |
| chase | RAM | 128 | 129 | 848 | 1x | — | — | — | — | ok |
| chase | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| chase | V100 mem | 128 | 165 | 2535 | 3.0x | 2535 ms (3x) | 0 | 0 | 0 | ok, same checksum |
| chase | V25 mem | 128 | 37 | 53670 | 63.3x | 2099718 ms (2476x) | 13718349 | 53591 | 53130 | ok, same checksum |
| chase | V25 file | 128 | 37 | 70261 | 82.9x | — | 13718349 | 53591 | 53130 | ok, same checksum |
| chase | V6 mem | 128 | 13 | 85235 | 100.5x | 3949468 ms (4657x) | 25864270 | 101067 | 100430 | ok, same checksum |
| chase | V6 file | 128 | 13 | 111582 | 131.6x | — | 25864270 | 101067 | 100430 | ok, same checksum |
| sort | HEADLINE RAM | 2048 | 2049 | 19804 | 1x | — | — | — | — | ok |
| sort | HEADLINE RAM-cap 256 MiB | 2048 | — | — | — | — | — | — | — | failed: out of memory |
| sort | HEADLINE V file 64 MiB | 2048 | 69 | 34753 | 1.8x | — | 1077130 | 12288 | 5124 | ok, same checksum |

Notes:
- `mem`: pages kept in JS memory; measures the paging policy and translation cost only.
- `file`: a real file; the OS page cache may serve reads, so a cold disk would be slower.
- `delay`: `mem` plus a fixed 50 µs per read and 100 µs per write (SIMULATED slower storage).
- "Projected on slower storage" (mem rows only) = measured time + storage reads x 50 µs + writes x 100 µs. It is an estimate; compare it with the measured `delay` rows of the same workload to see how close it is.
- Single run per cell (not a median); expect run-to-run noise of 10-30% on a shared VM.
