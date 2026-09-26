# v.e.r.a WebSwap

**WebAssembly'ye derlenen C programlarına, gerçek wasm belleklerinden çok daha büyük bir bellek veren sayfalama katmanı.**
Belleğe sığmayan sayfalar depolamaya taşınır: tarayıcıda siteye özel diske (OPFS), Node/Bun'da bir dosyaya.
Aynı `.wasm` dosyası tarayıcısı olan her cihaz için tasarlandı.

> **Ne yapmaz:** RAM eklemez, depolamayı RAM'e çevirmez, hiçbir şeyi hızlandırmaz. Hazır `.wasm` dosyalarıyla
> çalışmaz: program kaynak koddan WebSwap ile yeniden derlenir (şimdilik freestanding C).
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

$ node host/node-run.mjs --app sort --mb 256 --baseline
sort 256 MiB, ordinary build: ok in 2732 ms, checksum 85bbd074979d1db4, Memory 513 MiB

$ node host/node-run.mjs --app sort --mb 256 --pool 32M --backend file
vera: this run's storage write budget exceeded (1024 MiB > 1024 MiB)
sort 256 MiB, WebSwap build: ok in 7173 ms, checksum 85bbd074979d1db4
Depolama: file. Sayfa havuzu: 32 MiB (gerçek wasm belleği: 36,8 MiB).
(Dosya depolaması: işletim sisteminin dosya önbelleği okumaları hızlandırmış olabilir; soğuk disk daha yavaştır.)
Sayfa hataları: 270369 diskten okuma, 131074 boş (sıfır) sayfa, 519685 ucuz yeniden eşleme (G/Ç yok).
Diskten okunan: 3.072 MiB (516061 sayfa önden okundu). Diske yazılan: 1.284 MiB (bu çalıştırmanın yazma bütçesi: %125,4, bütçe aşıldı).
Diske giden bir sayfa hatası: ortanca ≤8 µs, en yavaş %1 hariç ≤128 µs (RAM erişimi ~0,1 µs).
Toplam süre: 7.173,5 ms. Sayfa hatalarında geçen pay: ~%38,4.
Tahmin (yaklaşık): diskten sayfa okuma sayısı şu an 270369; 2 kat havuzla ~270199, 4 kat havuzla ~269387.
Not: Bu araç RAM eklemez, hiçbir şeyi hızlandırmaz. Belleğe sığmayan işin çökmeden, daha yavaş da olsa bitmesini sağlar.
```

Belleği 128 MiB ile sınırlanan normal sürüm çöküyor. WebSwap sürümü 36,8 MiB wasm belleğiyle işi bitiriyor
ve sınırsız belleğe sahip normal sürümle **aynı 64 bit sağlama toplamını** üretiyor. Bu makinede sınırsız normal
sürüm 2,7 saniye, WebSwap 7,2 saniye sürdü: yaklaşık 2,6 kat yavaş. Takas dosyası bu makinenin
bol RAM'i sayesinde işletim sisteminin dosya önbelleğinde kaldı; gerçekten diske giden okumalarda fark daha büyük olur.

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
  gider (sayfa sınırını aşsa bile doğru çalışır). Yığın işaretçisinin her değişimi denetlenir: yığın taşarsa
  program sanal bölgeye sessizce yazmak yerine anlaşılır bir hatayla durur.
- **Sıralama kuralı:** `*p = *q` gibi bir satırda, `q` okunurken oluşan sayfa hatası `p`'nin çerçevesini başka
  sayfaya vermiş olabilir. Bu yüzden saklanacak değer önce hesaplanır, hedef adres en son çevrilir. Kuralı
  bozan bir sürümün bu testi geçemediği de ayrıca sınanıyor.
- **Sayfalayıcı** (`runtime/pager.mjs`): CLOCK yer değiştirme, yalnızca değişmiş sayfaları diske yazma, hiç
  yazılmamış sayfaları diskten okumadan sıfırla doldurma (tamamı sıfır kalan sayfaları hiç yazmama), ardışık
  erişimde önden okuma ve bir yazma bütçesi.
- **Yazma bütçesi:** Diske yazılan bayt, 24 saatlik bir pencerede sayılır (varsayılan 1 GiB). Bir bütçe deposu
  verilirse (`FileBudgetStore`, tarayıcıda `OPFSBudgetStore`) sayım çalıştırmalar arasında birikir; verilmezse
  yalnızca o çalıştırmayı kapsar. Aşılınca bir kez uyarır ya da işi durdurur (`onBudget: 'throw'`). Uyarı,
  sayfa hatasının içinde değil, hata döndükten sonra iletilir.
- **Sayaç** (`runtime/meter.mjs`): Türkçe/İngilizce özet. Kaç sayfa hatası oldu, diske ne kadar yazıldı, havuz
  iki ya da dört kat büyük olsaydı diskten kaç sayfa okunurdu (yaklaşık tahmin).

---

## Sonuçlar

Ayrıntılı tablo: [results/BENCH.md](results/BENCH.md). Ortam: bulut sanal makinesi (4 vCPU, 15,7 GiB RAM, virtio
disk). Her hücre tek ölçüm; aynı makinede tekrarlarda %10-30 oynama beklenir.

| İş (erişim deseni) | İstenen bellek | wasm belleği | Normal sürüm, bellek yarıya sınırlı | WebSwap, bellek içi depolama¹ | WebSwap, dosya² | Yavaş depolamada (50/100 µs)³ | Diske yazılan |
|---|---:|---:|---|---:|---:|---:|---:|
| **sort 1 GiB anahtar** (sıralı) | 2 GiB | 69 MiB | çöktü (256 MiB sınırı) | — | **2,0x** | — | 5,0 GiB |
| sort (sıralı) | 128 MiB | 37 MiB | çöktü | 1,9x | 2,3x | 18,7x (ölçüldü) | 324 MiB |
| blur (2B yerellik) | 128 MiB | 37 MiB | çöktü | 1,6x | 1,6x | 10,7x (ölçüldü) | 128 MiB |
| rand (rastgele güncelleme) | 128 MiB | 37 MiB | çöktü | 5,9x | 6,8x | ~178x (tahmini) | 714 MiB |
| hash (rastgele + sıcak bölge) | 128 MiB | 37 MiB | çöktü | 50,4x | 61,6x | ~1.600x (tahmini) | 12,1 GiB |
| chase (bağımlı rastgele) | 128 MiB | 37 MiB | çöktü | 57,2x | 72,4x | ~2.000x (tahmini) | 51,9 GiB |

1. **Bellek içi depolama:** Sayfalar JavaScript belleğinde tutulur. Yalnızca sayfalama politikasının ve adres
   çevirisinin maliyetini ölçer; gerçek bir cihazda bu depolama anlamsızdır.
2. **Dosya:** Gerçek bir dosya. Bu makinede 15,7 GiB RAM olduğu için takas dosyası (manşet satırında da) büyük
   ölçüde işletim sisteminin dosya önbelleğinde kaldı. Yani bu sütun "sıcak önbellek" durumudur; soğuk bir diskte,
   ya da RAM'i az bir telefonda daha yavaş olur.
3. **Yavaş depolama:** Her okumaya 50 µs, her yazmaya 100 µs eklenir. sort ve blur için bu gecikmeyle gerçekten
   ölçüldü; diğerleri için bellek içi süre + (okuma × 50 µs + yazma × 100 µs) olarak tahmin edildi. Bu tahmin
   modeli, ölçülen iki durumda %3-4 sapmayla tuttu.

- Bütün WebSwap çalıştırmalarında sonuç, sınırsız belleğe sahip normal sürümle **aynı** (64 bit sağlama toplamı).
- "wasm belleği", programın gerçek `WebAssembly.Memory` boyutudur. Buna ek olarak sayfalayıcı, JavaScript tarafında
  havuz boyutundan bağımsız yaklaşık 13 MiB'lık sabit bir tablo tutar (dayanıklı kipte ~2 MiB daha).
- Her şey havuza sığdığında bile adres çevirisinin maliyeti: **1,3-2,6 kat** (rand 1,3x, hash 1,7x, blur 1,8x, sort 1,9x, chase 2,6x).
- chase ve hash'te maliyetin çoğu, hazırlık aşamasındaki rastgele yazmalardan geliyor. 128 MiB'lık bir dizi için
  diske 51,9 GiB yazılması, rastgele yazmanın flaş belleği nasıl yıpratabileceğini gösteriyor. Sayaç ve yazma
  bütçesi bu yüzden var.

**Özet:** Sıralı erişen işlerde (sıralama, görüntü işleme) bedel, takas dosyası önbellekteyken ~1,6-2,3 kat, yavaş
depolamada ~10-20 kat. Rastgele erişen işlerde (hash tablosu, rastgele güncelleme, işaretçi takibi) havuz
küçüldükçe bedel onlarca, yavaş depolamada yüzlerce hatta binlerce kata çıkıyor. Diske yazılan veri de
gigabaytlara ulaşabiliyor. WebSwap bunu gizlemiyor, sayacında gösteriyor.

### Doğruluk

- 54 otomatik test (`npm test`). En önemlisi: sayfalanan sürüm, normal sürümle aynı 64 bit sağlama toplamını
  veriyor. Bunu iki grup test kontrol ediyor: her yükleme/saklama türünü, hizasız ve sayfa sınırını aşan
  erişimleri deneyen `fuzz` programı 3 seed × 5 havuz/depolama ayarıyla (havuz 64 KiB'a, yani 16 sayfaya kadar
  küçültülüyor) ve 6 demo program, verinin %25'i kadar havuz ve dosya depolamayla.
- Sağlamlık testleri: sıralama kuralı (ve onu bozan sürümün yakalanması), yığın taşması, bellek ayırıcının
  parçalanmaya dayanıklılığı, `calloc`'un yeni bellek için diske yazmaması, 6000 dallı bir `switch` (derin iç içe
  kod), çok büyük fonksiyonların hızlı derlenmesi, takas dosyasının izinleri ve bütçe deposu.
- Tarayıcı testi (`node test/browser.mjs`): Chromium'da, bir Worker içinde OPFS'e sayfalayarak 3 uygulama
  çalışıyor; sonuçlar Node'daki normal sürümle aynı. Belleği sınırlanmış normal sürüm aynı işte çöküyor. OPFS'te
  takas dosyası kalmıyor (öldürülen sekmeden kalan eski dosya temizleniyor), yazma bütçesi OPFS'e kaydediliyor.
  Sayfa, kontrol noktasından sonra yeniden yüklendiğinde OPFS'ten kaldığı yerden devam ediyor.
- Çalışma ortamı testi (`node test/cross-runtime.mjs`): Node (V8) ve Bun (JavaScriptCore) aynı sonucu veriyor.

---

## Hemen dene

Gerekenler: Node.js 18+ (22 ile test edildi). Demo programlar `build/` klasöründe hazır derlenmiş olarak
geliyor; clang yoksa `npm test` bunları kullanır. Kendi C programını derlemek için clang (wasm32 hedefi) ve
wasm-ld (LLVM 16+) gerekir.

```sh
cd webswap
npm install                      # binaryen (dönüştürücü için)
npm test                         # derle (clang varsa) + 54 test

