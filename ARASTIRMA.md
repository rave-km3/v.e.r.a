# Depolamayı RAM'e Dönüştürmek Mümkün mü?

**v.e.r.a fizibilite araştırması**, 26 Eylül 2026

> Soru: "Depolamamı yazılımla RAM'e dönüştürmek istiyorum, sanal RAM gibi. Sadece depolamadan
> alacak, başka hiçbir şeye dokunmayacak. Bu mümkün mü? Mümkünse dünyayı etkileyecek bir yazılım olur."

Bu belge yedi ayrı araştırma alanının (işletim sistemleri, telefonlardaki "sanal RAM", donanım
fiziği, ticari ürünlerin geçmişi, akademik çalışmalar, mühendislik kısıtları, pazar etkisi)
sonuçlarını, önemli iddiaların ayrıca yapılmış doğrulamasını ve bu depodaki
[`bench/`](bench/) klasöründe bulunan ölçüm programlarıyla elde edilen gerçek sonuçları bir araya
getirir.

---

## Kısa cevap

1. **Bir kısmı mümkün, ama zaten var.** Depolamayı *sanal belleğin uzantısı* olarak kullanmak
   (swap, sayfa dosyası, "sanal RAM") 1962'deki Atlas bilgisayarından beri var. Bugün Windows,
   macOS, Linux, Android ve iPadOS'ta varsayılan olarak açık. Milyarlarca cihazda çalışıyor.
2. **Asıl istenen kısım yazılımla mümkün değil.** Depolamanın gerçekten RAM'e *dönüşmesi*
   (RAM hızında çalışması, işlemcinin doğrudan okuyup yazabilmesi) fizik kurallarına takılıyor.
   Bir NVMe SSD'den rastgele okuma, RAM'den okumaya göre yaklaşık **500-1000 kat** yavaş.
   Yazılım bu farkı gizleyebilir veya azaltabilir, ama kapatamaz.
