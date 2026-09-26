/*
 * blur.c - 3x3 box blur over a square RGBA image of mbytes MiB, repeated
 * `ops` times (default 2). Row-by-row stencil: 2D locality.
 */
#include "vera.h"

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    u32 px = (mbytes << 20) / 4, w = 1;
    while ((w + 1) * (w + 1) <= px) w++;
    u32 hgt = w;
    u32 *img = malloc((size_t)w * hgt * 4), *out = malloc((size_t)w * hgt * 4);
    if (!img || !out) { vera_app_status = 1; return 0; }
    u64 s = seed;
    for (u32 i = 0; i < w * hgt; i++) img[i] = (u32)vera_rng(&s);
    if (!ops) ops = 2;
    for (u32 it = 0; it < ops; it++) {
        for (u32 y = 0; y < hgt; y++) {
            for (u32 x = 0; x < w; x++) {
                u32 r = 0, g = 0, b = 0, a = 0, k = 0;
                for (int dy = -1; dy <= 1; dy++) {
                    int yy = (int)y + dy;
                    if (yy < 0 || yy >= (int)hgt) continue;
                    for (int dx = -1; dx <= 1; dx++) {
                        int xx = (int)x + dx;
                        if (xx < 0 || xx >= (int)w) continue;
                        u32 p = img[(u32)yy * w + (u32)xx];
                        r += p & 255; g += (p >> 8) & 255; b += (p >> 16) & 255; a += p >> 24; k++;
                    }
                }
                out[y * w + x] = (r / k) | ((g / k) << 8) | ((b / k) << 16) | ((a / k) << 24);
            }
        }
        u32 *t = img; img = out; out = t;
    }
    u64 h = 0;
    for (u32 i = 0; i < w * hgt; i++) h = vera_mix(h, img[i]);
    return h;
}
