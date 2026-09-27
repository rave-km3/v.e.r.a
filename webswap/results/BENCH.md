# WebSwap benchmark

**Every WebSwap configuration is slower than RAM. The value is finishing instead of crashing.**

Environment: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 15.7 GiB RAM, Linux 6.18.44-fc-v37, Node v22.22.2. Cloud VM (Firecracker/KVM) with a virtio disk; file-backend reads may be served by the OS page cache. Numbers are indicative.

| Workload | Configuration | Heap MiB | Real Memory MiB | Time ms | vs RAM | Projected on slower storage | Storage reads | Read MiB | Written MiB | Result |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sort | RAM | 128 | 129 | 651 | 1x | — | — | — | — | ok |
| sort | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| sort | V100 mem | 128 | 165 | 902 | 1.4x | 902 ms (1x) | 0 | 0 | 0 | ok, same checksum |
| sort | V25 mem | 128 | 37 | 1110 | 1.7x | 12847 ms (20x) | 68863 | 754 | 324 | ok, same checksum |
| sort | V25 file | 128 | 37 | 1204 | 1.8x | — | 68863 | 754 | 324 | ok, same checksum |
| sort | V6 mem | 128 | 13 | 970 | 1.5x | 12689 ms (19x) | 68490 | 771 | 324 | ok, same checksum |
| sort | V6 file | 128 | 13 | 1049 | 1.6x | — | 68490 | 771 | 324 | ok, same checksum |
| sort | V25 delay SIMULATED | 128 | 37 | 13384 | 20.5x | — | 68863 | 754 | 324 | ok, same checksum |
| blur | RAM | 128 | 129 | 485 | 1x | — | — | — | — | ok |
| blur | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| blur | V100 mem | 128 | 165 | 569 | 1.2x | 569 ms (1x) | 0 | 0 | 0 | ok, same checksum |
| blur | V25 mem | 128 | 37 | 629 | 1.3x | 4776 ms (10x) | 17411 | 128 | 128 | ok, same checksum |
| blur | V25 file | 128 | 37 | 703 | 1.5x | — | 17411 | 128 | 128 | ok, same checksum |
| blur | V6 mem | 128 | 13 | 601 | 1.2x | 4748 ms (10x) | 17411 | 128 | 128 | ok, same checksum |
| blur | V6 file | 128 | 13 | 644 | 1.3x | — | 17411 | 128 | 128 | ok, same checksum |
| blur | V25 delay SIMULATED | 128 | 37 | 4993 | 10.3x | — | 17411 | 128 | 128 | ok, same checksum |
| hash | RAM | 128 | 129 | 358 | 1x | — | — | — | — | ok |
| hash | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| hash | V100 mem | 128 | 165 | 525 | 1.5x | 525 ms (1x) | 0 | 0 | 0 | ok, same checksum |
| hash | V25 mem | 128 | 37 | 16070 | 44.9x | 526484 ms (1470x) | 3881098 | 15209 | 12358 | ok, same checksum |
| hash | V25 file | 128 | 37 | 19168 | 53.5x | — | 3881098 | 15209 | 12358 | ok, same checksum |
| hash | V6 mem | 128 | 13 | 16811 | 46.9x | 644682 ms (1800x) | 4791335 | 18954 | 15168 | ok, same checksum |
| hash | V6 file | 128 | 13 | 21937 | 61.3x | — | 4791335 | 18954 | 15168 | ok, same checksum |
| rand | RAM | 128 | 129 | 162 | 1x | — | — | — | — | ok |
| rand | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| rand | V100 mem | 128 | 165 | 173 | 1.1x | 173 ms (1x) | 0 | 0 | 0 | ok, same checksum |
| rand | V25 mem | 128 | 37 | 840 | 5.2x | 26774 ms (165x) | 153290 | 709 | 714 | ok, same checksum |
| rand | V25 file | 128 | 37 | 1025 | 6.3x | — | 153290 | 709 | 714 | ok, same checksum |
| rand | V6 mem | 128 | 13 | 844 | 5.2x | 32371 ms (200x) | 189753 | 861 | 861 | ok, same checksum |
| rand | V6 file | 128 | 13 | 1080 | 6.7x | — | 189753 | 861 | 861 | ok, same checksum |
| chase | RAM | 128 | 129 | 795 | 1x | — | — | — | — | ok |
| chase | RAM-cap 64 MiB | 128 | — | — | — | — | — | — | — | failed: out of memory |
| chase | V100 mem | 128 | 165 | 2029 | 2.6x | 2029 ms (3x) | 0 | 0 | 0 | ok, same checksum |
| chase | V25 mem | 128 | 37 | 55464 | 69.8x | 2101512 ms (2644x) | 13718350 | 53591 | 53130 | ok, same checksum |
| chase | V25 file | 128 | 37 | 71412 | 89.8x | — | 13718350 | 53591 | 53130 | ok, same checksum |
| chase | V6 mem | 128 | 13 | 83402 | 104.9x | 3947636 ms (4966x) | 25864271 | 101067 | 100430 | ok, same checksum |
| chase | V6 file | 128 | 13 | 120589 | 151.7x | — | 25864271 | 101067 | 100430 | ok, same checksum |
| sort | HEADLINE RAM | 2048 | 2049 | 12388 | 1x | — | — | — | — | ok |
| sort | HEADLINE RAM-cap 256 MiB | 2048 | — | — | — | — | — | — | — | failed: out of memory |
| sort | HEADLINE V file 64 MiB | 2048 | 69 | 25560 | 2.1x | — | 1077131 | 12288 | 5124 | ok, same checksum |

Notes:
- `mem`: pages kept in JS memory; measures the paging policy and translation cost only.
- `file`: a real file; the OS page cache may serve reads, so a cold disk would be slower.
- `delay`: `mem` plus a fixed 50 µs per read and 100 µs per write (SIMULATED slower storage).
- "Projected on slower storage" (mem rows only) = measured time + storage reads x 50 µs + writes x 100 µs. It is an estimate; compare it with the measured `delay` rows of the same workload to see how close it is.
- Single run per cell (not a median); expect run-to-run noise of 10-30% on a shared VM.