# Komut satırından
node host/node-run.mjs --app sort --mb 256 --pool 32M --backend file
node host/node-run.mjs --app hash --mb 64 --ops 300000 --pool 8M --lang en

# Tarayıcıda
node host/web/serve.mjs 8080     # sonra http://127.0.0.1:8080/host/web/ adresini aç
```

Tarayıcı sayfasında programı ve boyutları seçip "WebSwap ile çalıştır" ve "Normal sürümü dene" düğmelerini
karşılaştırabilirsin. "Cihaz ölçümü" düğmesi, o cihazdaki OPFS gecikmesini (sıcak önbellek, yani alt sınır) ve
tarayıcının ayırabildiği en büyük wasm belleğini (üst sınır: adres alanı ayrılması, o kadar RAM olduğu anlamına
gelmez) gösterir.

**Telefonda denemek:** OPFS güvenli bağlam ister: `127.0.0.1`/`localhost` ya da HTTPS. Sunucu yalnızca
`127.0.0.1`'i dinler, bu yüzden telefondan `http://<bilgisayarın-ip>:8080` çalışmaz. Android'de USB ile
`adb reverse tcp:8080 tcp:8080` yapıp telefonda `http://localhost:8080/host/web/` açılabilir. iPhone/iPad için
sayfanın HTTPS üzerinden sunulması gerekir (ör. geçerli sertifikalı bir sunucu ya da tünel).

