# v.e.r.a

Depolamayı yazılımla RAM'e dönüştürmenin ("sanal RAM") mümkün olup olmadığını inceleyen
araştırma deposu.

- **[ARASTIRMA.md](ARASTIRMA.md)**: Fizibilite raporu (Türkçe). Kısa cevap, fiziksel sınırlar,
  mevcut ürünler, akademik çalışmalar, ölçümler ve gerçekçi bir yol haritası.
- **[bench/](bench/)**: RAM ile depolama arasındaki farkı ölçen küçük C programları (RAM
  gecikmesi ve bant genişliği, O_DIRECT disk erişimi, mmap sayfa hataları, swap testi).

Kısaca: Depolamayı sanal belleğin *uzantısı* olarak kullanmak mümkün ve zaten her işletim
sisteminde var. Depolamanın gerçekten RAM'e *dönüşmesi*, yani RAM hızında çalışması yazılımla
mümkün değil. Ayrıntılar ve v.e.r.a için önerilen yönler raporda.
