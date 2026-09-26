/*
 * mkfile.c - create the test file used by the storage and mmap benchmarks.
 *
 * The file is filled with pseudo-random, non-zero data (so every block is
 * really allocated on disk and nothing can be skipped as "zero" or
 * compressed), fsync'ed, and then dropped from the page cache with
 * posix_fadvise(DONTNEED) so the benchmarks start cold.
 *
 * Usage: mkfile PATH [SIZE]     (SIZE default 2G)
 *
 * Build: gcc -O2 -o mkfile mkfile.c
 */
#include "common.h"

#include <fcntl.h>

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: %s PATH [SIZE]\n", argv[0]);
        return 2;
    }
    const char *path = argv[1];
    uint64_t size = argc > 2 ? parse_size(argv[2]) : (2ull << 30);
    const size_t chunk = 1 << 20;
    if (size % chunk)
        die("size must be a multiple of 1 MiB");

    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0)
        die("open %s", path);
    char *buf = malloc(chunk);
    if (!buf)
        die("malloc");

    uint64_t t0 = now_ns();
    for (uint64_t off = 0; off < size; off += chunk) {
        fill_random(buf, chunk, off + 1); /* different data in every MiB */
        for (size_t done = 0; done < chunk;) {
            ssize_t w = write(fd, buf + done, chunk - done);
            if (w < 0)
                die("write");
            done += (size_t)w;
        }
    }
    if (fsync(fd) != 0)
        die("fsync");
    uint64_t t1 = now_ns();
    /* Evict the file from this machine's page cache. */
    int rc = posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
    close(fd);

    char sz[32];
    printf("mkfile path=%s size=%s write+fsync_s=%.2f (%.2f GB/s buffered) fadvise_dontneed=%s\n",
           path, fmt_size(size, sz, sizeof sz), (t1 - t0) / 1e9,
           (double)size / (double)(t1 - t0), rc == 0 ? "ok" : strerror(rc));
    free(buf);
    return 0;
}