---

## Kendi programını WebSwap ile derlemek

```c
// benim.c - freestanding C: yalnızca vera.h içindeki küçük libc (malloc, free, memcpy, ...)
#include "vera.h"

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    u8 *buf = malloc((size_t)mbytes << 20);   // sanal bölgeden gelir (gerekirse GiB'larca)
    if (!buf) { vera_app_status = 1; return 0; }
    /* ... normal C kodu ... */
    free(buf);
    return 0;
}
```

```sh
node tools/vera-build.mjs benim.c -o build/benim   # build/benim.vera.wasm + build/benim.base.wasm
node tools/vera-build.mjs benim.c -o build/benim --stack-size 4M   # yığın varsayılanı 1 MiB
```

```js
// Tarayıcıda, bir Worker içinde (OPFS'in eşzamanlı erişimi yalnızca Worker'da var)
import { createVera } from './runtime/vera.mjs';
import { OPFSSyncBackend, OPFSBudgetStore } from './runtime/backends.mjs';

await OPFSSyncBackend.sweep();                    // öldürülen sekmelerden kalan takas dosyalarını sil
const swap = await OPFSSyncBackend.open();        // vera-swap-*.bin, kapatınca silinir
try {
  const vera = await createVera({
    wasm: await (await fetch('build/benim.vera.wasm')).arrayBuffer(),
    poolBytes: 32 << 20,                          // ya da 'auto'
    backend: swap,
    writeBudgetBytes: 1 << 30,                    // 24 saatlik yazma bütçesi
    budgetStore: new OPFSBudgetStore(),           // bütçe çalıştırmalar arasında birikir
    onBudget: 'warn',                             // ya da 'throw'
    onEvent: (e) => console.log(e),               // bütçe uyarısı buraya gelir
  });
  vera.exports.run(1024, 0, 1);
  console.log(vera.meter('tr'));
  vera.close();
} finally {
  await swap.closeAsync();
}
```

