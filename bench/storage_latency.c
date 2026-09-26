/*
 * storage_latency.c - random 4 KiB I/O latency at queue depth 1.
 *
 * This is the storage equivalent of ram_latency: one request at a time,
 * each one waits for the previous to finish, random offsets. It is what a
 * program sees when it touches "memory" that actually lives on disk.
 *
 * Modes:
 *   read        random 4 KiB pread()  with O_DIRECT (bypasses the page cache)
 *   write       random 4 KiB pwrite() with O_DIRECT (no flush: the device may
 *               only have it in its volatile write cache when pwrite returns)
 *   write-sync  random 4 KiB pwrite() + fdatasync() after every write
 *               (durable write: includes a device cache flush)
 *
 * If the filesystem rejects O_DIRECT, the file is opened normally and
 * posix_fadvise(POSIX_FADV_DONTNEED) is used before each repetition to push
 * it out of the page cache; this is reported as "direct=no".
 *
 * NOTE: write modes overwrite random blocks of the test file. FILE may also
 * be a block device (e.g. /dev/nvme0n1) for a read-only test: -m read.
 *
 * Usage: storage_latency -f FILE [-m MODE[,MODE...]|all] [-n ops] [-T sec] [-r reps]
 *   -m  read (default), write, write-sync or all
 *   -n  max operations per repetition (default 20000)
 *   -T  max seconds per repetition   (default 10)
 *   -r  repetitions, median reported (default 3)
 *
 * Build: gcc -O2 -o storage_latency storage_latency.c
 */
#include "common.h"

#include <fcntl.h>
#include <linux/fs.h> /* BLKGETSIZE64 */
#include <sys/ioctl.h>
#include <sys/stat.h>

#define BS 4096

enum mode { M_READ, M_WRITE, M_WRITE_SYNC, M_COUNT };
static const char *mode_name[] = {"read", "write", "write-sync"};

/* Open with O_DIRECT if possible; *direct tells the caller what happened. */
static int open_file(const char *path, int flags, int *direct)
{
    int fd = open(path, flags | O_DIRECT);
    if (fd >= 0) {
        *direct = 1;
        return fd;
    }
    if (errno != EINVAL)
        die("open %s", path);
    fprintf(stderr, "warning: O_DIRECT not supported here, falling back to "
                    "buffered I/O + POSIX_FADV_DONTNEED\n");
    *direct = 0;
    fd = open(path, flags);
    if (fd < 0)
        die("open %s", path);
    return fd;
}

static void run_mode(const char *path, enum mode m, size_t max_ops,
                     double max_sec, int reps)
{
    int direct;
    int fd = open_file(path, m == M_READ ? O_RDONLY : O_WRONLY, &direct);
    struct stat st;
    if (fstat(fd, &st) != 0)
        die("fstat");
    uint64_t bytes = (uint64_t)st.st_size;
    if (S_ISBLK(st.st_mode) && ioctl(fd, BLKGETSIZE64, &bytes) != 0)
        die("BLKGETSIZE64"); /* a raw block device also works (use -m read!) */
    uint64_t nblocks = bytes / BS;
    if (nblocks < 16)
        die("test file too small");

    /* O_DIRECT needs the buffer, offset and length aligned to the logical
     * block size; 4096 covers every common device. */
    void *buf;
    if (posix_memalign(&buf, BS, BS) != 0)
        die("posix_memalign");
    fill_random(buf, BS, 7);

    uint64_t *lat = malloc(max_ops * sizeof(uint64_t));
    if (!lat)
        die("malloc");
    double avg[64], p50[64], p99[64];
    uint64_t seed = 0xC0FFEE ^ (uint64_t)m;
    if (reps > 64)
        reps = 64;

    for (int r = 0; r < reps; r++) {
        if (!direct)
            posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
        size_t n = 0;
        uint64_t deadline = now_ns() + (uint64_t)(max_sec * 1e9);
        for (int warm = -100; n < max_ops; warm++) { /* 100 untimed warm-up ops */
            off_t off = (off_t)(rng_below(&seed, nblocks) * BS);
            uint64_t t0 = now_ns();
            ssize_t rc;
            if (m == M_READ) {
                rc = pread(fd, buf, BS, off);
            } else {
                rc = pwrite(fd, buf, BS, off);
                if (rc == BS && m == M_WRITE_SYNC && fdatasync(fd) != 0)
                    die("fdatasync");
            }
            uint64_t t1 = now_ns();
            if (rc != BS)
                die("%s at offset %lld returned %zd", mode_name[m], (long long)off, rc);
            if (warm >= 0) {
                lat[n++] = t1 - t0;
                if (t1 > deadline)
                    break;
            }
        }
        lat_stats_t s = lat_summarize(lat, n);
        avg[r] = s.avg / 1e3; p50[r] = s.p50 / 1e3; p99[r] = s.p99 / 1e3;
        printf("storage_latency mode=%s direct=%s rep=%d ops=%zu avg_us=%.1f "
               "p50_us=%.1f p90_us=%.1f p99_us=%.1f p99.9_us=%.1f max_us=%.1f IOPS=%.0f\n",
               mode_name[m], direct ? "yes" : "no", r + 1, n, s.avg / 1e3, s.p50 / 1e3,
               s.p90 / 1e3, s.p99 / 1e3, s.p999 / 1e3, s.max / 1e3, 1e9 / s.avg);
        fflush(stdout);
    }
    printf("RESULT storage_latency mode=%s direct=%s median_avg_us=%.1f "
           "median_p50_us=%.1f median_p99_us=%.1f\n", mode_name[m],
           direct ? "yes" : "no", median_d(avg, reps), median_d(p50, reps),
           median_d(p99, reps));
    free(lat);
    free(buf);
    close(fd);
}

int main(int argc, char **argv)
{
    const char *path = NULL, *modes = "read";
    size_t max_ops = 20000;
    double max_sec = 10;
    int reps = 3, opt;
    while ((opt = getopt(argc, argv, "f:m:n:T:r:")) != -1) {
        switch (opt) {
        case 'f': path = optarg; break;
        case 'm': modes = optarg; break;
        case 'n': max_ops = strtoull(optarg, NULL, 0); break;
        case 'T': max_sec = atof(optarg); break;
        case 'r': reps = atoi(optarg); break;
        default: path = NULL; optind = argc; break;
        }
    }
    if (!path || max_ops == 0 || reps < 1) {
        fprintf(stderr, "usage: %s -f FILE [-m read|write|write-sync|all] "
                        "[-n ops] [-T sec] [-r reps]\n", argv[0]);
        return 2;
    }
    for (int m = 0; m < M_COUNT; m++) {
        /* run mode m if it appears in the comma-separated list (or "all") */
        int want = !strcmp(modes, "all");
        char list[256];
        snprintf(list, sizeof list, "%s", modes);
        for (char *tok = strtok(list, ","); tok && !want; tok = strtok(NULL, ","))
            want = !strcmp(tok, mode_name[m]);
        if (want)
            run_mode(path, m, max_ops, max_sec, reps);
    }
    return 0;
}
