# v.e.r.a WebSwap

**WebAssembly programlarına, gerçek belleklerinden çok daha büyük bir bellek veren sayfalama katmanı.**
Belleğe sığmayan sayfalar depolamaya taşınır: tarayıcıda siteye özel diske (OPFS), Node/Bun'da bir dosyaya.
Aynı `.wasm` dosyası tarayıcısı olan her cihaz için tasarlandı.

> **Ne yapmaz:** RAM eklemez, depolamayı RAM'e çevirmez, hiçbir şeyi hızlandırmaz.
> **Ne yapar:** Belleğe sığmadığı için çökecek bir işin, daha yavaş da olsa bitmesini sağlar ve bunun
> bedelini (kaç kat yavaşladı, diske ne kadar yazdı) açıkça gösterir.

Bu klasör, depodaki [fizibilite araştırmasının](../ARASTIRMA.md) devamıdır. Neden bu fikrin seçildiği ve hangi
öncüllerle karşılaştırıldığı [docs/FIKIR-ARASTIRMASI.md](docs/FIKIR-ARASTIRMASI.md) dosyasında.

---

## Bir örnekle

512 MiB bellek isteyen bir sıralama işi (256 MiB veri + aynı büyüklükte yardımcı dizi):

```
$ node host/node-run.mjs --app sort --mb 256 --baseline --cap 128M
sort 256 MiB, ordinary build, Memory capped at 128 MiB: FAILED (out of memory: malloc returned NULL)

$ node host/node-run.mjs --app sort --mb 256 --pool 32M --backend file
sort 256 MiB, WebSwap build: ok in 6919 ms, checksum 85bbd074979d1db4
Depolama: file. Sayfa havuzu: 32 MiB (gerçek wasm belleği: 36,8 MiB).
...
Not: Bu araç RAM eklemez, hiçbir şeyi hızlandırmaz. Belleğe sığmayan işin çökmeden, daha yavaş da olsa bitmesini sağlar.
```

Belleği 128 MiB ile sınırlanan normal sürüm çöküyor. WebSwap sürümü 36,8 MiB gerçek bellekle işi bitiriyor ve
sınırsız belleğe sahip normal sürümle **bit bit aynı** sonucu üretiyor. Bu makinede sınırsız normal sürüm
2,7 saniye, WebSwap 6,9 saniye sürdü: yaklaşık 2,6 kat yavaş.

---

## Nasıl çalışır?

WebAssembly'de işlemci düzeyinde sayfa hatası yok. Bu yüzden WebSwap bunu yazılımla yapıyor:

```
  C kaynak kodu
      │  clang (wasm32) + wasm-ld         tools/vera-build.mjs
      ▼
  program.wasm ──► dönüştürücü ──► program.vera.wasm   tools/instrument.mjs
                   her load/store'dan önce adres çevirisi

  Çalışırken:
  ┌──────────── gerçek WebAssembly.Memory (küçük, sabit) ─────────────┐
  │ veri + yığın │ sayfa tablosu (3,75 MiB) │ sayfa havuzu (ör. 32 MiB) │
  └───────────────────────────────────────────────────────────────────┘
          ▲ program 0x10000000 üstündeki "sanal" adresleri kullanır (~3,75 GiB)
          │ adres havuzda değilse → sayfa hatası → runtime/pager.mjs
          ▼
  depolama: OPFS (tarayıcı) · dosya (Node/Bun) · bellek · gecikme benzetimi
```

- **Dönüştürücü** (`tools/instrument.mjs`): Programdaki her bellek erişimini, satır içine yerleştirilen küçük
  bir adres çeviricisinden geçirir. Hizalı erişimler hızlı yoldan, hizasız olabilecekler bayt bayt güvenli yoldan
  gider (sayfa sınırını aşsa bile doğru çalışır).
- **Sıralama kuralı:** `*p = *q` gibi bir satırda, `q` okunurken oluşan sayfa hatası `p`'nin çerçevesini başka
  sayfaya vermiş olabilir. Bu yüzden saklanacak değer önce hesaplanır, hedef adres en son çevrilir.