Programa bayt vermek ya da programdan bayt almak için `vera.write(adres, baytlar)`, `vera.read(adres, uzunluk)`
ve `vera.readCString(adres)` kullanılır. Bellek ayırmak için `vera.exports.vera_malloc(n)`. Node/Bun'da
`NodeFileBackend(fs, yol)` kullanılır: dosya yalnızca sahibinin okuyabileceği izinle (0600) oluşturulur, var olan
bir dosyanın üzerine yazmaz ve kapatınca silinir.

---

## Kaldığı yerden devam: dayanıklı kontrol noktaları

Telefonlar bellek azalınca arka plandaki sekmeleri ve uygulamaları sık sık öldürür. WebSwap'ın bellek sayfaları
zaten diskte durduğu için, programın bütün durumunu tutarlı bir anda "mühürleyip" sonra oradan devam etmek mümkün:

```js
import { OPFSStore } from './runtime/durable.mjs';          // Node'da: NodeFileStore
const vera = await createVera({ wasm, poolBytes: 32 << 20,
  durableStore: await OPFSStore.open('benim-heap.bin'), resume: true });
if (vera.resumed) console.log('kaldığı yerden:', vera.resumed.extra);   // ör. { adim: 120 }
else vera.exports.init();
// ... çalış ...
vera.checkpoint({ adim: 120 });   // programın içindeyken değil, çağrılar arasında
```

- **Çift yuvalı gölge sayfalama:** Kontrol noktasından sonra bir sayfa hiçbir zaman kaydedilmiş sürümün üzerine
  yazılmaz; yeni sürüm sayfanın ikinci yuvasına gider. Sayfa haritası, programın düşük belleği (değişkenler,
  bellek ayırıcının durumu) ve CRC korumalı başlık da iki kopya tutulur. Kontrol noktası yazılırken işlem
  öldürülse bile, bir önceki tutarlı duruma dönülür.
- **Test edildi:**
  - Alt süreç, çalışmanın başından sonuna yayılmış anlarda 20 kez `SIGKILL` ile öldürüldü. Her yeniden başlatmada
    kaldığı yerden devam etti ve tamamlandığı bildirilen hiçbir kontrol noktası kaybolmadı. Son sonuç kesintisiz
    çalışmayla aynı.
  - Kontrol noktasının her aşamasında (sayfa haritası, düşük bellek, `fsync`, yarım yazılmış başlık, tamamlanma)
    süreç bilerek öldürüldü: tamamlanmamış kontrol noktasında bir öncekine, tamamlanmışta ona dönüldü.
  - Başlık, sayfa haritası ya da kaydedilen bellek bozulduğunda önceki kontrol noktasına dönülüyor.
  - Chromium'da sayfa yeniden yüklenince OPFS'ten devam ediliyor.
- **Neyi test etmedik:** `SIGKILL` işlemin çökmesini sınar; işletim sistemi ayakta kaldığı için yazılanlar
  dosya önbelleğinde durur. Elektrik kesintisine karşı koruma, `fsync`'in ve diskin buna gerçekten uymasına
  dayanır; bu test edilmedi.
