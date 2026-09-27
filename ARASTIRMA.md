# Depolamayı RAM'e Dönüştürmek Mümkün mü?

**v.e.r.a fizibilite araştırması**, 26 Eylül 2026

> Soru: "Depolamamı yazılımla RAM'e dönüştürmek istiyorum, sanal RAM gibi. Sadece depolamadan
> alacak, başka hiçbir şeye dokunmayacak. Bu mümkün mü? Mümkünse dünyayı etkileyecek bir yazılım olur."

Bu belge yedi ayrı araştırma alanının sonuçlarını bir araya getiriyor: işletim sistemleri,
telefonlardaki "sanal RAM", donanım fiziği, ticari ürünlerin geçmişi, akademik çalışmalar,
mühendislik kısıtları ve pazar etkisi. Önemli iddialar ayrıca kaynaklarından tekrar kontrol
edildi. Bu projenin [`bench/`](bench/) klasöründeki programlarla gerçek ölçüm de yapıldı.

---

## Kısa cevap

Önce iyi haber: Bu fikir saçma değil. Tam tersine, bilgisayar biliminin en önemli fikirlerinden
biri. 1962'de mühendisler de aynı şeyi düşündü ve bugün neredeyse her cihazda kullanılıyor.
Aşağıda neyin mümkün olduğunu, neyin fizik yüzünden mümkün olmadığını ve senin için nerede
gerçek bir fırsat olduğunu anlatıyoruz.

1. **Mümkün olan kısım zaten var, büyük ihtimalle senin cihazında da.** Depolamayı *sanal
   belleğin uzantısı* olarak kullanmak (swap, sayfa dosyası, "sanal RAM") 1962'deki Atlas
   bilgisayarından beri var. Windows'ta, macOS'ta ve çoğu Linux dağıtımında varsayılan olarak
   açık, iPadOS'ta da destekli cihazlarda var. Android'in kendisi depolamaya swap yapmıyor,
   ama Samsung, Xiaomi, OPPO gibi üreticiler bu özelliği telefonlarına ekliyor ve çoğunlukla
   açık olarak veriyor. Samsung telefonlarda adı "RAM Plus", Windows'ta "Sanal bellek".
2. **Asıl istenen kısım yazılımla mümkün değil.** Depolamanın gerçekten RAM'e *dönüşmesi*, yani
   RAM hızında çalışması ve işlemcinin doğrudan okuyup yazabilmesi, fizik kurallarına takılıyor.
   İyi bir NVMe SSD'den rastgele küçük okuma RAM'e göre yaklaşık **400-750 kat**, SATA SSD'den
   **~1000 kat** yavaş. Yazılım bu farkı gizleyebilir veya azaltabilir, ama kapatamaz.
