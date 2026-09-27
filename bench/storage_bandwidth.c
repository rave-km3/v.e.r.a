/*
 * storage_bandwidth.c - sequential storage throughput with large blocks.
 *
 *   read   read the whole file front to back, O_DIRECT, one block at a time
 *   write  overwrite the whole file front to back, O_DIRECT, then fdatasync
 *          (the flush is included in the time)
 *
 * 1 GB/s = 1e9 bytes/s. If O_DIRECT is not supported, buffered I/O plus
 * POSIX_FADV_DONTNEED before each repetition is used instead ("direct=no").
 *
 * Usage: storage_bandwidth -f FILE [-m read|write|all] [-b block] [-r reps]
 *   -b  block size (default 1M)
 *   -r  repetitions, median reported (default 3)
 *
 * Build: gcc -O2 -o storage_bandwidth storage_bandwidth.c
 */
#include "common.h"

#include <fcntl.h>
#include <sys/stat.h>

static double one_pass(int fd, int write_mode, void *buf, size_t bs, uint64_t size)
{
    uint64_t t0 = now_ns();
    for (uint64_t off = 0; off + bs <= size; off += bs) {
        ssize_t rc = write_mode ? pwrite(fd, buf, bs, (off_t)off)
                                : pread(fd, buf, bs, (off_t)off);
        if (rc != (ssize_t)bs)
            die("%s at %llu returned %zd", write_mode ? "pwrite" : "pread",
                (unsigned long long)off, rc);
    }
    if (write_mode && fdatasync(fd) != 0)
        die("fdatasync");
    uint64_t t1 = now_ns();
    return (double)(size / bs * bs) / (double)(t1 - t0); /* GB/s */
}

static void run(const char *path, int write_mode, size_t bs, int reps)
{
    int direct = 1;
    int flags = write_mode ? O_WRONLY : O_RDONLY;
    int fd = open(path, flags | O_DIRECT);
    if (fd < 0 && errno == EINVAL) {
        fprintf(stderr, "warning: O_DIRECT not supported, using buffered I/O "
                        "+ POSIX_FADV_DONTNEED\n");
        direct = 0;
        fd = open(path, flags);
    }
    if (fd < 0)
        die("open %s", path);
    struct stat st;
    if (fstat(fd, &st) != 0)
        die("fstat");

    void *buf;
    if (posix_memalign(&buf, 4096, bs) != 0)
        die("posix_memalign");
    fill_random(buf, bs, 99);

    double gbs[64];
    char b[32];
    if (reps > 64)
        reps = 64;
    for (int r = 0; r < reps; r++) {
        if (!direct)
            posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
        gbs[r] = one_pass(fd, write_mode, buf, bs, (uint64_t)st.st_size);
        printf("storage_bandwidth mode=%s direct=%s block=%s rep=%d GB/s=%.3f\n",
               write_mode ? "write" : "read", direct ? "yes" : "no",
               fmt_size(bs, b, sizeof b), r + 1, gbs[r]);
        fflush(stdout);
    }
    printf("RESULT storage_bandwidth mode=%s direct=%s block=%s median_GB/s=%.3f\n",
           write_mode ? "write" : "read", direct ? "yes" : "no",
           fmt_size(bs, b, sizeof b), median_d(gbs, reps));
    free(buf);
    close(fd);
}

int main(int argc, char **argv)
{
    const char *path = NULL, *mode = "read";
    size_t bs = 1 << 20;
    int reps = 3, opt;
    while ((opt = getopt(argc, argv, "f:m:b:r:")) != -1) {
        switch (opt) {
        case 'f': path = optarg; break;
        case 'm': mode = optarg; break;
        case 'b': bs = parse_size(optarg); break;
        case 'r': reps = atoi(optarg); break;
        default: path = NULL; optind = argc; break;
        }
    }
    if (!path || bs == 0 || bs % 4096 || reps < 1) {
        fprintf(stderr, "usage: %s -f FILE [-m read|write|all] [-b block] [-r reps]\n",
                argv[0]);
        return 2;
    }
    int all = !strcmp(mode, "all");
    if (all || !strcmp(mode, "read"))
        run(path, 0, bs, reps);
    if (all || !strcmp(mode, "write"))
        run(path, 1, bs, reps);
    return 0;
}