- **Sınırlar:** Kontrol noktası yalnızca programa yapılan çağrıların arasında alınabilir. Son kontrol noktasından
  sonraki iş kaybolur. Diskte kapladığı yer, kullanılan belleğin yaklaşık iki katıdır. Yazma sırasındaki
  kesintiye karşı korur, sonradan bozulan diske karşı korumaz.
- **Öncüller:** Wasm için anlık görüntü alıp geri yükleme yeni değil: wasm-persist (2018), Weave (2026), vpod
  (2026), Pyodide/Wasmer anlık görüntüleri. Buradaki katkı, talep üzerine sayfalanan bir yığının OPFS'te çökmeye
  dayanıklı biçimde saklanması ve tembel olarak geri yüklenmesi.

---

## Hangi cihazlarda?

| Ortam | Durum |
|---|---|
| Linux, Node 22 (bellek, dosya, gecikme benzetimi) | **Test edildi** |
| Linux, Bun 1.3 (JavaScriptCore motoru) | **Test edildi** |
| Linux, headless Chromium 141, Worker + OPFS | **Test edildi** |
| Windows / macOS / ChromeOS: Chrome, Edge (108+), Firefox (114+), Safari (17+) | Aynı dosya; **denenmedi** |
| Android: Chrome, Samsung Internet | Aynı dosya; **denenmedi** |
| iPhone / iPad: Safari 17+ | Aynı dosya; **denenmedi** |

Sürüm alt sınırları, OPFS'in eşzamanlı erişim tutamacının (`FileSystemSyncAccessHandle`) tam eşzamanlı
çalıştığı sürümlerdir; eski Chromium'larda (102-107) bu yöntemler eşzamansızdı ve WebSwap orada çalışmayı
reddeder. Masaüstünde işletim sistemi zaten swap yaptığı için fayda sınırlı. Asıl hedef, belleği sıkı
sınırlanmış telefon tarayıcıları: iPhone'da (ve M çipsiz iPad'lerde) uygulamalar için swap yok; M çipli
iPad'lerde iPadOS 16'dan beri sistem swap'ı var. Bunun doğrulanması, gerçek cihazlarda test gerektiriyor.

---

## Sınırlamalar

- **Yavaşlık:** Her bellek erişimine adres çevirisi eklendiği için, her şey havuza sığsa bile ölçümlerde
  1,3-2,6 kat yavaşlama oldu. Havuza sığmayan rastgele erişimde yavaşlama çok daha büyüktür (yukarıdaki tablo).
- **Yeniden derleme şart:** Hazır `.wasm` dosyaları çalışmaz; program WebSwap ile kaynak koddan derlenir.
  Şimdilik yalnızca freestanding C ve `vera.h` içindeki küçük libc. Rust, Zig ve Emscripten uyarlamaları yapılmadı.
- **Desteklenmeyenler:** Toplu bellek komutları (bulk memory), SIMD, iş parçacıkları/atomikler, `memory.grow`,
  memory64. Dönüştürücü bunları görünce ne yapılması gerektiğini söyleyen bir hata verir.
- **Yığın:** Varsayılan 1 MiB (`--stack-size` ile değişir). Taşarsa program anlaşılır bir hatayla durur.
- **Çok büyük fonksiyonlar:** Yüzlerce bellek erişimi içeren bir fonksiyonda (ör. binlerce dallı bir `switch`)
  adres çevirisi satır içine açılmaz, çağrı olarak kalır; derleme saniyeler içinde biter ama o fonksiyon biraz daha
  yavaş çalışır.
