/*
 * ram_bandwidth.c - sequential DRAM bandwidth: read, write and copy.
 *
 *   read   : sum all 64-bit words of the buffer          (bytes read / s)
 *   write  : memset the buffer                            (bytes written / s)
 *   copy   : memcpy(dst, src, size)                       (bytes copied / s;
 *            the memory bus actually moves 2-3x this: read src, write dst,
 *            and possibly read dst for write-allocate)
 *
 * With -t N the buffer is split into N contiguous slices, one per thread,
 * and the aggregate throughput is reported. 1 GB/s = 1e9 bytes/s.
 *
 * Usage: ram_bandwidth [-s size] [-r reps] [-t threads]
 *   -s  buffer size (default 1G; copy uses a second buffer of the same size)
 *   -r  repetitions, median reported (default 5; cheap, and bandwidth is noisy)
 *   -t  threads (default 1)
 *
 * Build: gcc -O2 -pthread -o ram_bandwidth ram_bandwidth.c
 */
#include "common.h"

#include <pthread.h>
#include <sys/mman.h>

enum op { OP_READ, OP_WRITE, OP_COPY };
static const char *op_name[] = {"read", "write", "copy"};

typedef struct {
    enum op op;
    uint8_t *src, *dst;
    size_t len;
    pthread_barrier_t *start;
    uint64_t result; /* read: checksum, so the loop cannot be optimized out */
} job_t;

/* Sum 64-bit words with 4 independent accumulators so the adds are not a
 * serial dependency chain; the loop is limited by memory, not by the CPU. */
static uint64_t sum_words(const uint64_t *p, size_t n)
{
    uint64_t a = 0, b = 0, c = 0, d = 0;
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        a += p[i]; b += p[i + 1]; c += p[i + 2]; d += p[i + 3];
    }
    for (; i < n; i++)
        a += p[i];
    return a + b + c + d;
}

static void do_job(job_t *j)
{
    switch (j->op) {
    case OP_READ:  j->result = sum_words((const uint64_t *)j->src, j->len / 8); break;
    case OP_WRITE: memset(j->dst, 0x5A, j->len); break;
    case OP_COPY:  memcpy(j->dst, j->src, j->len); break;
    }
}

static void *thread_main(void *arg)
{
    job_t *j = arg;
    pthread_barrier_wait(j->start); /* all threads start together */
    do_job(j);
    return NULL;
}

static volatile uint64_t g_sink;

/* One timed pass of `op` over the whole buffer with `nt` threads -> GB/s. */
static double run_once(enum op op, uint8_t *src, uint8_t *dst, size_t size, int nt)
{
    pthread_t th[64];
    job_t jobs[64];
    pthread_barrier_t start;
    size_t slice = (size / nt) & ~(size_t)4095;

    pthread_barrier_init(&start, NULL, nt + 1);
    for (int i = 0; i < nt; i++) {
        size_t off = (size_t)i * slice;
        jobs[i] = (job_t){op, src + off, dst + off,
                          i == nt - 1 ? size - off : slice, &start, 0};
        if (pthread_create(&th[i], NULL, thread_main, &jobs[i]) != 0)
            die("pthread_create");
    }
    pthread_barrier_wait(&start); /* release the workers ... */
    uint64_t t0 = now_ns();       /* ... and start the clock */
    for (int i = 0; i < nt; i++) {
        pthread_join(th[i], NULL);
        g_sink += jobs[i].result;
    }
    uint64_t t1 = now_ns();
    pthread_barrier_destroy(&start);
    return (double)size / (double)(t1 - t0); /* bytes/ns == GB/s */
}

static uint8_t *alloc_buf(size_t size)
{
    uint8_t *p = mmap(NULL, size, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED)
        die("mmap %zu bytes", size);
    return p;
}

int main(int argc, char **argv)
{
    size_t size = 1ull << 30;
    int reps = 5, nt = 1, opt;
    while ((opt = getopt(argc, argv, "s:r:t:")) != -1) {
        switch (opt) {
        case 's': size = parse_size(optarg); break;
        case 'r': reps = atoi(optarg); break;
        case 't': nt = atoi(optarg); break;
        default:
            fprintf(stderr, "usage: %s [-s size] [-r reps] [-t threads]\n", argv[0]);
            return 2;
        }
    }
    if (nt < 1 || nt > 64 || reps < 1 || reps > 64)
        die("threads must be 1..64, reps 1..64");

    uint8_t *src = alloc_buf(size), *dst = alloc_buf(size);
    /* Touch every page first so page faults are not part of the timing. */
    fill_random(src, size, 42);
    memset(dst, 1, size);

    char sz[32];
    for (int op = OP_READ; op <= OP_COPY; op++) {
        double gbs[64];
        run_once(op, src, dst, size, nt); /* warm-up pass */
        for (int r = 0; r < reps; r++) {
            gbs[r] = run_once(op, src, dst, size, nt);
            printf("ram_bandwidth op=%s size=%s threads=%d rep=%d GB/s=%.2f\n",
                   op_name[op], fmt_size(size, sz, sizeof sz), nt, r + 1, gbs[r]);
            fflush(stdout);
        }
        printf("RESULT ram_bandwidth op=%s size=%s threads=%d median_GB/s=%.2f\n",
               op_name[op], fmt_size(size, sz, sizeof sz), nt, median_d(gbs, reps));
    }
    munmap(src, size);
    munmap(dst, size);
    return 0;
}