- **Sayfalayıcı** (`runtime/pager.mjs`): CLOCK yer değiştirme, yalnızca değişmiş sayfaları diske yazma, hiç
  yazılmamış sayfaları diskten okumadan sıfırla doldurma, ardışık erişimde önden okuma, günlük yazma bütçesi.
- **Sayaç** (`runtime/meter.mjs`): Türkçe/İngilizce özet. Kaç sayfa hatası oldu, diske ne kadar yazıldı, havuz
  iki kat büyük olsaydı kaç okuma olurdu (yaklaşık tahmin).

---

## Sonuçlar

Ayrıntılı tablo: [results/BENCH.md](results/BENCH.md). Ortam: bulut sanal makinesi (4 vCPU, virtio disk).
Dosya depolamasında okumaları işletim sisteminin önbelleği hızlandırmış olabilir; sayılar gösterge niteliğinde.

| İş (erişim deseni) | İstenen bellek | Gerçek wasm belleği | Normal sürüm, bellek yarıya sınırlı | WebSwap, RAM'e göre | Yavaş depolamada (50/100 µs) | Diske yazılan |
|---|---:|---:|---|---:|---:|---:|
| **sort 1 GiB anahtar** (sıralı) | 2 GiB | 69 MiB | çöktü (256 MiB sınırı) | **1,8x** | — | 5 GB |
| sort (sıralı) | 128 MiB | 37 MiB | çöktü | 2,1x | 20x (ölçüldü) | 324 MiB |
| blur (2B yerellik) | 128 MiB | 37 MiB | çöktü | 1,3x | 9,7x (ölçüldü) | 128 MiB |
| rand (rastgele güncelleme) | 128 MiB | 37 MiB | çöktü | 6,0x | ~190x (tahmini) | 714 MiB |
| hash (rastgele + sıcak bölge) | 128 MiB | 37 MiB | çöktü | 46x | ~1.600x (tahmini) | 12,5 GB |
| chase (bağımlı rastgele) | 128 MiB | 37 MiB | çöktü | 63x | ~2.500x (tahmini) | 53 GB |

- Bütün WebSwap çalıştırmalarında sonuç, sınırsız belleğe sahip normal sürümle **aynı** (sağlama toplamı).
- "RAM'e göre" sütunu bellek içi ve dosya depolamayla ölçüldü; dosya okumalarını işletim sisteminin önbelleği
  hızlandırmış olabilir. "Yavaş depolamada" sütunu okuma başına 50 µs, yazma başına 100 µs gecikme ekler: sort ve
  blur için ölçüldü, diğerleri için tahmin edildi. Tahmin modeli, ölçülen iki durumda %4-6 isabetli çıktı.
- Her şey havuza sığdığında bile adres çevirisinin maliyeti: **1,4-3 kat** (rand 1,4x, blur 1,7x, hash 1,7x,
  sort 1,8x, chase 3,0x).
- chase ve hash'te maliyetin çoğu, hazırlık aşamasındaki rastgele yazmalardan geliyor. 128 MiB'lık bir dizi için
  diske 53 GB yazılması, rastgele yazmanın flaş belleği nasıl yıpratabileceğini gösteriyor. Sayaç ve günlük yazma
  bütçesi bu yüzden var.

**Özet:** Sıralı erişen işlerde (sıralama, görüntü işleme) bedel makul: birkaç kat. Rastgele erişen işlerde
(hash tablosu, rastgele güncelleme, işaretçi takibi) havuz küçüldükçe bedel onlarca, yavaş depolamada yüzlerce
hatta binlerce kata çıkıyor. Diske yazılan veri de gigabaytlara ulaşabiliyor. WebSwap bunu gizlemiyor,
sayacında gösteriyor.

### Doğruluk

- 29 otomatik test (`npm test`). En önemlisi: sayfalanan sürüm, normal sürümle **bit bit aynı** sonucu veriyor.
  Bu, 3 seed × 5 havuz/depolama ayarı ve 6 farklı uygulama ile kontrol ediliyor. Havuz 64 KiB'a (16 sayfa)
  kadar küçültülüyor.
- Tarayıcı testi (`node test/browser.mjs`): Chromium'da, bir Worker içinde OPFS'e sayfalayarak 3 uygulama
  çalışıyor; sonuçlar Node'daki normal sürümle aynı. Belleği sınırlanmış normal sürüm aynı işte çöküyor.