3. **"Başka hiçbir şeye dokunmayacak" şartı karşılanamaz.** İşlemci yalnızca RAM'deki veriyle
   çalışabilir. Diskteki her sayfa kullanılmadan önce RAM'e kopyalanmak zorunda. Bu işlem RAM,
   işlemci zamanı, sayfa tabloları (RAM'de tutulur) ve SSD'nin yazma ömrünü kullanır.
4. **Kendi ölçümümüz:** Bu makinede swap'tan (diskten) gelen bir bellek erişimi ortalama
   **53 µs**, RAM'deki aynı erişim **0,34 µs** sürdü: yaklaşık **156 kat** fark. (Sanal makine
   olduğu için fark gerçek donanımdakinden *küçük* çıkıyor; ayrıntı [4. bölümde](#4-kendi-ölçümlerimiz).)
5. **Dünyayı değiştirir mi?** Genel bir "depolamayı RAM yapan program" olarak hayır: işletim
   sistemleri bunu zaten yapıyor ve en iyi mühendislik örnekleri (Meta'nın TMO sistemi)
   **%20-32** bellek tasarrufunda kalıyor. Ama **dürüst, ölçen, SSD ömrünü koruyan** araçlar
   için gerçek bir boşluk var ve 2025-2026'daki RAM fiyat şoku bu boşluğu büyüttü. Önerilen yol
   [8. bölümde](#8-vera-için-gerçekçi-yol-haritası).

---

## 1. Önce soruyu netleştirelim

"Depolamayı RAM'e dönüştürmek" dört farklı anlama gelebilir ve cevap her birinde farklı:

| Ne kastediliyor? | Mümkün mü? | Durum |
|---|---|---|
| Depolama çiplerini fiziksel olarak RAM'e çevirmek | **Hayır** | NAND flaş ve DRAM farklı fiziksel yapılar. Yazılım bir çipin türünü değiştiremez. |
| Depolamanın RAM hızında, RAM gibi çalışması | **Hayır** (yazılımla) | Hız farkı cihazın kendisinden geliyor. Buna en çok yaklaşan donanım (Intel Optane) bile RAM'den ~4 kat yavaştı ve 2022'de kapatıldı. |
| Depolamayı RAM yetmediğinde taşma alanı olarak kullanmak ("sanal RAM") | **Evet** | Zaten her işletim sisteminde var: Windows sayfa dosyası, Linux swap, macOS swap, Android "RAM Plus", iPadOS "Virtual Memory Swap". |
| RAM'in bir kısmını disk gibi kullanmak (RAM disk) | Evet | Bu ters yön. Sorulan şey değil. |

Bu belgede "mümkün" dediğimiz her şey üçüncü satıra, yani **sanal bellek uzantısına** giriyor.

---

## 2. Bu fikir zaten var: 60 yıllık geçmiş

### 2.1 Başlangıç: 1962

Sanal bellek, Manchester Üniversitesi ve Ferranti'nin **Atlas** bilgisayarında (Aralık 1962)
"tek seviyeli bellek" (one-level store) adıyla ortaya çıktı. Atlas, küçük ve hızlı ana bellekle
büyük ve yavaş bir manyetik tambur arasında 512 kelimelik sayfaları otomatik taşıyordu.
Programlar büyük tek bir bellek varmış gibi çalışıyordu. Bu, sorulan fikrin ta kendisi.

1968'de Peter Denning, bu yaklaşımın temel sınırını ortaya koydu: **çalışma kümesi** (bir
programın o an aktif kullandığı sayfalar) gerçek RAM'e sığdığı sürece sistem iyi çalışır.
Sığmadığında sistem sürekli disk ile RAM arasında sayfa taşır ve neredeyse durur
(**thrashing**). Daha fazla swap alanı eklemek bu sınırı değiştirmez.

### 2.2 Bugün her işletim sisteminde

| Platform | Mekanizma | Not |
|---|---|---|
| Windows | `pagefile.sys` (sayfa dosyası) + bellek sıkıştırma (Windows 10'dan beri) | Sistem yönetimli sayfa dosyası RAM'in 3 katına (veya 4 GB'a) kadar büyüyebilir. "Commit" sınırı = RAM + sayfa dosyaları. |
| Linux | swap bölümü/dosyası, zswap, zram, zram writeback | Ayrıntılı ayar yapılabilir. Fedora 2020'den beri varsayılan olarak RAM içi sıkıştırılmış swap (zram) kullanıyor. |
| macOS | Dinamik, her zaman şifreli swap dosyaları + bellek sıkıştırıcı (10.9'dan beri) | Tamamen otomatik, kullanıcı boyut ayarlayamaz. |
| Android | zram (RAM içi sıkıştırma); üreticilerin "sanal RAM" özellikleri flaşa yazar | Google'ın resmi belgesi flaş aşınması yüzünden depolamaya swap yapılmadığını söyler. Üreticiler yine de yapıyor (aşağıda). |
| iPadOS 16+ | "Virtual Memory Swap" | M1 ve sonrası iPad'lerde, zorlu uygulamalara 16 GB'a kadar bellek. |
| iPhone (iOS) | Depolamaya swap yok | Yazılmış veri diske atılmaz; bellek dolunca uygulamalar kapatılır. |

### 2.3 Telefonlardaki "sanal RAM" tam olarak bu fikir

2021'den beri neredeyse bütün büyük Android üreticileri bu özelliği satıyor:

- **vivo** "Extended RAM" (2021, ilk yaygın örnek)
- **Xiaomi** "Memory Extension" (MIUI 12.5, 2021)
- **OPPO / realme / OnePlus** "RAM Expansion" (2021'den itibaren)
- **Samsung** "RAM Plus" (Eylül 2021, Galaxy A52s ile; One UI 4.1'de 2/4/6/8 GB seçilebilir; varsayılan olarak açık)
- Honor "RAM Turbo", Motorola "RAM Boost", Tecno/Infinix "MemFusion", HMD

Arka planda yaptıkları şey sıradan Linux swap: sayfalar önce RAM içinde sıkıştırılıyor (zram),
soğuk olanlar telefonun UFS depolamasındaki bir dosyaya yazılıyor. Bu altyapı Android'in açık
kaynak kodunda (AOSP) zaten mevcut.

**Gerçek etkisi mütevazı.** Bağımsız testler, 4-6 GB RAM'li telefonlarda arka planda birkaç
uygulamanın daha açık kalabildiğini, ama oyun ve benchmark performansının artmadığını
gösteriyor. 8-12 GB RAM'li telefonlarda bazı testlerde etkisiz veya zararlı. Üreticiler
flaş aşınmasını sınırlamak zorunda: örneğin HMD, yazma bütçesinin %90'ı dolunca özelliği
kalıcı olarak kapatıyor. Android Authority'nin 7.000'den fazla oyla yaptığı ankette okuyucuların
%44'ü özelliği kullanmadığını, %25'i kullanıp kullanmadığını bilmediğini söyledi.

Yani fikir **yüz milyonlarca telefonda zaten var** ve etkisi "dünyayı değiştiren" düzeyde değil.

### 2.4 Şirketlerin denemeleri ve akıbetleri

| Ürün | Ne yaptı | Ne oldu |
|---|---|---|
| **Intel Memory Drive Technology (IMDT)**, 2018 | İşletim sisteminin altında çalışan bir yazılım katmanı (ScaleMP teknolojisi). Optane SSD'yi Linux'a *sistem RAM'i* olarak gösterdi. Sorulan fikrin en yakın ticari örneği. | İyi yerellik olan işlerde RAM'e yakın performans; rastgele erişimde zayıf. 2021'de satıştan kaldırıldı. ScaleMP'yi 2021'de SAP satın aldı. |
| **Intel Optane PMem** (bellek yuvasına takılan kalıcı bellek) | Depolama teknolojisini doğrudan bellek yoluna koydu. Rastgele okuma ~305 ns (DRAM ~81 ns, ~3,8 kat yavaş). | Intel 2022'de tüm Optane işini kapattı ve 559 milyon dolar stok değer düşüklüğü yazdı. |
| **Windows ReadyBoost** (2007) | USB belleği disk önbelleği olarak kullandı. RAM eklemedi. | SSD'lerin yaygınlaşmasıyla anlamsızlaştı. |
| **Intel Turbo Memory** (2007) | Dizüstünde küçük bir flaş önbellek. | İncelemelerde fayda az veya yok; terk edildi. |
| **SoftRAM95** (1995) | "RAM'inizi iki katına çıkarır" iddiası. Gerçekte hiçbir şey yapmıyordu. | 700.000'den fazla kopya satıldı. ABD Federal Ticaret Komisyonu (FTC) harekete geçti. |
| **Connectix RAM Doubler** (1990'lar, Mac) | Sıkıştırma ve kullanılmayan belleği geri kazanma. Meşru bir teknik. | Bu teknikler sonradan işletim sistemlerinin standart parçası oldu. |

**Tarihin dersi:** Depolamayı "RAM gibi" çalıştırmayı başaran her ürünün önünde bir DRAM önbelleği
vardı, olağanüstü hızlı bir ortam kullandı ve ancak iyi yerelliği olan iş yüklerinde işe yaradı.
Hiçbiri "başka hiçbir şeye dokunmadan" çalışmadı. Hiçbiri depolamayı gerçekten RAM yapamadı.

### 2.5 Büyük veri merkezleri bunu zaten yapıyor

- **Meta TMO** (2022): Milyonlarca sunucuda soğuk belleği sıkıştırılmış belleğe ve SSD'ye
  taşıyarak toplam belleğin **%20-32'sini** tasarruf ediyor. Kodun önemli kısmı Linux çekirdeğine
  girdi.
- **Google "far memory"** (2019): Soğuk veriyi sıkıştırılmış RAM'de tutuyor (SSD değil).
- Bu sistemler, bir tüketici uygulamasının yapabileceğinden çok daha ileri gidiyor ve yine de
  kazanç yüzdelerle ölçülüyor, katlarla değil.

---

## 3. Fizik: yazılım depolamayı neden RAM yapamaz?

### 3.1 Hız farkı

| Katman | Rastgele erişim gecikmesi | DRAM'e göre | Sıralı bant genişliği |
|---|---|---|---|
| İşlemci L1 önbelleği | ~1 ns | ~0,01x | — |
| **DRAM (DDR4/DDR5)** | **~80-100 ns** | **1x** | çift kanal DDR5-6400: 102,4 GB/s (teorik) |
| Intel Optane PMem (kapatıldı) | ~305 ns | ~3,8x | — |
| Intel Optane SSD (kapatıldı) | ~5-10 µs | ~60-120x | — |
| NVMe SSD (PCIe 4.0, ör. Samsung 990 PRO) | ~45 µs (4 KiB, QD1) | **~500-650x** | ~7,5 GB/s |
| NVMe SSD (PCIe 5.0, ör. Samsung 9100 PRO) | benzer | benzer | ~14,8 GB/s |
| SATA SSD (ör. Samsung 870 EVO) | ~77 µs | **~950x** | ~0,56 GB/s |
| Telefon depolaması (UFS 4.0) | onlarca µs | ~yüzlerce x | ~4,2 GB/s (telefon RAM'i ~68 GB/s) |
| Sabit disk (HDD, 7200 rpm) | ~8-13 ms | **~100.000x+** | ~0,2 GB/s |

Bir benzetme: RAM'e erişim 1 saniye sürseydi, NVMe SSD'den rastgele okuma **8-10 dakika**,
sabit diskten okuma **1-2 gün** sürerdi.

Sıralı okumada (büyük bloklar halinde) fark daha küçük (en iyi SSD ile ~7 kat). Ama
programların çoğu belleğe küçük parçalar halinde ve rastgele erişir; orada fark 1000 katı aşar.

### 3.2 İşlemci diske doğrudan erişemez

İşlemcinin `load`/`store` komutları yalnızca RAM adreslerine çalışır. SSD bir **blok aygıtıdır**:
veri 4 KiB'lık sayfalar halinde önce RAM'e kopyalanır (DMA), ancak ondan sonra işlemci onu
kullanabilir. Program 8 bayt istese bile 4 KiB okunur (512 kat fazla veri). Her diskten okuma bir
**sayfa hatası** (page fault) demektir: işletim sistemine geçiş, G/Ç isteği, bekleme, sayfa
tablosu güncelleme. Bu yazılım yükü tek başına birkaç mikrosaniye tutar.

Depolamanın gerçekten "RAM gibi" adreslenebilmesi için donanımın bunu desteklemesi gerekir
(kalıcı bellek modülleri, CXL bellek aygıtları). Sıradan NVMe/SATA SSD'ler bu sınıfa girmez ve
yazılım bunu değiştiremez.

### 3.3 Flaş bellek aşınır

NAND flaş hücrelerinin sınırlı yazma ömrü vardır (TLC: ~1.000-3.000, QLC: ~1.000 veya daha az
silme/yazma döngüsü). DRAM'in böyle bir sınırı pratikte yoktur.

**Hesap:** 1 TB'lık tipik bir tüketici NVMe SSD'nin garanti edilen yazma ömrü ~600 TBW'dir.
Bu diske RAM gibi saniyede sadece 1 GB yazılsa:

    600.000 GB ÷ 1 GB/s = 600.000 s ≈ 6,9 gün

Yani RAM trafiğinin küçük bir kısmı bile diski **bir haftada** tüketir. (RAM saniyede onlarca
GB yazabilir.) 5 yıllık garanti boyunca 600 TBW, ortalama sadece ~3,8 MB/s yazmaya denk gelir.
Normal masaüstü kullanımında ara sıra swap zararsızdır; sürekli thrashing ise diski günler
içinde yıpratabilir.

### 3.4 Yazılım neyi değiştirebilir, neyi değiştiremez?

| Yazılım **değiştiremez** | Yazılım **değiştirebilir** |
|---|---|
| NAND okuma süresi (onlarca µs) | Neyin RAM'de, neyin diskte tutulacağı (akıllı seçim) |
| PCIe bant genişliği | Önceden getirme (prefetch), sıkıştırma |
| 4 KiB blok erişimi | Veri yerleşimi (ilgili verileri bir arada tutmak) |
| Flaşın yazma ömrü | Ne kadar yazılacağı (aşınma bütçesi) |
| Isınma ve güç sınırları | Çekirdek yükünü azaltmak (µs mertebesinde) |

Sağ sütundaki kazanımlar belirli iş yüklerinde **yüzde onlar veya birkaç kat** getirir;
500-1000 katlık farkı kapatmaz.

---

## 4. Kendi ölçümlerimiz

[`bench/`](bench/) klasöründeki C programları bu araştırma sırasında yazıldı ve bu oturumun
çalıştığı Linux sanal makinesinde (4 vCPU, 15,7 GiB RAM, virtio disk) çalıştırıldı. Değerler 3
tekrarın medyanıdır.

| Ölçüm | Sonuç |
|---|---|
| RAM, L1 önbellek erişimi | 1,6 ns |
| RAM, 1 GiB içinde rastgele erişim | 285 ns (sanallaştırma yüzünden gerçek donanımdan ~2-3 kat yavaş) |
| RAM sıralı okuma (1 / 4 iş parçacığı) | 10,7 / 36,8 GB/s |
| Disk, rastgele 4 KiB okuma (QD1, O_DIRECT) | ort. 41,6 µs, p99 96,7 µs |
| Disk, rastgele 4 KiB kalıcı yazma (fdatasync) | ort. 270 µs |
| Disk sıralı okuma / yazma | 2,57 / 0,61 GB/s |
| **mmap: dosyayı bellek gibi kullanma**, ilk dokunuş (diskten) | **45,2 µs** |
| Aynı sayfaya ikinci dokunuş (artık RAM'de) | 0,36 µs → **~125 kat** fark |
| Varsayılan önden okuma ile rastgele mmap erişimi | 1,8 ms (her hatada 5,4 MiB okundu) |
| **Gerçek swap testi:** 512 MiB çalışma kümesi, 128 MiB RAM sınırı | Erişimlerin %75'i diske gitti, her biri ort. **53 µs**; RAM'de 0,34 µs → **~156 kat** |

Bu ortamda swap dosyası açmak mümkündü; yani deney "sanal RAM"in bugün Linux'ta nasıl
hissettirdiğini doğrudan gösteriyor.

**Neden gerçek fark daha da büyük?** Sanal makinede RAM erişimi, iç içe sayfa tabloları yüzünden
normalden 2-3 kat yavaş ölçülüyor. Disk ise muhtemelen ana makinenin önbelleğinden
yararlanıyor. İkisi birlikte farkı olduğundan *küçük* gösteriyor. Gerçek donanımda NVMe için
~500-650 kat, SATA SSD için ~950 kat bekleniyor.

Kendi bilgisayarında denemek için (Linux):

```sh
cd bench
make
./run.sh | tee sonuclar.txt
sudo SWAP_TEST=1 ./run.sh | tee sonuclar.txt   # geçici swap dosyası testiyle birlikte
```

Ayrıntılar: [`bench/README.md`](bench/README.md).

---

## 5. "Başka hiçbir şeye dokunmayacak" şartı neden imkânsız?

Depolamayla desteklenen her bellek sayfası, şu kaynakları mutlaka kullanır:

| Kaynak | Neden kullanılıyor |
|---|---|
| **RAM** | Veri kullanılmadan önce RAM'deki boş bir sayfa çerçevesine kopyalanmalı. Sayfa tabloları RAM'de durur (4 KiB sayfalarla eşlenen her 1 GiB için ~2 MiB). Her RAM sayfası için çekirdek ayrıca 64 baytlık bir kayıt tutar (~%1,6). |
| **İşlemci** | Her sayfa hatası çekirdeğe geçiş, G/Ç kurma, bekleme ve sayfa tablosu güncellemesi demek. Çok çekirdekli sistemlerde TLB temizleme kesmeleri de gerekir. |
| **PCIe / G/Ç yolu** | Her sayfa disk ile RAM arasında taşınır. |
| **SSD ömrü** | RAM'den atılan her kirli sayfa diske yazılır. |
| **Güç ve ısı** | NVMe SSD aktifken ~5 W çeker; bu RAM'in tüketimine *eklenir*, yerine geçmez. |

Bu yüzden "sadece depolamadan alacak" diye bir yazılım yazılamaz. Yazılabilecek şey, bu
kaynakları **en az ve en akıllı şekilde** kullanan bir yazılımdır.

---

## 6. Depolama "bellek gibi" nerede gerçekten işe yarıyor?

Akademik ve endüstriyel çalışmaların ortak sonucu: depolama destekli bellek, erişim **öngörülebilir**
olduğunda iyi çalışır.

**İyi çalıştığı yerler**

- **Soğuk veri:** Uzun süre dokunulmayan bellek (Meta TMO, Google far memory).
- **Sıralı / akış halinde erişim:** Büyük yapay zekâ modellerinin katman katman diskten okunması.
  - Apple "LLM in a flash" (2023-2024): RAM'in 2 katı büyüklüğe kadar modelleri çalıştırıyor;
    saf yüklemeye göre CPU'da 4-5 kat, GPU'da 20-25 kat hızlı.
  - FlexGen (2023): 175 milyar parametreli bir modeli tek bir 16 GB GPU ile, RAM ve diske taşıyarak
    çalıştırıyor. Toplu işlerde verimli, etkileşimli sohbette değil.
  - Yapay zekâ sunucularında KV-önbelleğinin SSD'ye taşınması (2024-2026'nın aktif alanı).
- **Çok paralel erişim:** GPU'nun binlerce iş parçacığıyla SSD'ye doğrudan eriştiği BaM (2023),
  gecikmeyi paralellikle gizliyor.

**Çalışmadığı yerler**

- Rastgele, gecikmeye duyarlı erişim ve RAM'den büyük aktif çalışma kümesi. Örnek: llama.cpp
  kullanıcıları, model RAM'e sığmayıp diskten sayfalandığında hızın "token başına dakikalar"
  seviyesine düştüğünü bildiriyor.
- Oyunlar ve etkileşimli uygulamalar: anlık yanıt gerekir, disk gecikmesi takılma olarak hissedilir.

**Açık araştırma konuları** (katkı yapılabilecek yerler): alt-sayfa düzeyinde nesne yerleşimi,
çok çekirdekli ve çok SSD'li sistemlerde swap ölçeklenmesi (ör. ScaleSwap, FAST 2026), SSD
ömrünü gözeten swap politikaları, programlanabilir (eBPF) sayfalama politikaları, CXL tabanlı
bellek-SSD'leri için işletim sistemi desteği, tüketici bilgisayarlarında yerel dil modelleri için
akıllı offload.

---

## 7. Dünyayı değiştirir mi? Dürüst değerlendirme

**Neden genel haliyle değiştirmez:**

- Fikrin mümkün olan kısmı zaten **milyarlarca cihazda** çalışıyor (Windows, macOS, Linux,
  Android, iPadOS).
- En iyi mühendislik ekipleri (Meta, Google) bile bu yaklaşımdan **tek haneli yüzdeler ile %32**
  arası kazanç elde ediyor. Kazanç gerçek ama "dünyayı değiştiren" ölçekte değil.
- Fikrin dünyayı değiştirecek kısmı (depolamanın RAM hızına çıkması) fiziksel olarak mümkün değil.
  Intel, kendi özel donanımıyla bile bunu başaramadı ve 559 milyon dolar zarar yazarak çekildi.
- "Yazılımla RAM'i artırıyoruz" diye pazarlanan ürünlerin geçmişi kötü (SoftRAM95 ve FTC).

**Ama zamanlama ilginç:**

- 2025-2026'da yapay zekâ talebi (HBM) yüzünden DRAM fiyatları sert yükseldi. TrendForce'a
  göre sözleşme fiyatları 2026'nın ilk çeyreğinde bir önceki çeyreğe göre yaklaşık iki katına
  çıktı. Tüketici DDR5 fiyatı GB başına 2025 ortasına göre kat kat arttı. GB başına RAM, NVMe
  depolamadan yaklaşık **100 kat** pahalı.
- Bu, üreticileri daha az RAM'li cihaz satmaya ve "8 GB + 8 GB sanal RAM" gibi pazarlamaya itiyor.
  Kullanıcıların bu özelliklerin gerçekte ne yaptığını bilmesi her zamankinden önemli.
- Düşük RAM'li eski bilgisayarları kullanılabilir tutmak (e-atık) gerçek bir sorun.

**Sonuç:** Genel bir "depolamayı RAM'e çeviren program" dünyayı değiştirmez; zaten var olanı
tekrar eder. **Dürüst, ölçen ve SSD'yi koruyan** bir araç ise gerçek bir boşluğu doldurabilir ve
özellikle düşük RAM'li cihaz kullanan milyonlarca kişi için faydalı olabilir.

---

## 8. v.e.r.a için gerçekçi yol haritası

Aşağıdaki seçenekler fiziğe takılmıyor ve mevcut araçlarla birebir çakışmıyor.

### Seçenek A: "Bellek gerçeği" teşhis aracı *(önerilen ilk adım)*

Windows, Linux ve (sınırlı olarak) macOS için, Türkçe dahil, sade dilli bir araç:

- Gerçek RAM kullanımı, sıkıştırılmış bellek, swap/sayfa dosyası kullanımı
- Bellek baskısı (Linux PSI, Windows commit, macOS memory pressure) ve sayfa hatası oranları
- Swap yüzünden SSD'ye yazılan veri ve bunun diskin garanti edilen ömrüne (TBW, SMART) oranı
- Net bir öneri: "Daha fazla swap yardımcı olur" / "Sıkıştırma ayarını değiştir" /
  "Asıl ihtiyacın daha fazla RAM" / "Şu uygulama belleği tüketiyor"

**Neden anlamlı:** Tüketiciler için bunu çapraz platform ve dürüst şekilde yapan yaygın bir araç
yok. "RAM booster" uygulamalarının tam tersi. Risk düşük, geliştirmesi kolay.

### Seçenek B: Linux için akıllı, SSD ömrünü koruyan swap yöneticisi

Düşük RAM'li (4-8 GB) Linux masaüstü ve dizüstüler için küçük bir servis. Meta'nın sunucular
için yaptığını (Senpai/TMO) masaüstüne uyarlar:

- Ölçüme göre zram mı, zswap + NVMe swap mı kullanılacağını ve boyutlarını seçer
- `swappiness`, MGLRU, systemd-oomd/earlyoom eşiklerini ayarlar
- SSD'nin kalan ömrüne göre günlük yazma bütçesi koyar (`writeback_limit` vb.)
- Swap'ı şifreler (diske düşen şifre ve anahtarlar güvenlik riskidir)
- Dağıtımlara (Fedora, Ubuntu, Mint) varsayılan ayar önerileri gönderir

Kullanılacak arayüzler: `mkswap`/`swapon`, zswap/zram sysfs, cgroup v2 (`memory.high`,
`memory.swap.max`), PSI, `memory.reclaim`.

### Seçenek C: Yerel yapay zekâ modelleri için SSD offload katmanı

RAM veya ekran kartı belleğine sığmayan modelleri sıradan bilgisayarlarda çalıştırmak için
llama.cpp gibi mevcut motorların üzerine ince bir katman: seyrek/MoE modellerde sık kullanılan
parçaları RAM'de tutar, gerisini büyük ardışık okumalarla diskten akıtır, çalıştırmadan önce
beklenen hızı ve SSD aşınmasını dürüstçe gösterir. Rekabetçi bir alan; mevcut projelere katkı
olarak başlamak daha verimli.

### Seçenek D: Uygulamaya özel SSD destekli bellek kütüphanesi

Belirli bir uygulamanın (veritabanı, emülatör, bilimsel hesap) erişim düzenini bilerek,
Linux `userfaultfd` veya `mmap` + `madvise` ile diski bellek gibi kullanmasını sağlayan bir
kütüphane. Erişim düzeni öngörülebilirse genel işletim sistemi sayfalamasından çok daha iyi
sonuç verebilir. Benzer işler var (LLNL UMap, AIFM), bu yüzden dar bir hedef seçmek gerekir.

### Hangi seçenek seçilirse seçilsin: dürüstlük kuralları

- Asla "depolamayı RAM'e dönüştürür" veya "RAM'inizi artırır" deme. Doğru ifade: "RAM
  yetmediğinde depolamayı daha akıllı ve güvenli kullanır".
- Her iddiayı ölçümle göster (bu depodaki `bench/` bir başlangıç).
- SSD aşınmasını ve güvenliği (şifreli swap) varsayılan olarak koru.

### Önerilen ilk adımlar

1. `bench/` programlarını kendi bilgisayarında çalıştır, kendi donanımındaki farkı gör.
2. Seçenek A için küçük bir prototip: önce Linux'ta `/proc/meminfo`, `/proc/pressure/memory`,
   `/proc/vmstat` ve NVMe SMART verisini okuyup Türkçe özet veren bir komut satırı aracı.
3. Aynı aracın Windows sürümü (performans sayaçları, sayfa dosyası ve commit bilgisi).
4. Sonra Seçenek B'nin "öneri"lerini otomatik uygulayan kısmı.

---

## 9. Bugün hemen deneyebileceklerin

Aradığın özellik muhtemelen cihazında zaten var:

- **Windows:** Denetim Masası → Sistem → Gelişmiş sistem ayarları → Performans "Ayarlar" →
  Gelişmiş → Sanal bellek "Değiştir". Burada sayfa dosyası boyutu ve konumu ayarlanır
  (genellikle "otomatik yönet" en iyisidir). Bellek sıkıştırmanın açık olup olmadığını
  PowerShell'de `Get-MMAgent` gösterir.
- **Samsung telefon:** Ayarlar → Cihaz bakımı → Bellek → RAM Plus. Diğer markalarda benzer
  menüler ("Bellek uzantısı", "RAM genişletme").
- **Linux:** `swapon --show` ile mevcut swap'ı gör. zram için dağıtımının `zram-generator`
  paketine bak. Bir swap dosyası eklemek için:

  ```sh
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  ```

- **macOS:** Tamamen otomatik. Etkinlik Monitörü → Bellek sekmesinde "Bellek Baskısı" ve
  "Kullanılan takas" alanlarına bak.

---

## 10. Başlıca kaynaklar

<!-- KAYNAKLAR -->

---

## Ek A: Araştırma yöntemi

- Yedi ayrı araştırma alanı paralel olarak incelendi (toplam ~150 bulgu, her biri kaynaklı).
- Rapordaki önemli sayılar, tarihler ve ürün bilgileri ayrı "çürütmeye çalışan" doğrulayıcılar
  tarafından birincil kaynaklardan yeniden kontrol edildi. Düzeltilen iddialar Ek B'de.
- Ölçümler bu depodaki `bench/` programlarıyla yapıldı.

## Ek B: Doğrulama notları

<!-- DOGRULAMA -->
