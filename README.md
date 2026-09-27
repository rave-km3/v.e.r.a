# v.e.r.a

Depolamayı yazılımla RAM gibi kullanmanın sınırlarını araştıran ve bu sınırlar içinde yeni bir şey yapan proje.

- **[ARASTIRMA.md](ARASTIRMA.md)**: Fizibilite raporu (Türkçe). Depolama yazılımla RAM'e dönüştürülebilir mi?
  Kısa cevap, fiziksel sınırlar, mevcut ürünler, akademik çalışmalar ve ölçümler.
- **[webswap/](webswap/)**: **v.e.r.a WebSwap**. WebAssembly'ye derlenen C programlarına gerçek wasm
  belleklerinden çok daha büyük bir bellek veren sayfalama katmanı (program WebSwap ile yeniden derlenir). Sığmayan
  sayfalar tarayıcıda siteye özel diske (OPFS), Node/Bun'da bir dosyaya taşınır. Aynı `.wasm` dosyası tarayıcısı olan her cihaz için tasarlandı. Şimdilik Linux'ta Node, Bun
  ve Chromium ile test edildi. Neden bu fikrin seçildiği: [webswap/docs/FIKIR-ARASTIRMASI.md](webswap/docs/FIKIR-ARASTIRMASI.md).
- **[bench/](bench/)**: RAM ile depolama arasındaki farkı ölçen C programları.

Kısaca: Depolamayı sanal belleğin *uzantısı* olarak kullanmak mümkün ve zaten her işletim sisteminde var.
Depolamanın gerçekten RAM'e *dönüşmesi*, yani RAM hızında çalışması, yazılımla mümkün değil. WebSwap RAM eklemez
ve hızlandırmaz. Belleğe sığmadığı için çökecek işin daha yavaş da olsa bitmesini sağlar ve bunun bedelini açıkça
gösterir. Bunu, wasm programlarına swap sunmayan tarayıcılar ve telefonlar için hedefliyor.