- Çalışma ortamı testi (`node test/cross-runtime.mjs`): Node (V8) ve Bun (JavaScriptCore) aynı sonucu veriyor.

---

## Hemen dene

Gerekenler: Node.js 18+ (22 ile test edildi). Yalnızca kendi C programını derlemek için clang (wasm32 hedefi)
ve wasm-ld (LLVM 16+). Demo programlar `build/` klasöründe hazır derlenmiş olarak geliyor.

```sh
cd webswap
npm install                      # binaryen (dönüştürücü için)
npm test                         # derle + 29 test

# Komut satırından
node host/node-run.mjs --app sort --mb 256 --pool 32M --backend file
node host/node-run.mjs --app hash --mb 64 --ops 300000 --pool 8M --lang en

# Tarayıcıda (bilgisayar, telefon, tablet)
node host/web/serve.mjs 8080     # sonra http://127.0.0.1:8080/host/web/ adresini aç
```

Tarayıcı sayfasında programı ve boyutları seçip "WebSwap ile çalıştır" ve "Normal sürümü dene" düğmelerini
karşılaştırabilirsin. "Cihaz ölçümü" düğmesi, o cihazdaki OPFS gecikmesini ve alınabilen en büyük belleği ölçer.
Bir telefonda denemek için sunucunun o telefondan erişilebilir olması gerekir. OPFS güvenli bağlam ister:
`127.0.0.1` ya da HTTPS.

---

## Kendi programını WebSwap ile derlemek

```c
// benim.c
#include "vera.h"

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    u8 *buf = malloc((size_t)mbytes << 20);   // sanal bölgeden gelir (gerekirse GB'larca)
    if (!buf) { vera_app_status = 1; return 0; }
    /* ... normal C kodu ... */
    return 0;
}
```

```sh
node tools/vera-build.mjs benim.c -o build/benim   # build/benim.vera.wasm + build/benim.base.wasm
```

```js
import { createVera } from './runtime/vera.mjs';
import { OPFSSyncBackend } from './runtime/backends.mjs';   // tarayıcıda, bir Worker içinde

const vera = await createVera({
  wasm: await (await fetch('build/benim.vera.wasm')).arrayBuffer(),
  poolBytes: 32 << 20,                            // ya da 'auto'
  backend: await OPFSSyncBackend.open('benim.bin'),
  writeBudgetBytesPerDay: 1 << 30,                // günlük yazma bütçesi
  onBudget: 'warn',                               // ya da 'throw'
});
vera.exports.run(1024, 0, 1);
console.log(vera.meter('tr'));
```

Programa bayt vermek ya da programdan bayt almak için `vera.write(adres, baytlar)`, `vera.read(adres, uzunluk)`
ve `vera.readCString(adres)` kullanılır. Bellek ayırmak için `vera.exports.vera_malloc(n)`.

---

## Hangi cihazlarda?

| Ortam | Durum |
|---|---|
| Linux, Node 22 (bellek, dosya, gecikme benzetimi) | **Test edildi** |
| Linux, Bun 1.3 (JavaScriptCore motoru) | **Test edildi** |
| Linux, headless Chromium 141, Worker + OPFS | **Test edildi** |
| Windows / macOS / ChromeOS: Chrome, Edge (102+), Firefox (111+), Safari (17+) | Aynı dosya; **denenmedi** |
| Android: Chrome, Samsung Internet | Aynı dosya; **denenmedi** |
| iPhone / iPad: Safari 17+ | Aynı dosya; **denenmedi**. En büyük faydanın beklendiği yer, çünkü iOS'ta uygulamalar için swap yok |

Masaüstünde işletim sistemi zaten swap yaptığı için fayda sınırlı. Asıl hedef, belleği sıkı sınırlanmış telefon
tarayıcıları. Bunun doğrulanması, gerçek cihazlarda test gerektiriyor.

---

## Sınırlamalar

- **Yavaşlık:** Her bellek erişimine adres çevirisi eklendiği için, her şey havuza sığsa bile ölçümlerde 1,4-3 kat
  yavaşlama oldu. Havuza sığmayan rastgele erişimde yavaşlama çok daha büyüktür (yukarıdaki tablo).