3. **"Başka hiçbir şeye dokunmayacak" şartı karşılanamaz.** İşlemci yalnızca RAM'deki veriyle
   çalışabilir. İşletim sistemi belleği 4 KiB'lık küçük parçalar hâlinde yönetir; bunlara
   "sayfa" denir. Diskteki her sayfa kullanılmadan önce RAM'e kopyalanmak zorunda. Bu işlem
   RAM, işlemci zamanı, sayfa tabloları (hangi sayfanın nerede durduğunu tutan kayıtlar; bunlar
   da RAM'de durur) ve SSD'nin yazma ömrünü kullanır.
4. **Sanal RAM cihazı hızlandırmaz.** Yalnızca aynı anda açık tutulabilecek şeylerin miktarını
   artırır ve "bellek yetersiz" çökmelerini önler. Sistem depolama kısmını kullanmaya başladığı
   anda yavaşlar.
5. **Kendi ölçümümüz:** Bu araştırmanın yapıldığı sanal makinede (bulutta çalışan, yazılımla
   oluşturulmuş bir bilgisayar) swap'tan, yani diskten gelen bir bellek erişimi ortalama
   **53 µs** (mikrosaniye: saniyenin milyonda biri), RAM'deki erişim **0,34 µs** sürdü. Bu
   yaklaşık **156 kat** fark demek. Sanal makinede bu fark gerçek donanımdakinden *küçük*
   çıkıyor; ayrıntılar [4. bölümde](#4-kendi-ölçümlerimiz).
6. **Dünyayı değiştirir mi?** Genel bir "depolamayı RAM yapan program" olarak hayır. İşletim
   sistemleri bunu zaten yapıyor, en iyi mühendislik örneği olan Meta'nın TMO sistemi bile
   **%20-32** bellek tasarrufunda kalıyor. Ama iki yerde gerçek bir fırsat var. Birincisi,
   **dürüst, ölçen ve SSD'yi koruyan** araçlar; 2025-2026 RAM fiyat şoku bu ihtiyacı büyüttü.
   İkincisi, **yapay zekâ modellerini diskten parça parça okuyarak çalıştırmak** (İngilizcede
   "streaming"); burada "depolamayı bellek gibi kullanmak" gerçekten işe yarıyor. Önerilen yol
   [8. bölümde](#8-vera-için-gerçekçi-yol-haritası).

---

## 1. Önce soruyu netleştirelim

"Depolamayı RAM'e dönüştürmek" dört farklı anlama gelebilir. Her birinin cevabı farklı:

| Ne kastediliyor? | Mümkün mü? | Durum |
|---|---|---|
| Depolama çiplerini fiziksel olarak RAM'e çevirmek | **Hayır** | NAND flaş ve DRAM farklı fiziksel yapılar. Yazılım bir çipin türünü değiştiremez. |
| Depolamanın RAM hızında, RAM gibi çalışması | **Hayır** (yazılımla) | Hız farkı cihazın kendisinden geliyor. Buna en çok yaklaşan donanım (Intel Optane PMem) bile RAM'den ~4 kat yavaştı; Intel 2022'de Optane işini kapatmaya başladı. |
| RAM yetmediğinde depolamayı taşma alanı olarak kullanmak ("sanal RAM") | **Evet** | Zaten var: Windows sayfa dosyası, Linux swap, macOS swap, Android üreticilerinin "RAM Plus" ve benzeri özellikleri, iPadOS "Virtual Memory Swap". |
| RAM'in bir kısmını disk gibi kullanmak (RAM disk) | Evet | Bu ters yön ve kullanılabilir RAM'i *azaltır*. Sorulan şey değil. |

Bu belgede "mümkün" dediğimiz her şey üçüncü satıra, yani **sanal bellek uzantısına** giriyor.

---

## 2. Bu fikir zaten var: 60 yıllık geçmiş

### 2.1 Başlangıç: 1962

Sanal bellek, Manchester Üniversitesi ve Ferranti'nin **Atlas** bilgisayarında (Aralık 1962)
"tek seviyeli bellek" (one-level store) adıyla ortaya çıktı. Atlas, küçük ve hızlı ana bellek
ile büyük ve yavaş bir manyetik tambur arasında 512 kelimelik sayfaları otomatik olarak
taşıyordu. Programlar büyük tek bir bellek varmış gibi çalışıyordu. Sorulan fikir tam olarak bu.

1968'de Peter Denning bu yaklaşımın temel sınırını ortaya koydu. Bir programın o an aktif
kullandığı sayfalara **çalışma kümesi** denir. Çalışma kümesi gerçek RAM'e sığdığı sürece sistem
iyi çalışır. Sığmadığında sistem sürekli disk ile RAM arasında sayfa taşır ve neredeyse durur;
buna **thrashing** denir. Daha fazla swap alanı eklemek bu sınırı değiştirmez.

### 2.2 Bugün her işletim sisteminde

| Platform | Mekanizma | Not |
|---|---|---|
| Windows | `pagefile.sys` (sayfa dosyası) + bellek sıkıştırma (Windows 10'dan beri) | "Commit" sınırı (Windows'un programlara ayırmayı taahhüt edebileceği toplam bellek) = fiziksel RAM + tüm sayfa dosyaları. Sistem tarafından yönetilen sayfa dosyası RAM'in 3 katına veya 4 GB'a (hangisi büyükse) kadar büyüyebilir, ama bulunduğu diskin (birimin) 1/8'ini geçemez. |
| Linux | Swap bölümü veya dosyası, zswap, zram, zram writeback | Ayrıntılı ayar yapılabilir. Fedora 33 (2020) varsayılan olarak RAM içi sıkıştırılmış swap'a (zram) geçti. |
| macOS | Dinamik ve her zaman şifreli swap dosyaları + bellek sıkıştırıcı (OS X 10.9'dan beri) | Tamamen otomatik; kullanıcı boyut ayarlayamaz. |
| Android | zram (RAM içi sıkıştırma). Üreticilerin "sanal RAM" özellikleri ise flaşa yazar. | Google'ın resmî belgesi, flaşı aşındırdığı için Android'de depolamaya swap yapılmadığını söyler. Üreticiler yine de yapıyor (bkz. 2.3). |
| iPadOS 16.1+ (Ekim 2022) | "Virtual Memory Swap" | En zorlu uygulamalara 16 GB'a kadar bellek. Yalnızca M1 iPad Pro, en az 256 GB depolamalı M1 iPad Air ve sonraki M serisi iPad'lerde. |
| iPhone (iOS) | Depolamaya swap yok | RAM içinde sıkıştırma var, ama uygulamaların bellekte oluşturduğu veri diske taşınmaz. Bellek dolunca arka plandaki uygulamalar kapatılır. |

### 2.3 Telefonlardaki "sanal RAM" tam olarak bu fikir

2021'den beri neredeyse bütün büyük Android üreticileri bu özelliği sunuyor ve reklamlarda öne
çıkarıyor:

- **vivo** "Extended RAM" (2021, ilk yaygın örnek)
- **Xiaomi** "Memory Extension" (MIUI 12.5, 2021)
- **OPPO / realme / OnePlus** "RAM Expansion" (2021'den itibaren)
- **Samsung** "RAM Plus": Eylül 2021'de Galaxy A52s ile sabit +4 GB olarak geldi. One UI 4.1
  (2022) ile 2/4/6/8 GB seçilebilir oldu, One UI 5 ile kapatma seçeneği eklendi. Varsayılan
  olarak açık.
- Honor "RAM Turbo", Motorola "RAM Boost", Tecno/Infinix "MemFusion", HMD

Bunlar arka planda sıradan Linux swap kullanıyor. Sayfalar önce RAM içinde sıkıştırılıyor
(zram); uzun süredir kullanılmayan ("soğuk") sayfalar ise telefonun depolamasındaki (UFS) bir
dosyaya yazılıyor. Bu altyapı Android'in açık kaynak kodunda (AOSP) zaten mevcut.

**Gerçek etkisi mütevazı.** Çoğu tek cihazla yapılmış ve yöntemi zayıf gazeteci testlerine göre,
düşük RAM'li telefonlarda (ör. 4 GB) arka planda birkaç uygulama daha açık kalabiliyor, ama oyun
ve benchmark performansı artmıyor. Daha fazla RAM'li bazı telefonlarda etkisi yok ya da olumsuz.
Kontrollü, çok cihazlı bağımsız bir çalışma bulunamadı. Üreticiler flaş aşınmasını sınırlamak
zorunda: HMD'nin kullanım kılavuzlarına göre özellik, depolamayı korumak için konan kullanım
sınırının %90'ı dolunca otomatik ve kalıcı olarak kapanıyor. Bu da 4 yıllık yoğun kullanımdan
sonra olabiliyor. Android Authority'nin 7.000'den fazla kişinin oy verdiği anketinde
okuyucuların %44'ü özelliği kullanmadığını, %25'i kullanıp kullanmadığını bilmediğini söyledi.

Yani fikir **yüz milyonlarca telefonda zaten var**, etkisi ise "dünyayı değiştiren" düzeyde değil.

### 2.4 "RAM artırıcı" uygulamalar

Bu fikri ararken ilk karşılaşılan şey, Play Store'daki ya da Windows için yazılmış "RAM
booster", "RAM genişletici" ve "RAM optimizer" uygulamaları oluyor:

- **Android:** Normal bir uygulama, root yetkisi (telefonda tam yönetici yetkisi; güvenliği ve
  garantiyi etkileyebilir) olmadan swap dosyası oluşturamaz. Android 14'ten beri bir uygulama
  başka uygulamaları arka planda zorla kapatamıyor da. Google, arka planda bekleyen uygulamaları
  zorla kapatmanın performansı düşürüp pil tüketimini artırabileceği konusunda uyarıyor, çünkü
  bir uygulamayı sıfırdan açmak, kaldığı yerden devam ettirmekten daha fazla işlemci ve pil
  harcar. Root'lu telefonlar için swap dosyası ekleyen modüller ise zaten var.
- **Windows:** "RAM optimizer" araçları genellikle başka programların sayfalarını bellekten
  zorla atarak "boş RAM" gösterir. O sayfalar sonra diskten geri okunmak zorunda kalır. Mark
  Russinovich (Sysinternals) 2004'te bu araçları "The Memory Optimization Hoax" (Bellek
  Optimizasyonu Aldatmacası) başlıklı yazısında anlattı.

### 2.5 Şirketlerin denemeleri ve akıbetleri

| Ürün | Ne yaptı | Ne oldu |
|---|---|---|
| **Intel Memory Drive Technology (IMDT)**, 2018 | İşletim sisteminin altında çalışan bir yazılım katmanıydı (ScaleMP teknolojisi). Optane SSD'yi Linux'a *sistem RAM'i* olarak gösterdi; DRAM, Optane'in önünde önbellek görevi gördü. Sorulan fikrin en yakın ticari örneği. | Erişimleri belli bir veri bölgesinde yoğunlaşan ("yerelliği iyi olan") işlerde RAM'e yakın performans verdi, rastgele erişimde zayıftı. 2021'de satıştan kaldırıldı (son sipariş: 30 Haziran 2021). ScaleMP'yi Haziran 2021'de SAP satın aldı. |
| **Intel Optane PMem** (bellek yuvasına takılan kalıcı bellek) | Depolama teknolojisini doğrudan bellek yoluna koydu. Rastgele okuma ~305 ns sürdü; aynı platformda DRAM ~81 ns, yani ~3,8 kat daha yavaş. | Intel, 2022'nin ikinci çeyreğinde Optane işini kapatmaya başladı ve 559 milyon dolarlık stok değer düşüklüğü kaydetti. |
| **Windows ReadyBoost** (2007) | USB belleği disk okuma önbelleği olarak kullandı. RAM eklemedi. | Sistem diski SSD olduğunda Windows onu devre dışı bırakır. Artık anlamını yitirdi. |
| **Intel Turbo Memory** (2007) | Dizüstü bilgisayarlarda küçük bir flaş önbellek. | İncelemelerde faydası az bulundu ya da hiç bulunmadı; terk edildi. |
| **SoftRAM / SoftRAM95** (1995) | "RAM'inizi iki katına çıkarır" iddiasıyla satıldı; gerçekte RAM'i artırmıyor, performansı iyileştirmiyordu. | Toplam ~700.000 kopya satıldı (~100 bin SoftRAM + ~600 bin SoftRAM95). Aralık 1995'te geri çağrıldı. ABD Federal Ticaret Komisyonu (FTC) ile uzlaşma 1996'da kesinleşti. |
| **Connectix RAM Doubler** (1990'lar, Mac) | Sıkıştırma ve kullanılmayan belleği geri kazanma; meşru bir teknikti. | Bu teknikler zamanla işletim sistemlerinin standart parçası oldu. |

**Tarihin dersi:** Depolamayı "RAM gibi" çalıştırmayı başaran her ürünün üç ortak noktası var:
önünde bir DRAM önbelleği vardı, olağanüstü hızlı bir depolama ortamı kullandı ve yalnızca
yerelliği iyi olan iş yüklerinde işe yaradı. Hiçbiri "başka hiçbir şeye dokunmadan" çalışmadı,
hiçbiri depolamayı gerçekten RAM yapamadı.

### 2.6 Büyük veri merkezleri bunu zaten yapıyor

- **Meta TMO** (ASPLOS 2022): Milyonlarca sunucuda soğuk belleği sıkıştırılmış belleğe ve
  SSD'ye taşıyarak toplam belleğin **%20-32'sini** tasarruf ediyor. İlgili çalışmaların önemli
  kısmı Linux çekirdeğine girdi.
- **Google "far memory"** (ASPLOS 2019): Soğuk veriyi SSD'de değil, sıkıştırılmış RAM'de
  (zswap) tutuyor.
- Bu sistemler, bir tüketici uygulamasının yapabileceğinden çok daha ileri gidiyor. Kazanç yine
  de katlarla değil, yüzdelerle ölçülüyor.

---

## 3. Fizik: yazılım depolamayı neden RAM yapamaz?

### 3.1 Hız farkı

| Katman | Rastgele erişim gecikmesi | DRAM'e göre | Sıralı bant genişliği |
|---|---|---|---|
| İşlemci L1 önbelleği | ~1 ns | ~0,01x | — |
| **DRAM** | **~60-120 ns** (masaüstü ~60-95, sunucu ~95-120) | **1x** | Çift kanal DDR5-6400: 102,4 GB/s (teorik) |
| Intel Optane PMem (üretimi durdu) | ~305 ns | ~3,8x | — |
| Intel Optane SSD P5800X (üretimi durdu) | ~5-9 µs | ~50-150x | — |
| NVMe SSD, PCIe 4.0 (ör. Samsung 990 PRO) | ~45 µs (4 KiB, QD1, spesifikasyondan türetildi) | **~400-750x** | ~7,45 GB/s |
| NVMe SSD, PCIe 5.0 (ör. Samsung 9100 PRO) | benzer (NAND sınırlı) | benzer | ~14,7-14,8 GB/s |
| SATA SSD (ör. Samsung 870 EVO) | ~77 µs | **~650-1300x** | ~0,56 GB/s |
| Telefon depolaması (UFS 4.0) | onlarca µs (tahmini) | yüzlerce kat (tahmini) | ~4,2 GB/s (telefon RAM'i LPDDR5X: ~68-136 GB/s) |
| Sabit disk (HDD, 7200 rpm) | ~8-13 ms (saniyede ~75-125 rastgele erişim) | **~100.000x** | ~0,2-0,28 GB/s |

Bir benzetme: RAM'e erişim 1 saniye sürseydi, NVMe SSD'den rastgele okuma **~8 dakika**,
sabit diskten okuma **~1-2 gün** sürerdi.

Büyük blokları sırayla okurken fark daha küçük: en iyi SSD ile ~7 kat. Ama programların çoğu
belleğe küçük parçalar hâlinde ve rastgele erişir, orada fark yüzlerce ile binlerce kat arasına
çıkar.

### 3.2 İşlemci diske doğrudan erişemez

İşlemcinin `load` ve `store` komutları yalnızca RAM adresleriyle çalışır. SSD ise bir **blok
aygıtı**: veri 4 KiB'lık sayfalar hâlinde önce RAM'e kopyalanır (DMA), işlemci onu ancak
ondan sonra kullanabilir. Program 8 bayt istese bile 4 KiB okunur, yani 512 kat fazla veri
taşınır.

Swap'taki bir sayfaya erişmek bir **sayfa hatası** (page fault) demektir. Adında "hata" geçse
de bu bir arıza değil; işlemcinin "istenen veri RAM'de yok" diye işletim sistemini çağırmasıdır.
Ardından işletim sistemine geçiş, giriş/çıkış (G/Ç) isteği, bekleme ve sayfa tablosunun
güncellenmesi gelir. Bu yazılım yükü tek başına birkaç mikrosaniye tutar.

Depolamanın gerçekten RAM gibi adreslenebilmesi için donanımın bunu desteklemesi gerekir
(kalıcı bellek modülleri, CXL bellek aygıtları). Sıradan NVMe ve SATA SSD'ler bu sınıfa girmez,
yazılım da bunu değiştiremez.

### 3.3 Flaş bellek aşınır, ama normal kullanımda sorun değil

NAND flaş hücrelerinin yazma ömrü sınırlıdır: bugünkü SSD'lerin çoğunda kullanılan TLC (hücre
başına 3 bit) flaşta ~1.000-3.000, daha ucuz QLC'de (hücre başına 4 bit) ~1.000 veya daha az
silme/yazma döngüsü. DRAM'in pratikte böyle bir sınırı yoktur.

**En kötü durum hesabı:** 1 TB'lık Samsung 990 PRO'nun garanti edilen yazma ömrü 600 TBW'dir
(diske toplam 600 terabayt yazılabilir; garanti süresi 5 yıl). Bu diske RAM gibi saniyede
sadece 1 GB yazılsaydı:

    600.000 GB ÷ 1 GB/s = 600.000 s ≈ 6,9 gün

RAM saniyede onlarca GB yazabildiği için, RAM trafiğinin küçük bir kısmı bile diski **bir
haftada** tüketirdi. 5 yıllık garanti boyunca 600 TBW, ortalama yalnızca ~3,8 MB/s yazmaya
denk gelir.

**Ama normal kullanımda endişe gerekmez.** Microsoft'un Windows 7 dönemi ölçümlerine göre sayfa
dosyasında okumalar yazmalardan ~40 kat fazla. Microsoft bu yüzden "SSD'ye koymak için sayfa
dosyasından daha uygun pek az dosya var" sonucuna vardı. Risk ancak sürekli thrashing ya da
yoğun yazma fırtınalarında ortaya çıkar. Bu yüzden **sayfa dosyasını "SSD'yi korumak için"
kapatmak yanlış olur**: commit sınırı düşer, programlar "sayfa dosyası çok küçük" hatasıyla
(hata 1455) çökebilir.

### 3.4 Yazılım neyi değiştirebilir, neyi değiştiremez?

| Yazılım **değiştiremez** | Yazılım **değiştirebilir** |
|---|---|
| NAND okuma süresi (onlarca µs) | Neyin RAM'de, neyin diskte tutulacağı (akıllı seçim) |
| PCIe bant genişliği | Önceden getirme (prefetch), sıkıştırma |
| 4 KiB blok erişimi | Veri yerleşimi (ilgili verileri bir arada tutmak) |
| Flaşın yazma ömrü | Ne kadar yazılacağı (aşınma bütçesi) |
| Isınma ve güç sınırları | İşletim sistemi çekirdeğinin (kernel) yükünü azaltmak (µs mertebesinde) |

Sağ sütundaki iyileştirmeler belirli iş yüklerinde **yüzde onlarca ya da birkaç kat** kazanç
sağlar, ama yüzlerce ile binlerce kat arasındaki farkı kapatmaz.

---

## 4. Kendi ölçümlerimiz

[`bench/`](bench/) klasöründeki C programları bu araştırma sırasında yazıldı ve araştırmanın
yürütüldüğü bulut ortamındaki bir Linux sanal makinesinde çalıştırıldı (4 vCPU, 15,7 GiB RAM,
virtio disk). Değerler 3 tekrarın ortanca değeri (medyan); RAM bant genişliğinde 5 tekrar.

| Ölçüm | Sonuç |
|---|---|
| İşlemci önbelleği (L1) erişimi | 1,6 ns |
| RAM, 1 GiB içinde rastgele erişim | 285 ns (sanallaştırma yüzünden gerçek donanımdan ~2-3 kat yavaş) |
| RAM sıralı okuma (1 / 4 iş parçacığı) | 10,7 / 36,8 GB/s |
| Disk, rastgele 4 KiB okuma (QD1, O_DIRECT) | ort. 41,6 µs, p99 96,7 µs |
| Disk, rastgele 4 KiB kalıcı yazma (fdatasync) | ort. 270 µs |
| Disk sıralı okuma / yazma | 2,57 / 0,61 GB/s |
| **mmap: dosyayı bellek gibi kullanma**, ilk erişim (veri diskten geliyor) | **45,2 µs** |
| Aynı sayfaya ikinci erişim (veri artık RAM'de) | 0,36 µs, yani **~125 kat** fark |
| Varsayılan önden okuma ile rastgele mmap erişimi | 1,8 ms (her erişimde 5,4 MiB okundu) |
| **Gerçek swap testi:** 512 MiB çalışma kümesi, 128 MiB RAM sınırı | Erişimlerin %75'i diske gitti, her biri ort. **53 µs**. RAM'de 0,34 µs, yani **~156 kat** |

Bu ortamda swap dosyası açılabildi, dolayısıyla deney "sanal RAM"in bugün Linux'ta nasıl
hissettirdiğini doğrudan gösteriyor.

**Gerçek fark neden daha da büyük?** Sanal makinede RAM erişimi iç içe sayfa tabloları yüzünden
normalden 2-3 kat yavaş ölçülüyor. Disk okumaları ise muhtemelen ana makinenin önbelleğinden
faydalanıyor. İkisi birlikte farkı olduğundan *küçük* gösteriyor. Gerçek donanımda NVMe için
yüzlerce kat, SATA SSD için ~1000 kat bekleniyor (bkz. 3.1).

Kendi bilgisayarında denemek için (Linux):

```sh
cd bench
make
./run.sh | tee sonuclar.txt
sudo SWAP_TEST=1 ./run.sh | tee sonuclar.txt   # geçici swap dosyası testiyle birlikte
```

Ayrıntılar için: [`bench/README.md`](bench/README.md).

---

## 5. "Başka hiçbir şeye dokunmayacak" şartı neden imkânsız?

Diskte tutulan (gerektiğinde diskten RAM'e getirilen) her bellek sayfası şu kaynakları mutlaka
kullanır:

| Kaynak | Neden kullanılıyor |
|---|---|
| **RAM** | Veri kullanılmadan önce RAM'deki boş bir sayfa çerçevesine kopyalanmalı. Sayfa tabloları RAM'de durur: 4 KiB sayfalarla eşlenen her 1 GiB için ~2 MiB. İşletim sistemi çekirdeği (kernel) ayrıca her RAM sayfası için 64 baytlık bir kayıt tutar (RAM'in ~%1,6'sı). |
| **İşlemci** | Her sayfa hatası çekirdeğe geçiş, G/Ç kurma, bekleme ve sayfa tablosu güncellemesi demek. Çok çekirdekli işlemcilerde TLB temizleme kesmeleri de gerekir. |
| **PCIe / G/Ç yolu** | Her sayfa disk ile RAM arasında taşınır. |
| **SSD ömrü** | RAM'den çıkarılan ve içeriği değişmiş ("kirli") her sayfa diske yazılır. |
| **Güç ve ısı** | NVMe SSD aktifken ~5 W çeker. Bu tüketim RAM'inkinin yerine geçmez, üstüne eklenir. |

Bu yüzden "sadece depolamadan alan" bir yazılım yazılamaz. Yazılabilecek olan, bu kaynakları
**en az ve en akıllı şekilde** kullanan bir yazılım. Senin "başka hiçbir şeye dokunmayacak"
isteğinin gerçekçi karşılığı ise şu: "yeni donanım almadan, yalnızca yazılımla".

---

## 6. Depolama "bellek gibi" nerede gerçekten işe yarıyor?

Akademik ve sektördeki çalışmaların ortak sonucu şu: diskte tutulan bellek, erişim
**öngörülebilir** olduğunda iyi çalışır.

### 6.1 İyi çalıştığı yerler

- **Soğuk veri:** Uzun süre dokunulmayan bellek (Meta TMO, Google far memory).
- **Yapay zekâ modellerinin diskten parça parça okunarak çalıştırılması:** Bugünün en canlı
  alanı.
  - **llama.cpp (Eylül 2026):** llama.cpp, yapay zekâ dil modellerini kişisel bilgisayarda
    çalıştıran popüler, açık kaynaklı bir program. 106,6 GB'lık bir MoE modeli ("uzmanlar
    karışımı": her adımda modelin yalnızca küçük bir bölümünü, yani birkaç "uzmanı" kullanan
    model türü), 32 GB RAM ve 12 GB ekran kartı belleği olan bir dizüstünde, gereken uzmanlar
    PCIe 4.0 NVMe SSD'den okunarak çalıştırıldı. İşletim sisteminin önbelleğini atlayıp
    doğrudan okuma (O_DIRECT) yapan bir yama, disk okumasını ~1,1 GB/s'den ~4,1-4,9 GB/s'ye
    çıkardı. İstemin (modele verilen metnin) işlenmesi ~3,3-4 kat hızlandı; metin üretme hızı
    saniyede 11,7'den 14,4 token'a çıktı.
  - **Apple "LLM in a flash"** (2023-2024): RAM'in 2 katı büyüklüğe kadar modelleri
    çalıştırıyor. Saf yüklemeye göre CPU'da 4-5 kat, GPU'da 20-25 kat hızlı.
  - **Phison aiDAPTIV+** (CES 2026): Donanım ve yazılımın birlikte çalıştığı bir çözüm.
    Phison'un testlerine göre 120 milyar parametreli bir MoE modeli, normalde gereken 96 GB
    yerine 32 GB DRAM ile çalışıyor.
  - **FlexGen** (2023): 175 milyar parametreli bir modeli tek bir 16 GB GPU'da, GPU, CPU ve disk
    belleğini birlikte kullanarak çalıştırıyor, ama yalnızca büyük toplu işlerde: aynı anda 144
    istek işleniyor ve tek bir isteğin sonucu binlerce saniye sürebiliyor. Saniyede 1 token'lık
    toplam verime ulaşan en iyi ayar ise ağırlıkları 4 bite sıkıştırıp **diskten kaçınarak** CPU
    belleğine sığdırıyor. Bu da diskin yavaşlığını ayrıca doğruluyor.
  - Yapay zekâ sunucularında KV önbelleğini (modelin konuşma geçmişi için tuttuğu ara veriler)
    SSD'ye taşımak, 2024-2026'nın aktif bir araştırma ve üretim alanı.
- **Çok paralel erişim:** BaM'de (2023) GPU, binlerce iş parçacığıyla SSD'ye doğrudan erişiyor
  ve gecikmeyi paralellikle gizliyor.

### 6.2 Çalışmadığı yerler

- Aktif çalışma kümesi RAM'den büyük olan rastgele ve gecikmeye duyarlı erişim. Örneğin
  llama.cpp kullanıcıları, her adımda modelin tamamını kullanan ("yoğun") bir model RAM'e
  sığmayıp düz sayfalamayla diskten okunduğunda hızın "token başına dakikalar" seviyesine
  düştüğünü bildiriyor. MoE modellerinde işe yarayan şey, her adımda modelin yalnızca küçük
  bir kısmının okunması.
- Oyunlar ve etkileşimli uygulamalar: anlık yanıt gerekir, disk gecikmesi takılma olarak
  hissedilir.

### 6.3 Oyunlar ve ekran kartı belleği hakkında sık karışan şeyler

- **Görev Yöneticisi'ndeki "Paylaşılan GPU belleği"** diski değil, sistem RAM'ini kullanır.
  Ekran kartı belleği (VRAM) dolunca oraya taşar ve RAM olmasına rağmen belirgin yavaşlama
  yaratır.
- **DirectStorage** oyunların NVMe'den daha hızlı *yükleme* yapmasını sağlar. Bellek miktarını
  artırmaz.
- **Sayfa dosyası** oyunlarda FPS'yi (saniyedeki kare sayısını) artırmaz. Yalnızca commit sınırı
  aşıldığı için oyunun çökmesini önler. Oyun gerçekten diske sayfa yazmaya başladığında takılma
  olur.

### 6.4 Donanım tarafındaki yeni gelişme: High Bandwidth Flash (HBF)

"Flaşı bellek gibi kullanma" fikrinin en iddialı güncel versiyonu donanım tarafında. SanDisk ve
SK hynix, **Ağustos 2026**'da Open Compute Project (OCP) üzerinden ilk HBF standardını
yayımladı. Konsorsiyumda Google ve Tenstorrent de var. HBF, HBM bellek ile SSD arasında yeni bir
katman olarak tasarlandı. İlk spesifikasyon, üst üste dizilmiş NAND kalıplarıyla 512 GB'a kadar
kapasite ve ~0,4-3 TB/s arası üç bant genişliği sınıfı tanımlıyor. Hedefi yapay zekâ çıkarımı,
yani çoğunlukla okunan model ağırlıkları. Bu bile genel amaçlı RAM'in yerini almayı
hedeflemiyor: gecikmesi hâlâ mikrosaniye düzeyinde ve yoğun yazmaya uygun değil. Yani dünyanın
en büyük bellek şirketleri de bu soruna **yeni donanımla ve yalnızca belirli bir iş yükü için**
yaklaşıyor.

### 6.5 Açık araştırma konuları

Katkı yapılabilecek konular:

- Alt sayfa düzeyinde nesne yerleşimi
- Çok çekirdekli ve çok SSD'li sistemlerde swap'ın ölçeklenmesi. Örneğin ScaleSwap (FAST 2026),
  128 çekirdek ve 8 NVMe ile Linux swap'a göre 3,4 kata kadar daha yüksek verim gösterdi.
- SSD ömrünü gözeten swap politikaları
- Programlanabilir (eBPF) sayfalama politikaları
- CXL tabanlı bellek-SSD'leri için işletim sistemi desteği
- Tüketici bilgisayarlarında yerel dil modelleri için akıllı offload

---

## 7. Dünyayı değiştirir mi? Dürüst değerlendirme

**Genel hâliyle neden değiştirmez:**

- Fikrin mümkün olan kısmı zaten **bir milyardan fazla cihazda** çalışıyor. Yalnızca Windows
  10/11 tarafında 1,4 milyardan fazla aktif cihaz (2022) sayfa dosyası kullanıyor. Buna Mac'ler,
  Linux sistemleri ve üretici "sanal RAM" özelliği olan yüz milyonlarca Android telefon
  ekleniyor. Android ve iPhone'ların geri kalanı ise aynı amaca RAM içi sıkıştırmayla ulaşıyor.
- En iyi mühendislik ekipleri bile bellek katmanlamadan tek haneli yüzdelerle %32 arasında
  kazanç elde ediyor: Google sıkıştırılmış RAM ile DRAM maliyetinde %4-5, Meta TMO SSD ve
  sıkıştırılmış bellekle %20-32. Kazanç gerçek ama "dünyayı değiştiren" ölçekte değil.
- Fikrin dünyayı değiştirecek kısmı, yani depolamanın RAM hızına çıkması, fiziksel olarak mümkün
  değil. Intel bunu kendi özel donanımıyla (Optane) bile başaramadı; 2022'de 559 milyon dolarlık
  stok değer düşüklüğü kaydedip işi kapatmaya başladı.
- "Yazılımla RAM'i artırıyoruz" diye pazarlanan ürünlerin geçmişi kötü (SoftRAM95 ve FTC).

**Ama zamanlama ilginç:**

- Yapay zekâ talebi (HBM) yüzünden DRAM fiyatları 2025-2026'da sert yükseldi. TrendForce'a göre
  standart DRAM sözleşme fiyatları 2026'nın ilk çeyreğinde bir önceki çeyreğe göre %93-98 arttı.
  Fiyat takipçilerine göre en ucuz 32 GB DDR5 kitler Haziran 2025'te GB başına ~2,1 dolardı.
  Eylül 2026'da en ucuz 32 GB kit GB başına ~12 dolara çıktı, ortalamalar ise ~17-18 dolar/GB.
  Bugün GB başına RAM, NVMe depolamadan **yaklaşık 100 kat ya da daha fazla** pahalı.
- Micron, Aralık 2025'te Crucial markasıyla yürüttüğü tüketici işinden çekileceğini duyurdu.
  Bellek üreticileri kapasiteyi veri merkezlerine kaydırıyor.
- Bu tablo üreticileri daha az RAM'li cihazlara ve "8 GB + 8 GB sanal RAM" gibi pazarlamaya
  itiyor. Kullanıcıların bu özelliklerin gerçekte ne yaptığını bilmesi her zamankinden önemli.
- Düşük RAM'li eski bilgisayarları kullanılabilir tutmak, e-atığı azaltmak açısından gerçek bir
  fayda. Yine de Windows 11'e geçişin asıl engeli genellikle işlemci ve TPM (anakarttaki
  güvenlik çipi) şartı; bunu swap yazılımı çözemez.

**Sonuç:** Genel bir "depolamayı RAM'e çeviren program" dünyayı değiştirmez, zaten var olanı
tekrar eder. **Dürüst, ölçen ve SSD'yi koruyan** bir araç ise gerçek bir boşluğu doldurabilir;
özellikle düşük RAM'li cihaz kullanan milyonlarca kişi için faydalı olabilir. Yapay zekâ
modellerini diskten okuyarak çalıştırmak ise "depolamayı bellek gibi kullanmanın" gerçekten fark
yarattığı ve hâlâ hızla gelişen alan.

---

## 8. v.e.r.a için gerçekçi yol haritası

Aşağıdaki seçenekler fiziğe takılmıyor ve mevcut araçlarla birebir çakışmıyor.

### Seçenek A: "Bellek gerçeği" teşhis aracı *(önerilen ilk adım)*

Windows, Linux ve (sınırlı olarak) macOS için, Türkçe dâhil, sade dilli bir araç. Göstereceği
şeyler:

- Gerçek RAM kullanımı, sıkıştırılmış bellek, swap ve sayfa dosyası kullanımı
- Bellek baskısı (Linux PSI, Windows commit, macOS bellek baskısı) ve sayfa hatası oranları
- Swap yüzünden SSD'ye yazılan veri ve bunun diskin garanti edilen yazma ömrüne (TBW, SMART
  verisi) oranı
- Net bir öneri: "Daha fazla swap yardımcı olur", "Sıkıştırma ayarını değiştir", "Asıl
  ihtiyacın daha fazla RAM" ya da "Belleği şu uygulama tüketiyor"

**Neden anlamlı:** Tüketiciler için bunu birden fazla işletim sisteminde ve dürüst şekilde
yapan yaygın bir araç yok. "RAM booster" uygulamalarının tam tersi. Riski düşük; ilk sürümü
geliştirmek görece kolay, ama üç işletim sisteminde doğru ölçüm yapmak ciddi emek ister.

### Seçenek B: Linux için akıllı, SSD ömrünü koruyan swap yöneticisi

Düşük RAM'li (4-8 GB) Linux masaüstü ve dizüstü bilgisayarlar için küçük bir servis. Meta'nın
sunucular için yaptığını (Senpai/TMO) masaüstüne uyarlar:

- Ölçüme göre zram mı, zswap + NVMe swap mı kullanılacağını ve boyutlarını seçer
- `swappiness`, MGLRU ve systemd-oomd/earlyoom eşiklerini ayarlar
- SSD'nin kalan ömrüne göre günlük yazma bütçesi koyar (`writeback_limit` vb.)
- Swap'ı şifreler; diske düşen parola ve anahtarlar güvenlik riskidir
- Dağıtımlara (Fedora, Ubuntu, Mint) varsayılan ayar önerileri gönderir

Kullanılacak arayüzler: `mkswap`/`swapon`, zswap/zram sysfs, cgroup v2 (`memory.high`,
`memory.swap.max`), PSI, `memory.reclaim`.

### Seçenek C: Yerel yapay zekâ modelleri için SSD offload katmanı

RAM'e veya ekran kartı belleğine sığmayan modelleri sıradan bilgisayarlarda çalıştırmak için,
llama.cpp gibi mevcut programların üzerine ince bir katman. Seyrek ve MoE modellerde sık
kullanılan parçaları RAM'de tutar, gerisini büyük ve ardışık okumalarla diskten getirir.
Çalıştırmadan önce beklenen hızı ve SSD aşınmasını dürüstçe gösterir. 6.1'deki llama.cpp örneği
bu alanın canlı olduğunu gösteriyor. Rekabetçi bir alan, bu yüzden mevcut projelere katkı
olarak başlamak daha verimli.

### Seçenek D: Uygulamaya özel, SSD'yi bellek gibi kullanan kütüphane

Belirli bir uygulamanın (veritabanı, emülatör, bilimsel hesaplama) erişim düzenini bilerek diski
bellek gibi kullanmasını sağlayan bir kütüphane. Linux'ta `userfaultfd` ya da `mmap` + `madvise`
ile yapılır. Erişim düzeni öngörülebilirse genel işletim sistemi sayfalamasından çok daha iyi
sonuç verebilir. Benzer projeler var (LLNL UMap, AIFM), bu yüzden dar bir hedef seçmek gerekir.

### Hangi seçenek seçilirse seçilsin: dürüstlük kuralları

- Asla "depolamayı RAM'e dönüştürür", "RAM'inizi X GB artırır" ya da "RAM'i ikiye katlar"
  deme. Doğru ifade: "RAM yetmediğinde depolamayı daha akıllı ve güvenli kullanır. Depolama
  RAM'den yüzlerce kat yavaştır, bu araç cihazı hızlandırmaz."
- Her iddiayı ölçümle göster. Bu projedeki `bench/` klasörü bir başlangıç.
- SSD aşınmasını ve güvenliği (şifreli swap) varsayılan olarak koru.
- Hukuki boyut: ABD'de FTC, SoftRAM95'in "RAM'i iki katına çıkarır" iddiası yüzünden şirkete
  yaptırım uyguladı. Türkiye'de 6502 sayılı Tüketicinin Korunması Hakkında Kanun yanıltıcı
  ticari reklamı yasaklıyor ve Ticaret Bakanlığı'na bağlı Reklam Kurulu bu tür reklamlara ceza
  verebiliyor. Ürün yayımlanacaksa iddiaların ölçümle kanıtlanabilir olması gerekir.

### Önerilen ilk adımlar

1. `bench/` programlarını kendi bilgisayarında çalıştır, kendi donanımındaki farkı gör.
2. Seçenek A için küçük bir prototip: Linux'ta `/proc/meminfo`, `/proc/pressure/memory`,
   `/proc/vmstat` ve NVMe SMART verisini okuyup Türkçe özet veren bir komut satırı aracı.
3. Aynı aracın Windows sürümü: performans sayaçları, sayfa dosyası ve commit bilgisi.
4. Sonra Seçenek B'nin önerileri otomatik uygulayan kısmı.

### Sonradan eklenen: Seçenek E, v.e.r.a WebSwap (yapıldı)

"Daha önce yapılmamış bir şey ve bütün cihazlarda" isteği üzerine altı aday fikir öncül araştırmasından
geçirildi ([webswap/docs/FIKIR-ARASTIRMASI.md](webswap/docs/FIKIR-ARASTIRMASI.md)). Seçilen fikir
**v.e.r.a WebSwap** oldu ve çalışan ilk sürümü bu depoda: [webswap/](webswap/).

WebSwap, WebAssembly'ye derlenen C programlarına (WebSwap ile yeniden derlenmeleri gerekir), gerçek wasm
belleklerinden çok daha büyük bir bellek verir. Sığmayan sayfalar tarayıcının siteye özel diskine (OPFS) taşınır.
Tarayıcı bütün cihazlarda ortak çalışma ortamı olduğu için, iPhone gibi uygulamalara swap vermeyen sistemler de
hedefte. Bu raporun sonuçlarıyla uyumlu olarak RAM eklemez ve hızlandırmaz: çökecek işin daha yavaş da olsa
bitmesini sağlar ve bedelini ölçer. Örneğin 2 GiB bellek isteyen bir sıralama, 69 MiB wasm belleğiyle (artı
~13 MiB JavaScript tarafı tablo), RAM'e göre 2,1 kat yavaş tamamlandı. Bu ölçümde takas dosyası, 15,7 GiB RAM'li
makinede işletim sisteminin dosya önbelleğinde kaldı; soğuk diskte ya da RAM'i az bir telefonda daha yavaş olur.
Benzetilmiş yavaş depolamada sıralı işler ~10-20 kat, rastgele erişen işler yüzlerce ile binlerce kat yavaşlıyor.
Ayrıntılar: [webswap/README.md](webswap/README.md).

---

## 9. Bugün hemen deneyebileceklerin

Aradığın özellik muhtemelen cihazında zaten var.

**Windows 10/11:**

- Ayar: Başlat'a "gelişmiş sistem ayarları" yaz → "Gelişmiş sistem ayarlarını görüntüle" →
  Gelişmiş sekmesi → Performans bölümünde "Ayarlar" → Gelişmiş sekmesi → Sanal bellek
  bölümünde "Değiştir". Türkçe Windows bu pencerede sayfa dosyasına "disk belleği dosyası"
  der; boyutu ve konumu buradan ayarlanır. Çoğu kişi için en iyisi "Tüm sürücüler için disk
  belleği dosyası boyutunu otomatik olarak yönet" seçeneğini açık bırakmak.
- İzleme: Görev Yöneticisi → Performans → Bellek. "Kaydedilen" (İngilizce arayüzde
  "Committed") değeri X/Y biçimindedir. X, programların şu an ayırmış olduğu toplam bellek;
  Y ise commit sınırı, yani RAM ile sayfa dosyasının toplamı. X, Y'ye yaklaşırsa Windows sayfa
  dosyasını büyütür ya da programlar "bellek yetersiz" hatası verir. "Kullanımda
  (Sıkıştırılmış)" değeri bellek sıkıştırmayı gösterir.
- Bellek sıkıştırmanın durumunu PowerShell'de `Get-MMAgent` komutu gösterir.
- **Sayfa dosyasını kapatmamalısın** (nedeni 3.3'te). Disk alanı kazanmak istiyorsan bakılacak
  dosya `hiberfil.sys`: sayfa dosyasından ayrı bir dosyadır ve hazırda bekletme içindir.
  Yönetici olarak açılan Komut İstemi'nde `powercfg /hibernate off` komutuyla kaldırılabilir.
  Bu disk alanı kazandırır ama RAM'i etkilemez; hazırda bekletme ve "Hızlı başlatma" özelliği
  de kapanır.

**Samsung telefon:** Ayarlar → Cihaz bakımı (eski sürümlerde "Pil ve cihaz bakımı") → Bellek →
RAM Plus. Kapatılabilir, boyutu değiştirilebilir. Bazı kullanıcılar kapalıyken telefonun daha
akıcı hissettirdiğini bildiriyor. Diğer markalarda menü adı farklı olabilir: "Bellek
uzantısı", "RAM genişletme", "Genişletilmiş RAM".

**Linux:** `swapon --show` komutu mevcut swap'ı gösterir. zram için dağıtımının
`zram-generator` paketine bak. Swap dosyası eklemek için:

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
```

(Btrfs gibi bazı dosya sistemlerinde swap dosyası oluşturmak için ek adımlar gerekir.)

**macOS:** Her şey otomatik. Etkinlik Monitörü → Bellek sekmesindeki "Bellek Baskısı" ve
"Kullanılan Takas" alanlarına bakabilirsin.

---

## 10. Başlıca kaynaklar

**Tarih ve temel kavramlar**
- Atlas ve sanal belleğin icadı (IEEE Milestone): https://ethw.org/Milestones:Atlas_Computer_and_the_Invention_of_Virtual_Memory,_1957-1962
- Denning, "The working set model for program behavior" (CACM, 1968): https://dl.acm.org/doi/10.1145/363095.363141

**İşletim sistemleri**
- Microsoft, sayfa dosyasına giriş: https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/introduction-to-the-page-file
- Microsoft, 64 bit Windows'ta sayfa dosyası boyutu: https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/how-to-determine-the-appropriate-page-file-size-for-64-bit-versions-of-windows
- Windows 10 bellek sıkıştırma (build 10525): https://blogs.windows.com/windows-insider/2015/08/18/announcing-windows-10-insider-preview-build-10525/
- Microsoft E7 blogu, SSD ve sayfa dosyası: https://learn.microsoft.com/en-us/archive/blogs/e7/support-and-q-a-for-solid-state-drives
- Android bellek yönetimi (depolamaya swap yapılmaması): https://developer.android.com/topic/performance/memory-management
- Android 14 davranış değişiklikleri: https://developer.android.com/about/versions/14/behavior-changes-all
- Linux zswap: https://docs.kernel.org/admin-guide/mm/zswap.html
- Linux zram: https://docs.kernel.org/admin-guide/blockdev/zram.html
- Linux MGLRU: https://docs.kernel.org/admin-guide/mm/multigen_lru.html
- Fedora swap-on-zram: https://fedoraproject.org/wiki/Changes/SwapOnZRAM
- Apple, iPadOS 16 duyurusu: https://www.apple.com/newsroom/2022/06/ipados-16-takes-the-versatility-of-ipad-even-further/
- iPad Air 5 (64 GB) ve swap: https://9to5mac.com/2022/06/14/ipad-air-5-lacks-memory-swap-stage-manager/
- Apple, bellek hakkında: https://developer.apple.com/library/archive/documentation/Performance/Conceptual/ManagingMemory/Articles/AboutMemory.html

**Telefonlarda sanal RAM**
- One UI 4.1 RAM Plus seçenekleri: https://www.sammobile.com/news/one-ui-4-1-choose-how-much-virtual-ram-you-want/
- One UI 5'te RAM Plus'ı kapatma: https://www.sammobile.com/news/one-ui-5-0-lets-you-disable-ram-plus-samsung-virtual-ram-feature/
- OPPO bellek genişletme: https://www.oppo.com/sg/newsroom/press/oppo-introduces-new-memory-expansion-technology/
- HMD, bellek uzantısı: https://www.hmd.com/en_int/support/hmd-pulse-user-guide/extend-memory
- Android Authority anket sonuçları: https://www.androidauthority.com/virtual-extended-ram-phone-poll-results-3154645/

**Donanım ve fizik**
- Izraelevitz ve ark., Optane DC PMM ölçümleri (2019): https://arxiv.org/abs/1903.05714
- Samsung 990 PRO veri sayfası: https://download.semiconductor.samsung.com/resources/data-sheet/samsung_nvme_ssd_990_pro_datasheet_rev.2.0.pdf
- Samsung 870 EVO veri sayfası: https://download.semiconductor.samsung.com/resources/data-sheet/Samsung_SSD_870_EVO_Data_Sheet_Rev1.1_230509.pdf
- Samsung SSD garanti koşulları: https://semiconductor.samsung.com/consumer-storage/support/warranty/
- Samsung UFS 4.0: https://news.samsungsemiconductor.com/global/samsung-develops-first-ufs-4-0-storage-solution-compliant-with-new-industry-standard/
- Intel Optane SSD P5800X: https://www.intel.com/content/www/us/en/products/sku/201860/intel-optane-ssd-dc-p5800x-series-800gb-2-5in-pcie-x4-3d-xpoint/specifications.html
- Sapphire Rapids bellek gecikmesi (Chips and Cheese): https://chipsandcheese.com/p/a-peek-at-sapphire-rapids

**Ticari geçmiş**
- Intel, IMDT'li P4800X'i durdurdu: https://www.tomshardware.com/news/intel-discontinues-optane-ssd-dc-p4800x-with-memory-drive-technology
- ScaleMP'nin SAP'ye satışı: https://www.storagenewsletter.com/2021/10/05/scalemp-sold-to-sap-last-june/
- Intel 2022 2. çeyrek 10-Q (Optane, 559 milyon dolar): https://www.sec.gov/Archives/edgar/data/50863/000005086322000030/intc-20220702.htm
- FTC ve SoftRAM (1996): https://www.ftc.gov/news-events/news/press-releases/1996/07/computer-software-manufacturer-agrees-settle-charges-software-misrepresentation
- Microsoft, SuperFetch ve ReadyBoost: https://techcommunity.microsoft.com/t5/ask-the-performance-team/windows-vista-superfetch-amp-amp-readyboost/ba-p/372337
- Samsung CMM-H: https://semiconductor.samsung.com/news-events/tech-blog/samsung-cxl-solutions-cmm-h/

**Araştırma**
- Meta TMO (ASPLOS 2022): https://dl.acm.org/doi/10.1145/3503222.3507731
- Meta mühendislik blogu, TMO: https://engineering.fb.com/2022/06/20/data-infrastructure/transparent-memory-offloading-more-memory-at-a-fraction-of-the-cost-and-power/
- Google far memory (ASPLOS 2019): https://dl.acm.org/doi/10.1145/3297858.3304053
- FlashVM (USENIX ATC 2010): https://www.usenix.org/conference/usenix-atc-10/flashvm-virtual-memory-management-flash
- SSDAlloc (NSDI 2011): https://www.usenix.org/conference/nsdi11/ssdalloc-hybrid-ssdram-memory-management-made-easy
- FlatFlash (ASPLOS 2019): https://dl.acm.org/doi/10.1145/3297858.3304061
- SkyByte (HPCA 2025): https://arxiv.org/abs/2501.10682
- ScaleSwap (FAST 2026): https://www.usenix.org/conference/fast26/presentation/ahn
- BaM (ASPLOS 2023): https://arxiv.org/abs/2203.04910
- ZeRO-Infinity (SC 2021): https://arxiv.org/abs/2104.07857
- FlexGen (ICML 2023): https://arxiv.org/abs/2303.06865
- Apple, "LLM in a flash": https://arxiv.org/abs/2312.11514
- llama.cpp, MoE uzmanlarının NVMe'den O_DIRECT ile okunması (Eylül 2026): https://github.com/ggml-org/llama.cpp/issues/29130

**Pazar ve yeni gelişmeler (2025-2026)**
- TrendForce DRAM fiyatları: https://www.trendforce.com/presscenter/news/20260202-12911.html ve https://www.trendforce.com/presscenter/news/20260601-13070.html
- Micron'un Crucial tüketici işinden çekilmesi: https://investors.micron.com/news-releases/news-release-details/micron-announces-exit-crucial-consumer-business
- SanDisk ve SK hynix, HBF standardı (FMS 2026): https://investor.sandisk.com/news-releases/news-release-details/sandisk-and-sk-hynix-advance-global-standardization-high
- SK hynix, HBF duyurusu: https://news.skhynix.com/en/hbf-at-fms-2026/
- EE Times Asia, HBF spesifikasyonu: https://www.eetasia.com/sk-hynix-sandisk-unveil-first-high-bandwidth-flash-standard-at-fms-2026/
- Phison aiDAPTIV+ (CES 2026): https://www.phison.com/en/category/article/press-releases/phison-aidaptiv-unlocks-powerful-ai-processing-on-pc-platforms
- Windows 11 sistem gereksinimleri: https://www.microsoft.com/en-us/windows/windows-11-specifications
- Microsoft DirectStorage: https://github.com/microsoft/DirectStorage

---

## Ek A: Araştırma yöntemi

- Yedi araştırma alanı paralel olarak incelendi. Toplam ~150 bulgu çıktı, her biri kaynaklı.
- Rapordaki önemli sayılar, tarihler ve ürün bilgileri (49 iddia), bulguları çürütmeye çalışan
  ayrı doğrulayıcılar tarafından yeniden kontrol edildi. Kısa cevapta kullanılan 9 iddia ikinci
  kez ve bağımsız olarak doğrulandı. Ayrı bir "eksik ne var?" incelemesi, kapsanmayan konuları
  (Windows ayarları, RAM booster uygulamaları, oyunlar, HBF vb.) araştırıp ekledi. Son olarak
  rapor, olgu tutarlılığı ve Türkçe anlaşılırlık açısından iki ayrı gözden geçirmeden geçti.
- Ölçümler bu projedeki `bench/` programlarıyla yapıldı.
- **Sınırlama:** Araştırma ortamının ağ politikası sitelerin çoğuna doğrudan erişimi engelledi.
  Bu yüzden doğrulamaların büyük çoğunluğu, birincil kaynakları aktaran arama sonucu
  özetlerine dayanıyor. Doğrudan okunabilen kaynaklar arasında Android belgesi, Microsoft'un
  sayfa dosyası belgesi, Linux çekirdek kaynak kodu ve llama.cpp'deki ilgili kayıt var. HBF,
  Phison ve DRAM fiyatı rakamları arama özetlerinden geliyor. Türk hukukuna, telefon menü
  adlarına, RAM Doubler'a ve Russinovich'in yazısına ilişkin bilgiler genel bilgiye dayanıyor;
  resmî kaynaktan ayrıca kontrol edilmeli.

## Ek B: Doğrulama sonucunda düzeltilen iddialar

| İddia | İlk hâli | Düzeltilmiş hâli |
|---|---|---|
| DRAM gecikmesi | ~60-100 ns | Masaüstünde ~60-95 ns, sunucularda ~95-120 ns |
| HDD rastgele erişim | Saniyede 100-200 erişim | QD1'de ~75-125 erişim; 150-200 değerleri komut kuyruğuyla ölçülüyor |
| SoftRAM satışları | 700.000'den fazla | Toplam ~700.000 (~100 bin SoftRAM + ~600 bin SoftRAM95); FTC kararı Ekim 1996'da kesinleşti |
| FlexGen | 175 milyar parametreli model disk offload ile saniyede ~1 token | Saniyede 1 token'a ulaşan ayar 4 bit sıkıştırmayla veriyi CPU belleğine sığdırıp diskten *kaçınıyor*; değer büyük toplu işler için geçerli |
| ScaleSwap | Linux swap ~4 GB/s, ham disk ~11 GB/s | Bu mutlak değerler doğrulanamadı. Doğrulanan: 128 çekirdek ve 8 NVMe ile Linux swap'a göre 3,4 kata kadar verim, 11,5 kata kadar düşük ortalama gecikme |
| iPadOS swap | Tüm M1 ve sonrası iPad'ler | M1 iPad Pro, en az 256 GB depolamalı M1 iPad Air ve sonraki M serisi; iPadOS 16.1 ile (Ekim 2022) |
| DDR5 perakende fiyatı | Belirli bir takipçide GB başına 2,16 → 18,44 dolar | Tam kaynak bulunamadı. Karşılaştırılabilir veriler: en ucuz kitlerde ~2,1 dolar/GB (Haziran 2025) → ~12 dolar/GB (Eylül 2026), ortalamalar ~17-18 dolar/GB. "RAM, NVMe'den GB başına ~100 kat pahalı" sonucu geçerli |

Doğrulanan başlıca iddialar: Atlas (1962), Intel IMDT ve 2021'deki sonu, ScaleMP'nin SAP'ye
satışı, Optane için 559 milyon dolarlık değer düşüklüğü, Meta TMO'nun %20-32 tasarrufu, Google
far memory'nin zswap kullanması, Android belgesindeki swap ifadesi, Samsung RAM Plus'ın
geçmişi, HMD'nin %90 kuralı, 990 PRO ve 870 EVO spesifikasyonları, 600 TBW ile 6,9 gün hesabı,
TrendForce'un 2026 ilk çeyrek verisi, Micron'un Crucial tüketici işinden çekilmesi.