- **Hizasız "hizalı" erişim:** Hizalı olduğunu iddia edip hizasız bir adresle sayfa sınırını aşan erişim
  (C'de tanımsız davranış) sessizce bozmak yerine anlaşılır bir hata ile durur.
- **Adres taşması:** `taban + sabit` adres hesabı 4 GiB'ı aşarsa normal wasm hata verir; WebSwap'ta adres başa
  sarar. Bu yalnızca zaten tanımsız davranış içeren C kodunu etkiler.
- **Havuz boyutu tahmini:** "Havuz iki kat olsaydı" tahmini LRU için kesin, çalışan CLOCK algoritması için
  yaklaşıktır.
- **Güvenlik:** Diske taşınan sayfalar şifrelenmeden durur. OPFS'te sitenin diğer verileriyle aynı güven
  düzeyindedir; dosya depolamasında dosya 0600 izniyle oluşturulur ve kapatınca silinir (süreç öldürülürse kalır).
- **Zamanlayıcı:** Tarayıcılar `performance.now()` hassasiyetini düşürdüğü için, tek tek sayfa hatası süreleri
  tarayıcıda ölçülemez. Sayaç bunu belirtir.
- **Flaş aşınması:** Rastgele yazan işler diske gigabaytlarca yazabilir. Yazma bütçesi uyarır ya da işi
  durdurur (`onBudget: 'throw'`).

---

## Dosya düzeni

```
tools/vera-build.mjs     C → paged .vera.wasm + normal .base.wasm
tools/instrument.mjs     binaryen.js dönüştürücüsü (doğrulama, load/store çevirisi, yığın denetimi)
tools/build-all.mjs      demo programları derle
runtime/vera.h           tipler, küçük libc bildirimleri, yardımcılar
runtime/vera-libc.c      malloc/free/calloc/realloc/memcpy/... (sanal bölgede)
runtime/softmmu.c        adres çevirici ve bayt bayt güvenli yol
runtime/pager.mjs        sayfa hatası işleyicisi (CLOCK, dirty, önden okuma, bütçe, tahmin)
runtime/backends.mjs     depolama: bellek, dosya, OPFS, gecikme benzetimi; bütçe depoları
runtime/vera.mjs         createVera(), instantiateBase(), read/write köprüsü
runtime/meter.mjs        TR/EN sayaç
runtime/durable.mjs      dayanıklı kontrol noktaları (çift yuvalı gölge sayfalama, CRC başlıkları)
apps/                    demo programlar: sort, blur, hash, rand, chase, packed, fuzz
host/node-run.mjs        komut satırı
host/web/                tarayıcı sayfası + Worker + küçük sunucu
test/                    54 test + tarayıcı + çalışma ortamı testleri
bench/run-all.mjs        ölçüm matrisi → results/BENCH.md
```

---

## English summary

**v.e.r.a WebSwap** is a build-time transform plus a small runtime that gives C programs compiled to
WebAssembly a heap of up to ~3.75 GiB while their real `WebAssembly.Memory` stays small (e.g. 37 MiB, plus a
fixed ~13 MiB of JS-side tables). It pages 4 KiB pages synchronously to the browser's Origin Private File
System, or to a file under Node/Bun. Programs must be recompiled from source (freestanding C for now); every
load/store is rewritten (binaryen.js) to go through an inlined software MMU, and every stack-pointer update is
bounds-checked. Across all tests the paged build returns the same 64-bit checksum as the ordinary build. The
runtime uses CLOCK with sampled reference bits, dirty tracking, zero-page elision, sequential readahead, a
flash-write budget over a 24-hour window (per run, or across runs with a budget store), and a bilingual meter.

It is **not** faster and adds no RAM. It turns "out of memory, tab crashed" into "finished, slower", and it
measures and reports the cost: in our runs ~1.6-2.3x for sequential work while the swap file stayed in the OS
cache, ~10-20x with simulated slow storage, and tens to thousands of times for random access. As far as we
could find (September 2026), no general drop-in demand-paging layer for WebAssembly linear memory in browsers
exists. The mechanism itself is well known: software page tables with flash paging (ViMem 2007, t-kernel 2006),
wasm software MMUs (WAVEN 2025, nix-wasm 2026), and app-specific OPFS paging (Photoshop web). See
[docs/FIKIR-ARASTIRMASI.md](docs/FIKIR-ARASTIRMASI.md).

Durable checkpoints (`runtime/durable.mjs`): two-slot shadow paging with CRC-protected A/B headers lets a
program resume from its last checkpoint after the process or tab is killed. Tested with 20 SIGKILLs spread over
a run (no checkpoint that had returned was lost; the final digest matches an uninterrupted run), with a forced
crash at every phase of a checkpoint, with torn and corrupted checkpoint data, and with a Chromium page reload
that resumes from OPFS. SIGKILL tests process crashes only; power-loss durability relies on `fsync` and was not
tested.

Tested: Linux with Node 22 and Bun 1.3, and headless Chromium 141 (Worker + OPFS). Not yet tested: Safari, iOS,
iPadOS, Android, Firefox, Windows, macOS. Browser floors (Chrome/Edge 108+, Firefox 114+, Safari 17+) are where
`FileSystemSyncAccessHandle` is fully synchronous; WebSwap refuses to run on the older asynchronous variant.