- **Desteklenmeyenler:** Toplu bellek komutları (bulk memory), SIMD, iş parçacıkları/atomikler, `memory.grow`,
  memory64. Dönüştürücü bunları görünce ne yapılması gerektiğini söyleyen bir hata verir.
- **Yalnızca C (şimdilik):** Freestanding C ve `vera.h` içindeki küçük libc. Rust, Zig ve Emscripten
  uyarlamaları yapılmadı.
- **Hizasız "hizalı" erişim:** Hizalı olduğunu iddia edip hizasız bir adresle sayfa sınırını aşan erişim
  (C'de tanımsız davranış) sessizce bozmak yerine anlaşılır bir hata ile durur.
- **Sayfa sınırı ötesindeki tahminler:** "Havuz iki kat olsaydı" tahmini LRU için kesin, çalışan CLOCK
  algoritması için yaklaşıktır.
- **Güvenlik:** Diske taşınan sayfalar şifrelenmeden OPFS'te durur (sitenin diğer verileriyle aynı güven düzeyi).
- **Zamanlayıcı:** Tarayıcılar `performance.now()` hassasiyetini düşürdüğü için, tek tek sayfa hatası süreleri
  tarayıcıda ölçülemez. Sayaç bunu belirtir.
- **Flaş aşınması:** Rastgele yazan işler diske gigabaytlarca yazabilir. Günlük yazma bütçesi uyarır ya da işi
  durdurur (`onBudget: 'throw'`).

---

## Dosya düzeni

```
tools/vera-build.mjs     C → paged .vera.wasm + normal .base.wasm
tools/instrument.mjs     binaryen.js dönüştürücüsü (doğrulama + her load/store'u çevirme)
tools/build-all.mjs      demo programları derle
runtime/vera.h           tipler, küçük libc bildirimleri, yardımcılar
runtime/vera-libc.c      malloc/free/memcpy/... (sanal bölgede)
runtime/softmmu.c        adres çevirici ve bayt bayt güvenli yol
runtime/pager.mjs        sayfa hatası işleyicisi (CLOCK, dirty, önden okuma, bütçe, tahmin)
runtime/backends.mjs     depolama: bellek, dosya, OPFS, gecikme benzetimi
runtime/vera.mjs         createVera(), instantiateBase(), read/write köprüsü
runtime/meter.mjs        TR/EN sayaç
apps/                    demo programlar: sort, blur, hash, rand, chase, packed, fuzz
host/node-run.mjs        komut satırı
host/web/                tarayıcı sayfası + Worker + küçük sunucu
test/                    29 test + tarayıcı + çalışma ortamı testleri
bench/run-all.mjs        ölçüm matrisi → results/BENCH.md
```

---

## English summary

**v.e.r.a WebSwap** is a build-time transform plus a small runtime that gives C programs compiled to
WebAssembly a heap of up to ~3.75 GiB while their real `WebAssembly.Memory` stays small (e.g. 36 MiB). It pages
4 KiB pages synchronously to the browser's Origin Private File System, or to a file under Node/Bun. Every
load/store is rewritten (binaryen.js) to go through an inlined software MMU. The paged build is bit-identical to
the ordinary build across all tests. The runtime uses CLOCK with sampled reference bits, dirty tracking,
zero-page elision, sequential readahead, a daily flash-write budget, and a bilingual meter.

It is **not** faster and adds no RAM. It turns "out of memory, tab crashed" into "finished, slower", and it
measures and reports the cost. As far as we could find (September 2026), no general drop-in demand-paging layer
for WebAssembly linear memory in browsers exists. The mechanism itself is well known: software page tables with
flash paging (ViMem 2007, t-kernel 2006), wasm software MMUs (WAVEN 2025, nix-wasm 2026), and app-specific
OPFS paging (Photoshop web). See [docs/FIKIR-ARASTIRMASI.md](docs/FIKIR-ARASTIRMASI.md).

Tested: Linux with Node 22 and Bun 1.3, and headless Chromium 141 (Worker + OPFS). Not yet tested: Safari, iOS,
Android, Firefox, Windows, macOS.
