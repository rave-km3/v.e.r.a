# Hangi fikir, neden? (Özgünlük araştırması, Eylül 2026)

İstek: "Daha önce yapılmamış bir şey olsun ve bütün cihazlarda çalışsın."

"Hiç yapılmamış" iddiası kesin olarak kanıtlanamaz. Yapabildiğimiz, her adayın ciddi biçimde aranmasıydı:
ürünler, GitHub, akademik makaleler (USENIX, ACM, arXiv) ve patentler. Her aday için ayrı bir araştırmacı
"bu zaten var" varsayımıyla başladı ve bunu kanıtlamaya çalıştı. Sonuçlar aşağıda.

## Adaylar ve sonuçlar

| # | Aday | Özgünlük sonucu | En yakın öncüller | Karar |
|---|---|---|---|---|
| C1 | **WebSwap**: WebAssembly programları için tarayıcının diskine (OPFS) sayfalanan sanal bellek | Kısmen özgün | nix-wasm (2026, yazılım MMU'su var, swap yok), WAVEN (NDSS 2025, SGX içinde, depolama yok), ViMem (2007, sensör düğümlerinde flaşa sayfalama), TrackFM (ASPLOS 2024), Photoshop web (uygulamaya özel OPFS sayfalama) | **Seçildi** |
| C3 | Resume + Teleport: tarayıcıda kapatılan uygulamanın kaldığı yerden devam etmesi | Kısmen özgün (yalnızca "Resume" kısmı) | Weave (2026, tarayıcılar arası wasm göçü), wasm-persist (2018), vpod (2026), MVVM (2024) | İkinci sıra; ileride WebSwap'a eklenebilir |
| C5 | Truth Test: kurulumsuz "gerçek bellek" etiketi | Zayıf özgünlük | iOSMemoryBudgetTest (2012), Crash Reporting API, JavaScript'ten swap zamanlaması (2023) | Sayaç fikri WebSwap'a alındı |
| C6 | Native uygulamalar için ölümsüz bellek SDK'sı | Kısmen özgün (yalnızca bütünleştirme) | SSDAlloc (NSDI 2011) ve patenti, LLNL UMap, RVM (1993), MMKV/LMDB, düz `mmap` | Elendi: işletim sistemi zaten yapıyor |
| C4 | Recall: yapay zekâ KV önbelleğini diskte tutma | Büyük ölçüde var | llama.cpp PR #28092, oMLX, Google ML Kit prefix caching, Rullama, bitgpu | Elendi |
| C2 | Kahin: programın bir kopyasını önden koşturup sayfa hatalarını paralel okuma | Büyük ölçüde var | Fraser & Chang, USENIX ATC **2003** (aynı fikir), NVIDIA patenti US 8,035,648, SpecHint (1999) | Elendi |

Baştan elenenler: SSD aşınma yöneticisi (Meta Senpai/TMO, zram `writeback_limit` zaten var),
cihazlar arası RAM ödünç alma (Wi-Fi gecikmesi SSD'den yavaş; Nswap, Infiniswap gibi çok sayıda öncül var).

## Neden WebSwap?

- **Bütün cihazlar:** Her işletim sisteminin ortak çalışma ortamı tarayıcı. Aynı `.wasm` dosyası Windows, macOS,
  Linux, Android ve iPhone/iPad tarayıcılarında çalışacak şekilde tasarlandı. iPhone'da uygulamalar için swap yok,
  bu yüzden en büyük fayda orada beklenebilir. **Ama iPhone'da ve Safari'de henüz denenmedi.**
- **Fiziğe dürüst:** RAM eklemez, hızlandırmaz. "Bellek yetmedi, sekme çöktü" durumunu "daha yavaş ama bitti"
  durumuna çevirir ve bunun bedelini açıkça ölçer.
- **Özgünlük, dürüst ifadesiyle:** Aramamızda, herhangi bir C programını yeniden derleyerek tarayıcıda OPFS'e
  sayfalanan genel, hazır bir sanal bellek katmanı bulamadık. **Mekanizma yeni değil** (yazılımla sayfa tablosu
  ve flaşa sayfalama 2006-2007'den beri biliniyor). Yeni olan, bunun her tarayıcıda çalışan genel bir paket
  hâline getirilmesi.

## Kullanılmaması gereken ifadeler

"Daha önce hiç yapılmadı", "depolamayı RAM'e çevirir", "RAM ekler", "uygulamaları hızlandırır",
"iPhone'da çalışır" (cihazda denenene kadar), "her programla çalışır".

Doğru ifade: *"Eylül 2026'daki aramamızda, WebAssembly doğrusal belleği için tarayıcıda çalışan, genel ve hazır
bir talep üzerine sayfalama katmanı bulamadık. Mekanizma bilinen bir teknik; katkımız bunu genel bir paket
hâline getirmek."*
