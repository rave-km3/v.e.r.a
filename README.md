# HALEN HALKA AÇIK DEĞİLDİR.

# V.E.R.A.

**Bitler üzerinde çalışan, şifre tasarlamak ve tasarlanan şifreyi ölçmek için yapılmış küçük bir programlama dili.**

V.E.R.A. ile bir blok şifreyi birkaç satırda yazarsınız. Araç aynı programı yorumlar, GF(2) üzerinde denklem
sistemine açar, mantık devresine çevirir ve gerçek x86-64 makine koduna derler; bütün bu yolların aynı sonucu
verdiğini otomatik denetler. Aynı devre üzerinde şifreyi ölçer (`analiz`), azaltılmış turlarda SAT çözücüyle anahtar
bulmayı dener (`kır`) ve deneysel olarak dosya şifreler (`şifrele`, `çöz`); bunlar
[ayrı bir bölümde](#şifreyi-ölçmek-kırmayı-denemek-ve-dosya-şifrelemek) anlatılır. Dosya uzantısı `.vera`'dır; dilin
tam kılavuzu [DIL.md](DIL.md) içindedir. Durum: sürüm 0.1, yalnızca Windows 11 üzerinde MSYS2 MinGW-w64 ile denendi
([Dürüstlük notu](#dürüstlük-notu)). Projede bu dille tasarlanmış deneysel bir blok şifre de vardır:
[KILIM](#kilim-deneysel-blok-şifre).

## Bir bakışta

| | |
|---|---|
| **Dil** | V.E.R.A.: bitlere özel şifre tasarım dili, Türkçe ve İngilizce anahtar kelimeler. Her program 4 bağımsız yoldan hesaplanır ve sonuçlar karşılaştırılır (kod, GF(2) denklemleri, mantık devresi, x86-64 makine kodu). |
| **Şifre** | KILIM v1 (deneysel): 128 bit blok, 128/256 bit anahtar, 20/24 tur. 24 turda en az 210 aktif S-kutusu kanıtlandı. |
| **Dosya şifreleme** | Varsayılan olarak kademeli: bağımsız anahtarlı AES-256-GCM + KILIM-256-GCM, Argon2id. `--yalniz-kilim` ile yalnız KILIM. |
| **Onaylı kasa** | Anahtar Shamir ile 5 parçaya bölünür; ECDSA imzalı iki aşamalı onayla 5 kişiden 3'ü onaylamadan açılmaz. |
| **Araçlar** | V.E.R.A. Studio masaüstü uygulaması (Electron + Monaco) ve VS Code eklentisi. |
| **Boyut ve sınama** | ~23 700 satır C++, ~17 700 satır sınama: modül sınamaları, uçtan uca, KILIM doğrulama, Studio, eklenti, anlam modeli ve VS Code paketleri. Güncel sayılar her CI koşusunun özetindedir (`sinama-ozeti.md`); burada sabit sayı tutulmaz. Son güvenlik denetimi: [GUVENLIK-DENETIMI.md](GUVENLIK-DENETIMI.md). |

![V.E.R.A. Studio: KILIM-128 kaynağı ve satıra bağlı GF(2) denklemleri](tanitim/studio-kilim.png)

![Gezginde KILIM şifreleme sistemi ve onaylı kasa](tanitim/studio-kilim-sistemi.png)

KILIM deneyseldir ve bağımsız kriptograflarca incelenmedi; gerçek sırlar için AES-GCM gibi denetlenmiş araçlar kullanılmalıdır
([Dürüstlük notu](#dürüstlük-notu), [yol haritası](YOL-HARITASI.md)).

## Hemen dene: V.E.R.A. Studio

**Masaüstü uygulaması:** `VERA-Studio-Kurulum-0.1.0.exe` ile kurulur; kendi penceresinde açılır, tarayıcı, adres çubuğu ya da
Node.js gerekmez ve internet olmadan çalışır. Kurulum dosyasını üretmek için: `powershell -ExecutionPolicy Bypass -File
masaustu\paketle.ps1` (ayrıntı: [masaustu/OKU-BENI.md](masaustu/OKU-BENI.md)).

Komut satırı kullanmadan denemek için tarayıcıda çalışan, VS Code düzeninde bir geliştirme ortamı vardır: önce
`derle.bat`, sonra `studio\baslat.bat`. Ortada Monaco düzenleyici (VS Code'un düzenleyicisi; V.E.R.A. için
renklendirme, tamamlama, anahtar kelime açıklamaları ve yazarken kırmızı çizgiyle hata işaretleme), solda dosya gezgini
(`calisma/` sizin klasörünüz; örnekler, KILIM ve bilerek bozulmuş programlar salt okunur), altta çıktı / sorunlar /
sağla paneli, sağda aynı programın üç aşaması: GF(2) denklemleri, 0/1 bit kodu ve x86-64 assembly. İmleç hangi
satırdaysa o satırdan türeyen denklemler ve assembly blokları sağda aydınlanır; bloğa tıklamak editörde satırı seçer.
Çalıştır görünümü `çalıştır`, `sağla`, `sına`, `analiz`, `kır` komutlarını sunar; girdi ve sabit kutuları programdan
kendiliğinden çıkar. Şifreleme görünümü bir dosyayı KILIM ile şifreleyip çözer (deneysel). KILIM Sistemi görünümü
`vera sistem`'i tek tuşla çalıştırır ve yedi adımın sonucunu geldikçe ✓/✗ ve süreleriyle gösterir. Node.js gerekir, ek paket
gerekmez; sunucu yalnızca kendi bilgisayarınızdan erişilebilir. Ayrıntı: [studio/OKU-BENI.md](studio/OKU-BENI.md).

VS Code kullanıyorsanız aynı özellikler bir eklenti olarak da var (renklendirme, anlık hata denetimi, F5 ile çalıştırma,
Aşamalar paneli): `powershell -ExecutionPolicy Bypass -File vscode-vera\kur.ps1`. Ayrıntı:
[vscode-vera/README.md](vscode-vera/README.md).

## Neden farklı?

Her V.E.R.A. programı derlenirken sabit bir mantık devresine açılır (döngüler açılır, işlevler yerine konur, veriye
bağlı döngü ya da dallanma yoktur). Bu yüzden aynı program birbirinden ayrı yollarla hesaplanabilir ve `sağla`
komutu sonuçların birebir aynı olduğunu denetler:

| Yol | Ne | Nasıl çalışır |
|---|---|---|
| 0 | Ara gösterim (IR) | Başvuru hesabı; diğer yollar bununla karşılaştırılır |
| 1 | Yorumlayıcı | Sözdizimi ağacını doğrudan yorumlar, IR'yi hiç kullanmaz |
| 2 | GF(2) denklem sistemi | XOR = `+`, VE = `·`; denklemler sırayla hesaplanır |
| 3 | Kapı devresi ve bit kodu | XOR / VE / DEĞİL kapıları; yalnızca 0 ve 1'den oluşan bit kodu sanal makinede çalışır |
| 4 | x86-64 assembly | Gerçek makine kodu (`.s`), oradan `.exe`; işlemci doğrudan çalıştırır |

Yol 1 dilin anlamını ağaçtan yeniden uygular; 2, 3 ve 4. yollar açılmış IR'den türer. Böylece ağaçtan IR'ye açma
aşamasındaki bir hata da yakalanabilir. Girdi biti 16 ya da azsa bütün girdiler, fazlaysa hepsi 0, hepsi 1 ve
rastgele girdiler denenir. Denetleyicinin gerçekten uyuşmazlık yakaladığını görmek için `--hata-ekle YOL` bir yolun
sonucunu bilerek bozar (`vera sağla ornekler/oyuncak4.vera --hata-ekle 2` çıkış kodu 1 ile biter ve çıktıda ilk
uyuşmazlık `<-- FARKLI` işaretiyle gösterilir).

Bu çapraz denetim uygulamaların birbiriyle tutarlı olduğunu gösterir; bir şifre tanımının doğru olduğunu (örneğin
S-kutusunun yanlış yazılmadığını) göstermez. Onun için yayımlanmış sınama vektörleri kullanılır
([aşağıda](#gerçek-şifrelerle-doğrulama)).

## Kısa bir örnek

`ornekler/oyuncak4.vera`: 4 bitlik, 2 turlu bir oyuncak şifre (yalnızca öğrenme amaçlı; anahtarı 4 bit).
Dosyanın sonunda bunun gibi 5 `sına` (sınama vektörü) satırı vardır; burada yalnızca biri gösterilmiştir.

```python
girdi p : 4        # açık metin (herkes görebilir)
gizli k : 4        # anahtar (gizli)
tablo S : 4 -> 4 = [0x9, 0x4, 0xA, 0xB, 0xD, 0x1, 0x8, 0x5,
                    0x6, 0x2, 0x0, 0x3, 0xC, 0xE, 0xF, 0x7]   # S-AES S-kutusu
x = p
tekrarla 2 kez
    x = x ^ k
    x = S[x]
    x = x <<< 1
son
çıktı c = x ^ k

sına p = 0x5, k = 0xA => c = 0x1
```

Aynı program aşamalara göre şöyle gösterilir (`vera`, proje klasöründeki `vera.exe` demektir; PowerShell'de
`.\vera.exe`, Git Bash'te `./vera.exe` yazın):

```text
$ vera çalıştır ornekler/oyuncak4.vera p=0x5 k=0xA          # programı çalıştırır
c = 0x1

$ vera matematik ornekler/oyuncak4.vera                      # 2. aşama: GF(2) denklemleri
GF(2) denklem sistemi   ('+' = XOR, '·' = VE)
Değişkenler: p0..p3 (girdi p), k0..k3 (gizli k), t0..t15 (ara)
Denklemler:
  t0 = p0 + k0                                 (satır 9)
…
Özet: 16 denklem (8 doğrusal, 8 doğrusal olmayan), en yüksek derece 3, 68 çarpma
…
Yapısal uyarı yok (kanıtlanabilen bir zayıflık bulunamadı).

$ vera bitler ornekler/oyuncak4.vera                         # 3. aşama: XOR / VE / DEĞİL kapıları
Kapı devresi (3. aşama)
…
  Mantık kapıları: 99  (XOR 54, VE 28, DEĞİL 17)
…

$ vera derle ornekler/oyuncak4.vera                          # 4. aşama: assembly ve .exe
Assembly yazıldı: oyuncak4.s  (işlev 'vera_oyuncak4', 2313 bayt)
Çalıştırılabilir dosya yazıldı: oyuncak4.exe
$ oyuncak4.exe p=5 k=0xA
c = 0x1

$ vera sağla ornekler/oyuncak4.vera                          # bütün yollar aynı mı?
…
SONUÇ: bütün yollar aynı sonucu verdi (7 yöntem × 256 girdi)
```

"Yapısal uyarı yok", şifrenin güvenli olduğu anlamına gelmez; yalnızca aracın kanıtlayabildiği zayıflıkların
bulunmadığını söyler. Kanıtlanabilen bir zayıflık varsa `matematik` bildirir. `ornekler/kaybolan_anahtar.vera`
anahtarı iki kez karıştırır, ama iki katman birbirini götürür:

```text
$ vera matematik ornekler/kaybolan_anahtar.vera
…
  c0 = p3
  c1 = p0 + 1
…
uyarı: çıktı 'c' gizli girdilere hiç bağlı değil: anahtar etkisiz (kanıtlandı)
uyarı: sistemin tamamı doğrusal: hiç doğrusal olmayan denklem yok, her çıktı biti girdilerin afin fonksiyonu (kanıtlandı)
```

## Türkçe ve İngilizce anahtar kelimeler

Değerler 1 ile 1024 bit arasında bit dizileridir; işleçler `^ & | ~ + -`, kaydırma `<< >>`, döndürme `<<< >>>`,
dilim `x[a:b]`, birleştirme `{a, b}` biçimindedir. Her anahtar kelimenin Türkçe ve İngilizce karşılığı vardır, ikisi
de aynı anlama gelir ve aynı dosyada karışık kullanılabilir. Türkçe harfsiz yazım da kabul edilir (`çıktı` = `cikti`,
`işlev` = `islev`). Hatalar Türkçe ve satır/sütunlu bildirilir. Ayrıntı: [DIL.md](DIL.md).

| Türkçe | İngilizce | Anlamı |
|---|---|---|
| `girdi` / `gizli` / `çıktı` | `input` / `secret` / `output` | açık girdi / gizli girdi (anahtar) / çıktı |
| `sabit` / `tablo` / `dizi` | `const` / `table` / `array` | derleme zamanı sabiti / S-kutusu / dizi |
| `işlev`, `döndür` | `fn`, `function`, `def` / `return` | işlev tanımı / dönüş |
| `tekrarla … kez`, `tekrarla i = a .. b` | `repeat`, `for` … `times` | döngü (iki uç da dahil) |
| `eğer` / `değilse` / `son` | `if` / `else` / `end` | derleme zamanı koşulu / blok sonu |
| `sına` / `yaz` | `test` / `print` | sınama vektörü / değeri ekrana yazar (yalnızca 1. yol) |

`ornekler/ozellikler.vera` iki dili bilerek karıştırır (örneğin `sabit TUR = 3` ile `const W = 16` yan yana durur).
`eğer` koşulu derleme zamanında bilinmelidir; veriye bağlı seçim `seç(c, a, b)` ile yapılır.

## Gerçek şifrelerle doğrulama

İki yayımlanmış hafif blok şifre V.E.R.A. diliyle yazılmıştır ve makalelerindeki resmî sınama vektörlerini bütün
yollardan yeniden üretir:

- **PRESENT-80** (Bogdanov ve ark., CHES 2007): `ornekler/present80.vera`, makaledeki 4 vektör.
- **SPECK32/64** (Beaulieu ve ark., 2013): `ornekler/speck32.vera` (İngilizce anahtar kelimelerle),
  yayımlanmış vektör `p = 0x6574694C, k = 0x1918111009080100 => c = 0xA86842F2`.

```text
$ vera sına ornekler/present80.vera
Sına: ornekler/present80.vera
  geçti  satır 37: p = 0x0000000000000000, k = 0x00000000000000000000 => c = 0x5579C1387B228445
  geçti  satır 38: p = 0x0000000000000000, k = 0xFFFFFFFFFFFFFFFFFFFF => c = 0xE72C46C0F5945049
  geçti  satır 39: p = 0xFFFFFFFFFFFFFFFF, k = 0x00000000000000000000 => c = 0xA112FFC72F68417B
  geçti  satır 40: p = 0xFFFFFFFFFFFFFFFF, k = 0xFFFFFFFFFFFFFFFFFFFF => c = 0x3333DCD3213210D2

SONUÇ: 4/4 sına geçti (her biri 7 yöntemle denendi)

$ vera çalıştır ornekler/present80.vera p=0xFFFFFFFFFFFFFFFF k=0xFFFFFFFFFFFFFFFFFFFF --yol 4 --ayrintili
# yol 4: x86-64 assembly
c = 0x3333DCD3213210D2
```

`vera sına ornekler/speck32.vera` de aynı biçimde "SONUÇ: 1/1 sına geçti (her biri 7 yöntemle denendi)" verir.
Resmî vektörlerin dışında, rastgele girdilerle de bütün yolların aynı sonucu verdiği denetlenebilir (süreler
makineye göre değişir; sabitler `-D AD=DEĞER` ile değiştirilebilir, örneğin `-D TUR=4` azaltılmış tur içindir):

```text
$ vera sağla ornekler/speck32.vera --sayi 300 --tohum 5
Sağla: ornekler/speck32.vera
  Program: 2 girdi (96 bit), 1 çıktı (32 bit), 243 IR düğümü
  Girdiler: 302 (hepsi 0, hepsi 1 ve 300 rastgele; tohum 5)

  Yol Yöntem                              Denenen  Uyuşmayan        Süre  Durum
  ------------------------------------------------------------------------------
  0   IR (ir::evaluate)                       302    başvuru    0.004 sn  tamam
  1   yorumlayıcı (sözdizimi ağacı)           302          0    0.011 sn  tamam
  2   GF(2) denklemleri, tek tek              302          0    0.152 sn  tamam
  2   GF(2) denklemleri, 64'lü                302          0    0.008 sn  tamam
  3   bit kodu sanal makinesi, 64'lü          302          0    0.001 sn  tamam
  3   kapı devresi, 64'lü                     302          0    0.001 sn  tamam
  4   x86-64 assembly (yerel kod)             302          0    0.399 sn  tamam

SONUÇ: bütün yollar aynı sonucu verdi (7 yöntem × 302 girdi)
```

## Şifreyi ölçmek, kırmayı denemek ve dosya şifrelemek

Bu bölümdeki dört komut aynı kapı devresi (3. aşama) üzerinde çalışır: `analiz` ve `kır` bir şifrenin zayıflıklarını
arar, `şifrele` ve `çöz` deneysel dosya şifrelemedir. Her biri neyi kaç örnekle ölçtüğünü yazar; hiçbiri bir şifreye
"güvenli" demez. Ölçümler **gereklidir, yeterli değildir**: bir sınamadan geçmek, o sınamanın o örnek sayısıyla bir
zayıflık yakalayamadığı demektir. Aşağıdaki çıktılar bu sürümde `vera.exe` ile gerçekten alınmıştır; uzun satırlar
ve bölümler `…` ile kısaltılmış, parola dosyası gibi yardımcı dosyalar elle hazırlanmıştır. Süreler makineye göre
değişir.

### `analiz`: ölçüm raporu

`vera analiz dosya.vera` programı kapı devresine açar ve bit dilimli çalışır (tek geçişte 64 örnek). `girdi` ile
bildirilenler açık metin, `gizli` ile bildirilenler anahtar sayılır. Rapor şu bölümlerden oluşur:

| # | Bölüm | Ne ölçülür |
|---|---|---|
| 0 | Kanıtlı yapısal uyarılar | `matematik` ile aynı sembolik inceleme; örnekleme yoktur, yazılan her uyarı kanıtlıdır |
| 1 | Tablolar (S-kutuları) | Tam hesap: fark düzgünlüğü (DU), LAT'ın en büyük değeri, cebirsel derece, afin bileşen, sabit nokta, dal sayısı |
| 2 | Yayılım | Her (girdi biti, çıktı biti) çiftinde bit çevirmek çıktıyı en az bir örnekte değiştirdi mi (açık ve gizli ayrı) |
| 3 | Çığ etkisi (SAC) | Bir girdi bitini çevirince çıktı bitinin değişme olasılığı 1/2'den 5σ'dan fazla sapıyor mu |
| 4 | Doğrusallık | BLR sınaması (yalnız anahtar, yalnız açık girdi, ikisi birlikte) ve derece ≤ 2 sınaması |
| 5 | Cebirsel derece | Küp toplamlarıyla derece **alt** sınırı; sıfır toplamlı (integral) ayırt edici arama |
| 6 | Tur taraması | `TUR` ya da `ROUNDS` gibi bir tur sabiti varsa, her tur sayısı için hızlı bir alt küme |

Seçenekler: `--hizli` (daha küçük örnekler), `--ornek N`, `--ayrintili` (tam SAC matrisi ve ısı haritası),
`--tur-tara` / `--tur-adi AD` / `--tarama-yok`, `--cube-sinir D` (en büyük küp boyutu), `--suresiz` (süreleri
yazmaz; aynı tohumla çıktı birebir aynı olur). Tohum verilmezse sabit bir tohum (20261012) kullanılır, yani aynı
komut aynı sonucu verir. Raporda UYARI olması çıkış kodunu değiştirmez (0); yalnızca kullanım ya da dosya hatasında
çıkış kodu 1'dir.

`ornekler/oyuncak4.vera` (4 bit, 2 tur) için rapor:

```text
$ vera analiz ornekler/oyuncak4.vera --suresiz
Analiz: ornekler/oyuncak4.vera
  Program: 2 girdi (açık 4 bit, gizli 4 bit), 1 çıktı (4 bit), 99 mantık kapısı
  Tohum: 20261012 (aynı tohum aynı sonucu verir; --tohum N ile değiştirilir)
…
== 1. Tablolar (S-kutuları) ==
…
  Tablo       n->m    Birebir     DU  max|LAT|  Derece  Afin bil.  Sabit nok.  Dal (fark/doğr.)
  S           4->4    evet         4         4       3          0           1             2 / 2
  S:
    4 bitlik birebir tablolar için en iyi değerler: DU 4, max|LAT| 4 (Leander-Poschmann 2007). Bu tablo: DU 4, max|LAT| 4 -> en iyi sınıfta
    Karar: belirgin bir tablo zayıflığı yok (eşikler: afin bileşen işlevi yok ve DU < 2^n)

== 2. Yayılım ve bağımlılık ==
…
  Karar: tam yayılım: bütün çiftler en az bir örnekte etkileşti (eşik: hiç etkileşmeyen çift = 0)

== 3. Çığ etkisi (SAC) ==
…
  Girdi türü           min P   max P  ort. P  en kötü |P-1/2|  (girdi -> çıktı)          5σ'yı aşan
  açık (girdi)         0.459   0.617   0.524           0.1172  p[2] -> c[2]                    7/16
  gizli (anahtar)      0.395   0.596   0.490           0.1047  k[1] -> c[0]                   10/16
…
  Karar: UYARI — SAC kaldı: 17/32 hücre 1/2'den 5σ = 0.0391'ten fazla saptı (en kötü sapma 0.1172; N = 4096)
…
== 5. Cebirsel derece (küp toplamları) ve sıfır toplamlı ayırt ediciler ==
…
  Derece alt sınırı (açık girdi değişkenlerinde, çıktı bitleri üzerinde): en küçük 3, en büyük 3; 4/4 çıktı biti denenen en büyük boyuta (3) ulaştı.
  Bu bir ALT sınırdır: gerçek derece daha büyük olabilir.
  Karar: denenen küplerde (d <= 3) sıfır toplamlı ayırt edici bulunamadı. Bu, daha büyük
  ya da başka küplerde bulunmayacağı anlamına gelmez.

== Özet ==
  1 uyarı:
  - SAC: 17/32 hücre 1/2'den 5σ = 0.0391'ten fazla saptı (en kötü sapma 0.1172; N = 4096)
```

Buradaki UYARI gözlenmiş bir yapıdır (4096 örnekte 17 hücre eşiği aştı); 4 bitlik 2 turlu bir oyuncak için şaşırtıcı
değildir ama bir saldırı değildir. Tablo ölçümlerinin "belirgin zayıflık yok" demesi de yalnızca tek S-kutusuyla
ilgilidir, şifrenin tamamıyla değil. Bilerek zayıf bir tasarımda (`ornekler/dogrusal4.vera`, tamamen doğrusal bir
şifre) aynı rapor 7 uyarı verir: 2 kanıtlı yapısal uyarı, hiç etkileşmeyen 12 açık ve 8 gizli çift, 32 hücrenin 32'sinde
SAC sapması, üç doğrusallık sınamasının üçünde "doğrusal/afin görünüyor" ve `{p[0], p[1]}` üzerinde 2 boyutlu bir
sıfır toplamlı küp.

Programda bir tur sabiti varsa (`TUR`, `ROUNDS` …) altıncı bölüm kendiliğinden gelir: her tur sayısı `r` için program
`-D TUR=r` ile yeniden açılıp hızlı bir alt küme ölçülür. PRESENT-80 için (`--hizli`):

```text
$ vera analiz ornekler/present80.vera --hizli --suresiz
…
== 6. Tur taraması (sabit TUR = 1..31) ==
…
   Tur  Etkileşmeyen (açık/gizli)  SAC en kötü    SAC   Afin/sabit çıktı  Sıfır toplamlı küp
     1       3840/4096  4790/5120        0.500  KALDI*                 0               d = 2
     2       3072/4096  3817/5120        0.500  KALDI*                 0               d = 2
     3           0/4096  709/5120        0.500  KALDI*                 0               d = 3
     4             0/4096  0/5120        0.500  KALDI*                 0               d = 4
     5             0/4096  0/5120        0.259  KALDI*                 0          bulunamadı
     6             0/4096  0/5120        0.081  KALDI*                 0          bulunamadı
     7             0/4096  0/5120        0.090  geçti                  0          bulunamadı
     8             0/4096  0/5120        0.094  geçti                  0          bulunamadı
…
    31             0/4096  0/5120        0.088  geçti                  0          bulunamadı
  tam yayılım 4 turda (tam tur sayısı 31, pay 27 tur)
  SAC 7 turdan sonra geçiyor (7. turdan itibaren taranan bütün turlarda) (tam tur sayısı 31, pay 24 tur)
  zero-sum ayırt edici en fazla 4 tura kadar bulundu (d <= 6) (tam tur sayısı 31, pay 27 tur)
  Bu sınamalardan geçmek GEREKLİDİR ama YETERLİ DEĞİLDİR: daha güçlü saldırılar (diferansiyel, doğrusal,
  ilişkili anahtar, daha büyük küpler …) çoğu zaman bu ölçümlerin geçtiği turlardan daha fazlasını kırar.
```

"Etkileşmeyen" sütunu, açık ve gizli girdi bitlerinden çıktı bitlerine giden çiftlerden hiç etkileşmeyenlerin
sayısıdır (önce açık, sonra gizli, her biri "etkileşmeyen / toplam çift"). Bu çalıştırmada (`--hizli`) SAC ilk ölçümde
N = 512 örnekle ve 0.1105 eşiğiyle yapılır; kalan turlar 4 kat örnekle (N = 2048, eşik 0.0552) yeniden ölçülür ve `*`
işaretli satırlarda karar ile "SAC en kötü" değeri bu ikinci ölçümden gelir. Bu yüzden 7. turda 0.090 `geçti` iken 6.
turda 0.081 `KALDI*` olabilir. "Pay", tam tur sayısıyla ilgili ölçümün işaret ettiği tur sayısı arasındaki farktır
(31 − 4 = 27); PRESENT-80'in gerçek güvenlik payı hakkında bir şey söylemez.

**`analiz` neyi göstermez.** Çok turlu fark ve doğrusal izlerin olasılıklarını, ilişkili anahtar saldırılarını ve yan
kanalları ölçmez; S-kutusu ölçümleri yalnızca tek tabloyu inceler. Küp toplamları derece için yalnızca bir alt sınır
verir. SAC, 5σ kuralıyla örnekler üzerinde çalışır; raporda hücre başına ve toplam yanlış alarm olasılığı yazılıdır.
Bir sınamadan geçmek şifrenin sağlam olduğunu değil, o sınamanın zayıflık bulamadığını gösterir.

### `kır`: SAT çözücüyle anahtar bulma (laboratuvar deneyi)

`vera kır dosya.vera` bilinen açık metin saldırısını dener. Programdaki `gizli` girdiler bilinmeyen anahtardır;
`girdi`ler bilinir ve her çift için rastgele seçilir. Komut rastgele (ya da `--anahtar` ile verilen) bir gerçek
anahtarla N (açık metin, şifreli metin) çifti üretir, devrenin N kopyasını gizli bitleri paylaşan tek bir CNF'ye
koyar ve projenin kendi CDCL çözücüsüyle (`src/sat.cpp`) çözer. Bulunan anahtar, bütün çiftlerde ve yeni rastgele
girdilerde gerçek anahtarla karşılaştırılır (`--dogrula`, varsayılan 1000). Gerçek bir sistemi kırmaz: yalnızca
verdiğiniz programın kendi ürettiği çiftlerle çalışır ve tam turlu bir şifrenin kırılabilirliği hakkında bir şey
söylemez. Tohum verilmezse her çalıştırmada rastgele seçilir ve raporda yazılır; yinelemek için `--tohum N` verin.

| Sonuç | Anlamı | Çıkış kodu |
|---|---|---|
| `KIRILDI` | Gerçek anahtar ya da eşdeğerliği **kanıtlanmış** bir anahtar bulundu | 0 |
| `ANAHTAR BELİRLENEMEZ` | Çıktılar anahtara bağlı değil; bu bir kırma değil, tasarım hatasıdır | 0 |
| `EŞDEĞER GÖRÜNÜYOR` | Farklı bir anahtar denenen girdilerde aynı çıktıyı verdi ama eşdeğerlik kanıtlanamadı (kanıtsız); kırma sayılmaz | 2 |
| `YANLIŞ POZİTİF` | Bulunan anahtar çiftlere uyuyor ama gerçek anahtar değil; daha çok çift gerekir (`--cift`) | 2 |
| `ZAMAN AŞIMI` | Çözücü süre ya da çatışma sınırında anahtarı bulamadı | 2 |
| `ÇÖZÜM YOK` | İç hata | 1 |

Seçenekler: `--cift N` (varsayılan: ⌈gizli bit / çıktı biti⌉ + 2, en çok 64), `--bilinen B` (anahtarın B bitini
saldırgana açar; `--bilinen-secim rastgele|dusuk|yuksek`), `--sure SN` (varsayılan 60, 0 = sınırsız), `--catisma N`,
`--anahtar AD=DEĞER`, `--dogrula N`, `--tek` (bulunan anahtarı yasaklayıp başka anahtar da uyuyor mu diye yeniden
çözer), `--tur-tara a..b` (her tur sayısı için saldırıyı yineler, tablo yazar; `--tur-adi AD`, `--hepsi`), `--cnf DOSYA`
(saldırıyı DIMACS CNF olarak kaydeder, `--cozmeden` ile yalnızca yazar ve dış bir çözücüye bırakır). Farklı ama eşdeğer
görünen bir anahtar için ayrıca SAT ile eşdeğerlik kanıtı denenir (en çok 10 sn).

Oyuncak şifrenin 4 bitlik anahtarı hemen bulunur:

```text
$ vera kır ornekler/oyuncak4.vera --tohum 1
Kır: ornekler/oyuncak4.vera
  Saldırı modeli: bilinen açık metin. Bilinmeyen (gizli): k (4 bit).
                  Bilinen, her çiftte rastgele: p (4 bit).
                  Gözlenen: c (4 bit).
  Devre: 99 kapı (XOR 54, VE 28, DEĞİL 17), VE derinliği 6
  Gerçek anahtar: k = 0xC  (tohum 1 ile rastgele seçildi)
  Açığa çıkan anahtar biti: 0 / 4  → aranan uzay 2^4 anahtar
  Bilinen çiftler: 3 (otomatik: ⌈4 gizli bit / 4 çıktı biti⌉ + 2; --cift ile değiştirilebilir)
…
  CNF: 262 değişken, 924 clause (3 kopya; değişken 1..4 gizli bitler)

  Çözüm: SAT (bir anahtar bulundu)
  Çözücü: 9 çatışma, 16 karar, 696 yayılım, 0 yeniden başlatma, 9 öğrenilen clause; 0.000 sn
  Bulunan anahtar: k = 0xC
  Doğrulama: 3/3 çift uyuyor; bütün 16 açık girdinin 0 tanesinde gerçek anahtardan farklı çıktı
…
SONUÇ: KIRILDI — anahtar tam olarak bulundu ve doğrulandı (0.001 sn)
Ayarlar: 3 çift, 0 açığa çıkan bit, sınır 60.0 sn.
Bu laboratuvar deneyi yalnızca bu tur sayısı ve bu ayarlar hakkında bilgi verir; aynı şifrenin tam
turlu hâli ya da başka ayarlar için bir şey söylemez.
```

Gerçek bir şifrenin azaltılmış turlu hâlleri için tur taraması en bilgilendirici kullanımdır. SPECK32/64'te anahtarın
yarısı (64 bitten 32'si) saldırgana açıkken, tur başına 30 sn sınırla:

```text
$ vera kır ornekler/speck32.vera --tur-tara 1..6 --bilinen 32 --sure 30 --tohum 1
Kır — tur taraması: ornekler/speck32.vera
  Tur sabiti: ROUNDS (programdaki değer 22); denenecek: 1..6
  Her tur sayısında aynı tohum (1): aynı anahtar ve aynı açık girdiler kullanılır.
  İlk ZAMAN AŞIMI'nda (ya da iç hatada) durur; hepsini denemek için --hepsi.
  Ayarlar: 4 çift (otomatik), 32 / 64 açığa çıkan anahtar biti, sınır 30.0 sn

   Tur  Sonuç                                 Süre     Çatışma  CNF değişken  CNF clause
  --------------------------------------------------------------------------------------
     1  KIRILDI (eşdeğer anahtar)         0.003 sn           0           616        1868
     2  KIRILDI (eşdeğer anahtar)         0.004 sn           0          1400        4772
     3  KIRILDI (eşdeğer anahtar)         0.005 sn           7          2184        7676
     4  KIRILDI                           0.050 sn        1145          2968       10580
     5  KIRILDI                           1.642 sn       26294          3752       13484
     6  ZAMAN AŞIMI                        30.0 sn      424313          4536       16388

SAT saldırısı bu ayarlarla 5 tura kadar kırdı.
Ayarlar: 4 çift, 32 açığa çıkan bit, tur başına sınır 30.0 sn.
Not: Daha fazla turu kıramamak güvenlik hakkında hiçbir şey kanıtlamaz: daha uzun süre, daha güçlü bir
çözücü, başka ayarlar ya da başka bir saldırı türü daha çok tur kırabilir. Açığa çıkarılan bitler gerçek
bir saldırganda yoktur; tablo yalnızca bu deneyin ölçümüdür.
```

`KIRILDI (eşdeğer anahtar)`, bulunan anahtarın gerçek anahtardan farklı olduğunu ama her girdide aynı çıktıyı verdiğinin
kanıtlandığını söyler. Bu tablo SPECK32/64'ün güvenliğini ölçmez: anahtarın yarısı bedavaya verildiği için
kolaylaştırılmış bir deneydir ve tek bir tohumla, tek bir çözücüyle, 30 sn sınırla yapılmıştır. "6. turda zaman aşımı", 6. turun güvenli olduğu
anlamına gelmez; yalnızca bu ayarlarla bu çözücünün bulamadığını gösterir. Tek bir tur sayısı için sınır dolarsa
(`vera kır ornekler/speck32.vera -D ROUNDS=8 --bilinen 32 --sure 5 --tohum 1`) sonuç
`SONUÇ: ZAMAN AŞIMI — çözücü sınır içinde (5.000 sn) anahtarı bulamadı` olur ve çıkış kodu 2'dir; `--tur-tara`
tablosunda ise çıkış kodu 0'dır (yalnızca iç hatada 1). Anahtarın çıktıya hiç etkisi olmayan bir tasarımda
(`ornekler/kaybolan_anahtar.vera`) komut bunu bir kırma olarak değil, tasarım hatası olarak bildirir:
`SONUÇ: ANAHTAR BELİRLENEMEZ — çıktılar anahtara bağlı değil (kanıtlandı)`.

### `şifrele` ve `çöz`: deneysel dosya şifreleme

Şifreli dosyaların uzantısı `.vsf`'dir: **V.E.R.A. şifreli dosya**. `.vera` yalnızca V.E.R.A. programları (metin kodu) içindir; ikisi bilerek ayrıdır ki editör, VS Code eklentisi ve Windows şifreli bir dosyayı kod sanıp açmaya çalışmasın. `vera çöz` dosyayı uzantıdan değil, başındaki `VERA1`/`VERA2` imzasından tanır; uzantı yalnızca bir etikettir.

> **DENEYSELDİR.** KILIM ve V.E.R.A. programları bağımsız olarak incelenmemiştir; komutun kendisi de denetlenmemiştir.
> Çevredeki parçalar standarttır. Varsayılan kademeli kipte dosya ayrıca bağımsız anahtarlı AES-256-GCM ile
> şifrelenir; yalnız KILIM kipinde gizlilik KILIM'den iyi olamaz. **Gerçek sırlar için age ya da VeraCrypt
> kullanın.** Komut bu uyarıyı her çalıştırmada yazar.

**VERA2 (program vermeden; yeni dosyalar).** `vera şifrele <girdi> <çıktı>` dosyayı varsayılan olarak kademeli
şifreler: önce AES-256-GCM, sonra KILIM-256-GCM. `vera şifrele <girdi> <çıktı> --yalniz-kilim` yalnız KILIM-256-GCM
kullanır. `vera çöz <şifreli> <çıktı>` takımı başlıktan okur, doğrulayıp çözer; kademeli varsayılan olmadan önce
yazılmış yalnız KILIM dosyaları da açılır (`testler/veri/vera2_kilim_*.vsf` bunu sınar).

- **Şifre:** KILIM-256 (sabit zamanlı C++ çekirdeği, `src/kilim.cpp`) standart GCM kipinde (NIST SP 800-38D). GHASH
  sabit zamanlıdır: işlemcide varsa PCLMULQDQ, yoksa tablo kullanmayan taşımasız çarpma. GCM katmanı AES-128/256
  (Windows CNG) ile NIST vektörlerini, KILIM-GCM de bağımsız bir GCM + `tasarim/referans.js` ile aynı sonucu verir.
- **Anahtar:** parola Argon2id ile işlenir (RFC 9106; varsayılan 64 MiB, 3 geçiş, 1 şerit, bu bilgisayarda ≈0,1 sn;
  `--bellek MiB`, `--gecis N`). Ardından HKDF-SHA256 her iş için ayrı etiketle bağımsız anahtar türetir. Başlıktaki
  Argon2 ayarları sınırlıdır (en çok 1024 MiB, 10 geçiş, bellek × geçiş ≤ 4 GiB): değiştirilmiş bir başlık dev bellek
  ya da süre isteyemez.
- **Parçalama (STREAM, age'deki gibi):** 64 KiB'lık parçalar; her parçanın nonce'u = rastgele önek ‖ parça sırası ‖
  son parça bayrağı, başlığın tamamı her parçanın AAD'sidir. Parçaların yerini değiştirmek, düşürmek, çoğaltmak,
  dosyayı bir parça sınırında kesmek ya da uzatmak yakalanır. Çözülen parçalar geçici dosyaya yazılır; çıktı ancak
  bütün etiketler tutarsa yerine konur, tutmazsa geçici dosya sıfırlanıp silinir.
- **Kademeli (varsayılan):** her parça önce AES-256-GCM (Windows CNG), sonra KILIM-256-GCM ile şifrelenir (VeraCrypt'teki
  gibi art arda iki şifre). İki anahtar HKDF'den farklı etiketlerle türetildiği için birbirinden bağımsızdır: KILIM ya
  da AES'ten biri tümüyle kırılsa bile öteki dosyayı korumaya devam eder. Bedeli parça başına 16 bayt ve biraz hızdır.
  Eski `--kademeli` seçeneği kabul edilir ve varsayılanla aynıdır. AES katmanı Windows CNG ile çalıştığı için başka
  sistemlerde varsayılan kip reddedilir; orada `--yalniz-kilim` verilmelidir.
- **`--yalniz-kilim`:** AES katmanı olmadan yalnız KILIM-256-GCM. Koruma tümüyle KILIM'e bağlıdır; KILIM'in kendisini
  ölçmek ya da kıyaslamak için.
- **Hız (bu bilgisayar, 50 MiB):** KILIM-256-GCM ≈440 MB/sn, kademeli ≈375 MB/sn (`testler/sifre_test.cpp` ölçer).
- **Biçim:** 94 baytlık `VERA2` başlığı, ardından parçalar (her biri en çok 64 KiB + 16 bayt etiket; kademelide 32).
  Tam tanım `src/filecrypt.hpp` içindedir.

**VERA1 (program kipi).** Kendi blok şifrenizi denemek için program verilir; eski VERA1 dosyaları da böyle çözülür.
`vera şifrele <program.vera> <girdi dosyası> <çıktı dosyası>` bir dosyayı, `program.vera` ile tanımlı blok şifreyle CTR
kipinde şifreler ve şifreli metnin tamamını HMAC-SHA256 ile mühürler (şifrele-sonra-MAC). `vera çöz` aynı program ve
aynı anahtarla geri açar. Program tam bir `girdi` (blok, 8'in katı ve 32..1024 bit), tam bir `gizli` (anahtar, 8'in katı) ve blokla aynı
genişlikte tek bir `çıktı` içermelidir; yalnızca şifreleme yönü kullanılır, ters işlev gerekmez. Çözerken aynı
program ve aynı `-D` değerleri verilmelidir: programın parmak izi (bit kodunun SHA-256'sı) dosyaya yazılır ve
uyuşmazlıkta çözme reddedilir.

- **Anahtar.** Varsayılan parola kipidir: parola konsoldan yankısız sorulur (şifrelerken iki kez),
  `--parola-dosyasi DOSYA` ile dosyanın ilk satırından ya da `--parola-stdin` ile yönlendirilmiş standart girdinin
  ilk satırından okunur (başka bir program parolayı diske yazmadan verebilsin diye; Studio bunu kullanır). Parola
  komut satırında verilemez. Konsoldan sorma
  yalnızca gerçek bir Windows konsolunda (PowerShell, cmd) çalışır; Git Bash'te `winpty ./vera.exe …` ya da
  `--parola-dosyasi` kullanın. Parola dosyası düz metindir: onu okuyabilen herkes parolayı da okur. Anahtar,
  PBKDF2-HMAC-SHA256 (16 bayt rastgele tuz, varsayılan 600000 tekrar; `--tekrar N`, 100000..10000000) ve HKDF-SHA256 ile
  blok şifre anahtarına ve MAC anahtarına türetilir. `--anahtar-dosyasi DOSYA` ile onaltılık ham anahtar (16..4096
  bayt) da verilebilir; o zaman da dosyaya özgü tuzla HKDF uygulanır. Parola hangi yoldan gelirse gelsin (konsol,
  `--parola-dosyasi`, `--parola-stdin`) 12 karakterden kısaysa `not:` yazılır; `--tekrar` varsayılanın (600000)
  altındaysa da not yazılır. Uzun ve tahmin edilemez bir parola seçmek size düşer.
- **Kip.** Sayaç bloğu = rastgele `n/2` bit nonce ‖ `n/2` bit sayaç; bir dosyada en çok `2^(n/2)` blok şifrelenir.
  Tuz ve nonce her zaman işletim sisteminin güvenli rastgele kaynağından gelir (`--tohum` bu komutta kabul edilmez).
- **Çözme sırası.** Etiket önce doğrulanır; tutmazsa hiçbir açık metin yazılmaz. Çıktı önce geçici dosyaya yazılır,
  iş bitince yeniden adlandırılır. Var olan bir dosyanın üzerine yalnızca `--uzerine-yaz` ile yazılır.
- **Dosya biçimi.** `VERA1` başlığı (64 bitlik blokta 75 bayt), şifreli metin, 32 bayt HMAC etiketi. Bayt sırası ve
  alanlar `src/filecrypt.hpp` içinde tanımlıdır.

```text
$ vera şifrele ornekler/present80.vera notlar.txt notlar.vsf --parola-dosyasi parola.txt
!!! UYARI: DENEYSEL ŞİFRELEME !!!
  Blok şifre bir V.E.R.A. programıdır ve BAĞIMSIZ OLARAK İNCELENMEMİŞTİR; bu komut da denetlenmemiştir.
  Gerçek sırlar için KULLANMAYIN: onun yerine AES-GCM, age ya da VeraCrypt gibi denetlenmiş araçları kullanın.
  …
not: blok 64 bit: sayaç 32 bit, bir dosyada en çok 34359738368 bayt şifrelenebilir; 128 bitten küçük bloklar büyük verilerde ayırt edilebilirlik saldırılarına daha açıktır
not: anahtar 80 bit: 128 bitten kısa anahtarlar bugünkü ölçülere göre kaba kuvvete karşı zayıf sayılır
Şifrelendi: notlar.txt -> notlar.vsf
  Program:     ornekler/present80.vera  (blok 'p' 64 bit, anahtar 'k' 80 bit, 21444 kapı)
  Parmak izi:  81022c3a50e4cdb0f10279513b101ad56a270e5705c0aa591d18ac0dc9bfd77e
               (SHA-256, programın 0/1 bit kodundan)
  Anahtar:     parola -> PBKDF2-HMAC-SHA256 (600000 tekrar, 0.48 sn) -> HKDF-SHA256
  Kip:         CTR (32 bit rastgele nonce + 32 bit sayaç), şifrele-sonra-MAC: HMAC-SHA256
  Boyut:       37 bayt açık metin -> 144 bayt dosya (başlık 75 + etiket 32 bayt), 5 blok
  …
Bu çıktı yalnızca ne yapıldığını ve hızı gösterir; şifrenin güvenli olduğunu GÖSTERMEZ.

$ vera çöz ornekler/present80.vera notlar.vsf acik.txt --parola-dosyasi parola.txt
!!! UYARI: DENEYSEL ŞİFRELEME !!!
  …
Çözüldü: notlar.vsf -> acik.txt
  …
  Doğrulama:   HMAC-SHA256 etiketi tuttu (açık metin ondan SONRA yazıldı)
  Boyut:       37 bayt açık metin, 5 blok
  …
Etiketin tutması dosyanın parolayı/anahtarı bilmeyen biri tarafından değiştirilmediğini gösterir;
blok şifrenin gizlilik sağladığını GÖSTERMEZ.
```

Şifreli dosyada tek bir bayt değiştirilirse (ya da parola yanlışsa; ikisi ayırt edilemez) çözme açık metin yazmadan
çıkış kodu 1 ile biter; yanlış programla çözmek de reddedilir:

```text
$ vera çöz ornekler/present80.vera bozuk.vsf acik.txt --parola-dosyasi parola.txt
…
vera: hata: doğrulama BAŞARISIZ: parola/anahtar yanlış, ya da dosya değiştirilmiş veya bozulmuş (HMAC etiketi tutmuyor). Hiçbir açık metin yazılmadı

$ vera çöz ornekler/speck32.vera notlar.vsf acik.txt --parola-dosyasi parola.txt
…
vera: hata: bu dosya 64 bitlik blok ve 80 bitlik anahtarlı bir programla şifrelenmiş; verilen program 32 / 64 bit (başka bir program)
```

**Sınırlar.** Başlık düz metindir: açık metnin uzunluğu, blok ve anahtar boyutları, PBKDF2 tekrar sayısı ve programın
parmak izi şifrelenmez; dosya adı ve zaman damgalarını dosya sistemi tutar. Üretilen kodun yan kanal (zamanlama
vb.) güvenliği hakkında bir iddia yoktur. Örnekteki PRESENT-80'in 64 bitlik bloğu ve 80 bitlik anahtarı bugün
küçük sayılır (komut bunu her seferinde not düşer). Etiketin tutması dosyanın, parolayı ya da anahtarı bilmeyen biri
tarafından değiştirilmediğini gösterir; blok şifrenin gizlilik sağladığını göstermez. Bir programı `analiz` ve `kır`
ile ölçmüş olmak da onu şifreleme için uygun yapmaz.

## KILIM: deneysel blok şifre

`sifreler/kilim/` klasöründe, bu dille yazılmış **KILIM v1** bulunur: bu proje için tasarlanmış, 128 bitlik bloklu,
128 ya da 256 bitlik anahtarlı (20 / 24 turlu) **deneysel** bir blok şifre. Durum, 4 satır × 8 sütunluk 4 bitlik
hücrelerden oluşan bir ızgaradır; her tur "anahtar ekle, S-kutusu (PRINCE), satır kaydır, sütun karıştır" adımlarından
oluşur. Amacı, bu dilin araçlarıyla (`analiz`, `kır`, `matematik`) zayıflıkları **ölçülebilen** bir şifre olmaktır.
**Güvenli olduğu iddia edilmez**, bağımsız bir incelemeden geçmemiştir ve **gerçek sırları korumak için
kullanılmamalıdır**.

| Ne | Nerede |
|---|---|
| Öğrenci rehberi: blok şifre nedir, 4×8 ızgara, bir tur adım adım, anahtar sırası, neden 20/24 tur, nasıl tasarlandı ve ölçüldü, ne iddia edilmiyor | [`sifreler/kilim/KILIM.md`](sifreler/kilim/KILIM.md) |
| Ölçüm raporu: her sayı, komut ve sınır | [`sifreler/kilim/OLCUM-RAPORU.md`](sifreler/kilim/OLCUM-RAPORU.md) |
| Bağlayıcı tanım (İngilizce): algoritma, test vektörleri, tasarım geçmişi | [`tasarim/SIFRE-TASARIM.md`](tasarim/SIFRE-TASARIM.md) |
| Bağımsız Node başvuru gerçeklemesi | [`tasarim/referans.js`](tasarim/referans.js) |
| Sekiz `.vera` programı (biri tek dosyada bütün KILIM) ve çalıştırma örnekleri | [`sifreler/kilim/OKU-BENI.md`](sifreler/kilim/OKU-BENI.md) |

**Tek dosyada KILIM.** `sifreler/kilim/kilim_tek.vera`, KILIM-128 ve KILIM-256'nın şifreleme ve çözmesini tek programda
toplar: girdiler `p`, `k128`, `k256`; çıktılar `c128`, `geri128`, `c256`, `geri256` ve iki çözme de `p`'yi geri
getirdiyse 1 olan `tamam`. Studio'da Hoş geldiniz sekmesinin ilk kartıdır; Çalıştır, Sağla, Sına ve Analiz bu dosyayla
çalışır (Analiz'in uyarıları beklenir: `geri` çıktıları `p`'nin kendisidir). Çıktıları 200 rastgele girdide dört ayrı
dosyanınkiyle aynıydı; `kilim_dogrula.sh` ayrıca `referans.js` ile karşılaştırır. Dosya şifreleme, Argon2id ve onaylı
kasa bir V.E.R.A. programında olamaz (program sabit bir devredir); onlar KILIM Sistemi panelinde ve `vera sistem`'dedir.

```text
$ vera sına sifreler/kilim/kilim128.vera
…
SONUÇ: 4/4 sına geçti (her biri 7 yöntemle denendi)

$ vera çalıştır sifreler/kilim/kilim128.vera p=0x00112233445566778899AABBCCDDEEFF k=0x000102030405060708090A0B0C0D0E0F
c = 0xD783A9EE6A1D066ED2E06CF478E28F93
```

Ölçüm raporundan üç sonuç (sayılar, örnek büyüklükleri ve sınırlar raporda): *"KILIM doğrulama paketi 212/212 geçti"*;
bu, yazımın tasarım belgesi ve bağımsız `referans.js` ile aynı olduğunu gösterir, şifrenin iyi olduğunu göstermez.
Hiç değişmeyen (açık bit, şifreli bit) çifti sayısı 1, 2 ve 3 turda **14336 / 8192 / 0**: yayılım 3 turda tamamdır.
SAT saldırısı (`kır`) anahtar biti açığa çıkmadığında her boyda yalnızca **1 tur** kırabildi; rapora göre bu sonuç
KILIM'den çok V.E.R.A.'nın tek iş parçacıklı çözücüsü hakkında bilgi verir. Ölçülmeyenler (DDT/LAT, iz sınırları,
değişmez alt uzay...) ve kalan riskler `KILIM.md`'nin 10. ve raporun 11. bölümünde yazılıdır.

## Onaylı kasa (`kasa`)

`vera kasa`, bir dosyayı **en az t farklı kayıtlı onaycı aynı talebe onay vermeden açılamayacak** biçimde saklar. Veri
rastgele bir anahtarla AES-256-GCM ile şifrelenir; anahtar Shamir yöntemiyle paylara bölünür (varsayılan: 5 onaycı, eşik
3). Onay **iki aşamalıdır**: her onaycı talebi kendi cihazında görüp ECDSA ile imzalar (pay vermez); aynı talep için en
az t farklı onay bir demette gösterilince, onaylayanlar paylarını yalnızca o talebe serbest bırakır. Tek bir pay anahtar
hakkında hiçbir şey göstermez; ayrı taleplere verilmiş eşik-altı onaylar hiç pay vermez.

**Neden iki aşama?** Kasanın ilk sürümünde "evet" demek payı da teslim etmekti. Kötü niyetli bir talep eden Pazartesi bir
talep açıp iki kişiden, Perşembe başka bir talep açıp üçüncü bir kişiden onay alırsa hiçbir talep eşiğe (3) ulaşmaz, ama
elinde üç farklı kişinin payı birikir ve kasayı açar ("birleştirme saldırısı"). Bunu önceki sürümde gerçekten çalıştırıp
gösterdim (KASA.md 6.4). İki aşamalı onayda ilk onay yalnızca imzadır (pay yok); pay ancak **aynı talep** için en az t onay
bir demette toplanınca ve yalnızca o talebe verilir. Aynı deneme yeni sürümde 3 imza ile sıfır pay verdi. Hikâye ve gerçek
çıktılar: [KASA.md, 1.1](KASA.md#11-neden-onay-iki-aşamalı-pazartesi-ve-perşembe-hilesi) ve
[6.4](KASA.md#64-eşik-altı-onayları-birleştirme-saldırısı).

**Ayrıntılı rehber: [KASA.md](KASA.md)** (lise düzeyinde anlatım). İçinde şunlar var: Shamir'in küçük bir sayı örneği,
ECDSA onaylarının ne kattığı, gerçek komut çıktılarıyla adım adım akış (`anahtar-üret` ×5, `oluştur`, `talep`,
`onayla` ×3, `topla`, `pay-ver` ×3, `aç`), 2 serbest bırakmayla açma, sahte pay, tekrar oynatma ve eşik-altı onayları
birleştirme saldırısı denemeleri, yeni sürüm (rotasyon), tehdit modeli, dürüst sınırlar ve Fireblocks'un MPC'siyle
ilişkisi.

```text
vera kasa anahtar-üret ali                 # 1. her onaycı: ali.pub (kasa sahibine) + ali.anahtar (parolalı)
vera kasa oluştur gizli.txt --onaycilar ali.pub,berk.pub,cemre.pub,deniz.pub,ece.pub      # 2. kasa sahibi: 3/5
vera kasa talep gizli.txt.kasa             # 3. açmak isteyen: gizli.txt-1.talep (+ .gizli, bu bilgisayarda kalır)
vera kasa onayla gizli.txt-1.talep --anahtar ali.anahtar --pay gizli.txt.ali.pay          # 4. her onaycı (×3): yalnızca imza
vera kasa topla gizli.txt-1.talep --onaylar a.onay,b.onay,c.onay                         # 5. açmak isteyen → gizli.txt-1.demet
vera kasa pay-ver gizli.txt-1.demet --anahtar ali.anahtar --pay gizli.txt.ali.pay        # 6. onaylayanlar (×3): payı bırakır
vera kasa aç gizli.txt.kasa --talep gizli.txt-1.talep --birakmalar a.birakma,b.birakma,c.birakma -o çıktı.txt   # 7.
vera kasa bilgi DOSYA | vera kasa doğrula DOSYA | vera kasa günlük | vera yardım kasa
```

İki onayla (ya da başka talebe verilmiş onaylarla) `topla` demet yazmaz ve `pay-ver` pay bırakmaz; `aç` yalnızca
`pay-ver`in ürettiği `.birakma` dosyalarını sayar, `.onay` dosyaları pay içermez (KASA.md 5.4 ve 6.4'te gerçek çıktılar).

**Dürüstlük.** Veri denetlenmiş yapı taşlarıyla korunur: AES-256-GCM, ECDSA P-256, ECDH P-256 ve PBKDF2 Windows CNG'den
(`bcrypt.dll`, `ncrypt.dll`), SHA-256 / HMAC / HKDF projenin RFC vektörleriyle denetlenmiş `crypto` modülünden gelir.
Buna karşılık **onay protokolü** ve Shamir paylaştırması bu projeye özgüdür; **yenidir ve yalnızca projenin içinden
yapılan incelemelerden geçmiştir, bağımsız bir uzman denetimi yoktur.** Kasa, Fireblocks'un `mpc-lib` incelemesinden
esinlenmiştir ama **MPC değildir**. Komut her çalıştığında bunu yazar. Bilinen başlıca sınırlar (tamamı
[KASA.md, 9. bölüm](KASA.md#9-dürüst-sınırlar)):

- Açılış anında K ve t pay, açan bilgisayarın belleğinde bir aradadır: açan K'yi görür ve o sürümü sonradan onaysız da
  çözebilir (yalnızca yeni sürüm keser). Oluşturma anında K ve bütün paylar kasayı oluşturan bilgisayardadır. O
  bilgisayarlar ele geçirilmişse kasa korunmaz. t ya da daha fazla onaycı birleşirse kasayı açabilir.
- Silmeyi engelleyemez: `.kasa` dosyasının ve her payın (`.pay` + `.anahtar` + parola) yedeğini ayrı yerlerde tut;
  n−t+1 pay kaybolursa (3/5'te üçü) veri sonsuza dek gider. t = n seçilirse komut uyarır; t = 1 reddedilir.
- OneDrive gibi eşitlenen klasörlerde kasa ya da açılan dosya tutma: eski sürümler bulut geçmişinde kalır, yeni sürüm
  (rotasyon) eski kopyaları geçersiz kılmaz. Komut yol adında OneDrive, Dropbox, Google Drive ya da iCloud geçerse uyarır.
- Eşik-altı onaylar artık birleştirilemez (iki aşamalı onay): pay yalnızca aynı talebin t onayı gösterilince verilir.
  Kalan güvence "pay yalnızca t onaycının onayladığı bir talebe verilir" düzeyindedir. Koruma onaycının **kendi**
  `vera.exe`'sindedir: önceki (tek aşamalı) sürümü hâlâ kullanan bir onaycı payını tek onayla teslim eder; bütün
  onaycıların güncellemesi gerekir. İki aşama ayrıca iki tur demektir (onay, sonra pay serbest bırakma; ikisi de talebin
  süresi içinde).
- Bir sürüm geçişini (rotasyon) yetkilendirmek yeni içeriği de yetkilendirmektir: onaycı yeni verinin eskisiyle aynı
  olduğunu denetleyemez.
- `--tpm` anahtarları PIN/onay ilkesiyle oluşturulur; sağlayıcı ilkeyi reddederse `anahtar-üret` anahtarın sessizce
  kullanılabileceğini açıkça yazar.
- Onaycı listesinin (açık anahtarlar) özgünlüğü ve talep edenin kimliği dosyadan kanıtlanamaz; parmak izleri kanal dışı
  karşılaştırılır.

## Kurulum ve derleme (Windows)

Gereken tek şey **MSYS2 MinGW-w64 `g++`** (C++20 destekli). Üçüncü taraf kütüphane gerekmez; yalnızca standart C++
kütüphanesi ve Windows'un kendi kitaplıkları kullanılır: `bcrypt` (güvenli rastgele sayılar; `kasa` için AES-GCM,
ECDSA, ECDH, PBKDF2), `ncrypt` (`kasa --tpm`) ve `crypt32` (`kasa` talebinin gizli dosyası için DPAPI). Denenen sürüm:
MSYS2 `mingw-w64-x86_64-gcc` 16.2.0. Derlenmiş `vera.exe` depoda yoktur, aşağıdaki betiklerle üretilir.

```text
pacman -S mingw-w64-x86_64-gcc     # MSYS2 kabuğunda; g++ yoksa
derle.bat                          # Windows komut istemi
./derle.sh                         # MSYS2 / Git Bash (dosyaları paralel derler)
```

İki betik de önce `C:\msys64\mingw64\bin` içindeki `g++`'ı arar, yoksa `PATH`'tekini kullanır. Geliştirme makinesinde
`derle.sh` 12 ile 26 saniye arasında sürdü. İki betik de sertleştirme bayraklarıyla derler: `-fstack-protector-strong`,
`-D_FORTIFY_SOURCE=2`, `-D_GLIBCXX_ASSERTIONS`, bağlamada ASLR/DEP (`--dynamicbase`, `--nxcompat`, `--high-entropy-va`)
ve 64 MiB yığın. 64 MiB'lık bir dosyada şifreleme hızı bayraklı ve bayraksız derlemede aynı ölçüldü (yalnız KILIM ~405
MiB/sn, kademeli ~270 MiB/sn; fark ölçüm gürültüsünün içinde) ve `sure` sınaması bu bayraklarla da geçti. `derle` komutu ve 4. yol çalışırken de `g++` gerekir: assembly'yi V.E.R.A.
üretir, `g++` onu küçük bir C++ sürücüsüyle birlikte `.exe`'ye bağlar. `g++` bulunamazsa `sağla` 4. yolu atlar.
Linux ve macOS denenmemiştir.

## Komutlar

Kullanım: `vera <komut> <dosya.vera> [ad=değer …] [seçenekler]`. Girdiler `ad=değer` verilir (`0x…`, `0b…` ya da
onluk). Ayrıntı için `vera yardım <komut>`.

| Komut | Eş anlamlılar | Ne yapar |
|---|---|---|
| `yardım` | `yardim`, `help` | Komut listesini ya da bir komutun yardımını gösterir |
| `ağaç` | `agac`, `tree` | Sözcükleri ve sözdizimi ağacını gösterir (1. aşama) |
| `çalıştır` | `calistir`, `run` | Programı çalıştırır; `--yol 0-4` ile yol seçilir, `--ikili`, `--onluk` |
| `matematik` | `math` | GF(2) denklem sistemi ve kanıtlı yapısal uyarılar (2. aşama); `--tam` ile küçük programlarda tam ANF |
| `bitler` | `bits` | Kapı devresi (3. aşama); `--bitkodu DOSYA` yalnızca `0`/`1` karakterli bit kodunu, `--cnf DOSYA` SAT çözücüler için DIMACS CNF'yi kaydeder; `--ir` |
| `sağla` | `sagla`, `check` | Bütün yolları karşılaştırır; `--sayi N`, `--tohum N`, `--asm-yok` |
| `sına` | `sina`, `test` | Dosyadaki `sına` satırlarını bütün yollardan dener |
| `derle` | `compile` | x86-64 assembly (`.s`) ve `.exe` üretir (4. aşama); `--cikti AD`, `--sadece-s` |
| `analiz` | `analyze` | Şifre ölçümleri: S-kutusu (DU, LAT, derece), yayılım, SAC, doğrusallık, küp toplamları, tur taraması; `--hizli`, `--tur-tara`, `--suresiz` |
| `kır` | `kir`, `break` | SAT çözücüyle anahtar bulma (azaltılmış turlarda); `--bilinen B`, `--cift N`, `--sure SN`, `--tur-tara a..b`, `--cnf DOSYA` |
| `şifrele` | `sifrele`, `encrypt` | Dosyayı AES-256-GCM + KILIM-256-GCM ile kademeli şifreler (DENEYSEL; Argon2id, STREAM); `--yalniz-kilim`, `--bellek`, `--gecis`, `--parola-dosyasi`, `--parola-stdin`, `--anahtar-dosyasi`; program verilirse VERA1 program kipi (CTR + HMAC-SHA256) |
| `çöz` | `coz`, `decrypt` | `şifrele` ile şifrelenmiş dosyayı önce doğrular, sonra çözer (DENEYSEL) |
| `kasa` | `vault` | Onaylı kasa: veri ancak t farklı onaycının onayıyla açılır; alt komutlar `anahtar-üret`, `oluştur`, `talep`, `onayla`, `topla`, `pay-ver`, `aç`, `yetkilendir`, `bilgi`, `doğrula`, `günlük` ([özet](#onaylı-kasa-kasa), [rehber](KASA.md)) |
| `sistem` | `system` | Bütün KILIM sistemini geçici bir klasörde baştan sona çalıştırır ve her adımı ✓/✗ ve süresiyle yazar: resmî vektörler, dört yol sağlaması, çığ etkisi, S-kutusu ölçümü, VERA2 dosya şifreleme (kurcalama ve yanlış parola reddi), onaylı kasa gösterimi (5 onaycı, eşik 3), hız; `--json`, `--kok KLASÖR`, `--asm-yok`. Studio'daki KILIM Sistemi paneli bunu kullanır. Tutarlılığı gösterir, güvenliği kanıtlamaz |

Ortak seçenekler: `-D AD=DEĞER` (bir `sabit`'i değiştirir), `--tohum N`, `--en-fazla N`.

**Ölçüm ve saldırı komutlarının sınırları.** Ayrıntı ve gerçek çıktı örnekleri
[ayrı bölümdedir](#şifreyi-ölçmek-kırmayı-denemek-ve-dosya-şifrelemek). `analiz` yalnızca belirli zayıflıkları arar
ve her bölümde neyi kaç örnekle ölçtüğünü, neyi kanıtlamadığını yazar; hiçbir sonucu "güvenli" diye bildirmez. `kır`
bir laboratuvar deneyidir: kıramamak (ZAMAN AŞIMI) yalnızca o ayarlarla o sürede bulunamadığını gösterir; eşdeğerliği
kanıtlanamayan anahtar "EŞDEĞER GÖRÜNÜYOR (kanıtsız)" diye bildirilir ve kırma sayılmaz (çıkış kodu 2). `şifrele` /
`çöz` DENEYSELDİR: blok şifre bağımsız olarak incelenmemiş bir V.E.R.A. programıdır; gerçek sırlar için AES-GCM, age
ya da VeraCrypt kullanın. Dosya biçimi ve bayt sırası `src/filecrypt.hpp` içinde tanımlıdır.

## Sınamalar

Betikler Bash gerektirir (MSYS2 ya da Git Bash):

```bash
testler/hepsini_calistir.sh               # bütün modül sınamalarını derler ve çalıştırır (isteğe bağlı: modül adları)
testler/uctan_uca.sh                      # vera.exe'yi derler, bütün komutları gerçek .vera dosyalarıyla dener
testler/uctan_uca.sh --derleme-yok        # derlemeden, mevcut vera.exe ile
testler/bulanik/calistir.sh [--uzun]      # hata avı araçları: SAT/GF(2)/kır, rastgele ve bozuk programlar, kasa ve VERA1 biçimleri
testler/kilim_dogrula.sh                  # KILIM yazımını tasarım belgesi ve referans.js ile karşılaştırır (Node gerekir)
node testler/studio_test.js               # Studio sunucusu: uç noktalar, çalışma alanı, şifrele/çöz, güvenlik retleri (Node gerekir)
node testler/vscode_test.js               # VS Code eklentisi: dilbilgisi, ayrıştırıcılar, dil sağlayıcıları, vera.exe ile çalıştırma
```

CI (`.github/workflows/ci.yml`) aynı betikleri `KILIM_SAYI=40` ve `VERA_SURE_SINAMASI=uyar` ile çalıştırır: paylaşılan
makinede `kilim_cekirdek` ve `sure` modüllerinin süre sınaması eşik aşımında sınamayı düşürmez, yalnızca uyarır (yerelde katıdır;
bilerek sızdıran denetim satırı her iki kipte de yakalanmalıdır). TPM sınaması orada da "atlandı" yazar.

`wycheproof` modülü kendi GCM'imizi, CNG'nin ECDSA doğrulamasını ve ECDH'sini (açık anahtar denetimleriyle), HMAC ve
HKDF'yi Project Wycheproof vektörleriyle sınar (`testler/veri/wycheproof/`, Apache-2.0); geçersiz hiçbir vektör kabul
edilmez, geçerli hiçbiri reddedilmez, desteklenmeyenler (sıkıştırılmış nokta) nedeniyle sayılarak atlanır. Hata avı
araçları, sonuçları ve UBSan tuzaklı "sertleştirilmiş" derleme kipi `testler/bulanik/OKU-BENI.md` içindedir.

Uçtan uca denetimler: bütün örneklerde `sına` ve `sağla`, resmî vektörler, `--hata-ekle` ile uyuşmazlığın
yakalanması, hata iletileri, `analiz` (present80, dogrusal4), `kır` (oyuncak4, azaltılmış turlu speck32, tur
taraması, zaman aşımı, kanıtsız eşdeğerlik), `şifrele` / `çöz` gidiş-dönüşü (VERA2 varsayılan kademeli, `--yalniz-kilim` ve VERA1; parolayla ve ham anahtarla),
kurcalanmış, parça sınırında kesilmiş, uzatılmış ya da başka sabitle şifrelenmiş dosyanın reddi, eski VERA1 ve yalnız
KILIM VERA2 dosyalarının çözülmesi, yol 0 ile yol 1'in aynı programları kabul etmesi, Türkçe
harfli yollar, rastgele üretilmiş 30 program, `kasa` (iki aşamalı 3/5 akış, onay dosyasında pay olmaması, 2 onayla
demet ve 2 serbest bırakmayla açma reddi, aynı onaycı ve (r, n−s) ikizi tek sayılır, onaylamamış onaycının pay
vermemesi, serbest bırakma yinelemesi, eşik-altı onayları birleştirme saldırısının (bir talebe 2 + ötekine 1 onay,
elle yapılmış demetler dahil) başarısız olması, bozulmuş şifreli veri / manifest / talep / onay / serbest bırakma,
tekrar oynatma, geri alma (yeni sürümü yalnızca yetkilendirmiş onaycıda da; 2. aşama dahil), çıktı yazılamayınca açan
sayacının harcanmaması, sürüm yetkisi ve yeni içerik uyarısı, denetim günlüğü, süresi geçmiş talebin `.gizli`
dosyasının silinmesi, onaycı anahtarı değiştirilmiş kasaya `doğrula`nın "doğrulandı" dememesi) ve sonda KILIM doğrulama paketi (`kilim_dogrula.sh`; Node.js gerekir,
Node yoksa bu denetim kalır). `kır` ve `şifrele` modül sınamalarının komut satırı bölümleri proje
klasöründeki `vera.exe`'yi kullanır; önce `derle.sh` çalıştırın. İki betik de `_derleme/` altındaki ortak geçici
dosyaları kullanır: aynı anda birden fazla kez çalıştırmayın (sonuçlar birbirini bozar).

Sınama sayıları her değişiklikte değiştiği için burada yazılmaz; doğru sayılar betiklerin son satırında ve CI özetindedir
(`sinama-ozeti.md`). Betiklerin son satırları şu biçimdedir:

```text
MODÜL SINAMALARI: N/N geçti
UÇTAN UCA: N/N geçti
UÇTAN UCA: N/N geçti, K atlandı (geçti sayılmadı):   ← ör. Electron kurulu değilse eklenti saldırı sınamaları
```

İşi yapmadan geçen bir denetim (ör. Electron kurulu olmadığı için atlanan eklenti saldırı sınamaları) "geçti" sayılmaz,
özette "atlandı" olarak ayrıca gösterilir. Windows 11 ve MSYS2 g++ 16.2.0'da modül sınamaları derleme dahil 4-5 dakika,
uçtan uca `--derleme-yok` ile 5-6 dakika sürer (bunun yaklaşık bir dakikası bulanıklaştırma kısa koşusu).

## Dürüstlük notu

- V.E.R.A. **özel amaçlı** bir dildir: bit düzeyinde, şifreyle ilgili çalışma içindir. Genel amaçlı bir programlama
  dili değildir.
- Projenin iddiası şudur: *şifre tasarlarken zayıflıklarını ölçen bir dil.* Hiçbir şifrenin kırılamaz olduğunu
  iddia etmez; "yapısal uyarı yok" yalnızca aracın kanıtlayabildiği zayıflıkların bulunmadığı demektir.
- Bu dille tasarlanan şifreler **deneyseldir**, bağımsız kriptanalizden geçmemiştir. Üretilen kodun yan kanal
  (zamanlama vb.) güvenliği hakkında bir iddia yoktur. Gerçek sırlar için denetlenmiş standartları ve olgun
  kütüphaneleri kullanın (AES-GCM, ChaCha20-Poly1305).
- `analiz` belirli sınamaların, belirli örnek sayılarıyla bir zayıflık yakalayıp yakalamadığını söyler; `kır` azaltılmış
  turlarda, çoğu zaman bazı anahtar bitleri saldırgana açıkken, tek bir çözücü ve sınırlı süreyle yapılmış bir
  deneydir. İkisi de güvenlik kanıtı ya da kesin bir güvenlik payı vermez; bir sınamadan geçmek ya da bir saldırıdan
  kurtulmak yalnızca "bu ayarlarla bulunamadı" demektir. `şifrele` / `çöz` DENEYSELDİR ve gerçek sırlar için
  kullanılmamalıdır.
- Depodaki PRESENT-80 ve SPECK32/64 dilin doğruluğunu göstermek içindir, üretimde kullanılmak için değildir.
  Sürüm 0.1 olduğundan komutlar, seçenekler ve dil ayrıntıları değişebilir.
- `kasa` veriyi denetlenmiş yapı taşlarıyla (Windows CNG: AES-256-GCM, ECDSA/ECDH P-256) korur, ama **onay protokolü
  bu projeye özgü ve yenidir, bağımsız olarak incelenmemiştir**. Açılış anında anahtar ve paylar açan bilgisayarın
  belleğindedir; sınırların tamamı [KASA.md'de](KASA.md#9-dürüst-sınırlar).
- KILIM (`sifreler/kilim/`) bu proje için tasarlanmış **deneysel** bir şifredir: güvenli olduğu iddia edilmez, bağımsız
  bir kriptanalizden geçmemiştir ve ölçümleri "gerekli ama yeterli değil" türündendir. Gerçek sırlar için kullanılmaz.

## Proje yapısı

```text
vera/
├── DIL.md            dil başvuru kılavuzu
├── KASA.md           onaylı kasa rehberi (gerçek çıktılar, tehdit modeli, sınırlar)
├── SECURITY.md, TEHDIT-MODELI.md, YAPAY-ZEKA-BEYANI.md, THIRD_PARTY_NOTICES.md
│                     güvenlik politikası, tehdit modeli, yapay zekâ beyanı, üçüncü taraf bileşenler
├── .github/workflows/ ci.yml: Windows CI (elle ya da v* etiketiyle)
├── derle.bat         Windows komut istemi için derleme betiği
├── derle.sh          MSYS2 / Git Bash için derleme betiği
├── src/              C++20 kaynak kodu: parser, elab (açma), ir, interp (1. yol), gf2 (2. yol),
│                     circuit (3. yol), asmgen (4. yol), sat (CDCL çözücü), crypto (SHA-256, HMAC, HKDF, PBKDF2),
│                     analysis (analiz), attack (kır), filecrypt (şifrele / çöz), kasa (onaylı kasa: biçimler,
│                     Shamir, protokol), cng (Windows CNG sarmalayıcıları), komut_*.cpp (komut satırı)
├── studio/           V.E.R.A. Studio: tarayıcıda çalışan geliştirme ortamı (sunucu.js, index.html, app.js, style.css,
│                     baslat.bat, OKU-BENI.md)
├── vscode-vera/      VS Code eklentisi: dilbilgisi, kod parçacıkları, extension.js + lib/, Aşamalar paneli (media/),
│                     kur.ps1 (kurulum), README.md
├── calisma/          Studio'nun çalışma alanı (sizin .vera dosyalarınız; depoda tutulmaz)
├── testler/          modül sınamaları (*_test.cpp), hepsini_calistir.sh, uctan_uca.sh, kilim_dogrula.sh, bulanik/ (hata avı)
│                     (KILIM doğrulama paketi), studio_test.js (Studio sunucusu), vscode_test.js (VS Code eklentisi),
│                     veri/ (sınama programları, kilim_surucu.js, wycheproof/)
├── ornekler/         oyuncak4, dogrusal4, kaybolan_anahtar, ozellikler, present80, speck32
│                     (hatalar/ altında bilerek hatalı 10 program)
├── sifreler/
│   └── kilim/        KILIM v1: sekiz .vera programı (kilim_tek.vera dahil), KILIM.md (öğrenci rehberi), OKU-BENI.md, OLCUM-RAPORU.md
└── tasarim/          SIFRE-TASARIM.md (KILIM v1 tanımı), referans.js (bağımsız Node başvuru gerçeklemesi)
```

`_derleme/` (derleme çıktıları ve ham ölçüm dosyaları) `.gitignore` içindedir; depoda bulunmaz, betikler tarafından üretilir.


