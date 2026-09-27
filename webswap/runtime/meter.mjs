// meter.mjs - an honest, human-readable summary of what paging cost.
// Turkish and English. Never claims speed: the point is "finished instead of
// crashed", and the meter says how much slower that was when it knows.

const MB = 2 ** 20;
const fmt = (lang) => (x) => (Math.round(x * 10) / 10).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US');

function histPercentile(hist, q) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= q * total) return i === 0 ? 1 : 2 ** i; // upper edge of the log2 bucket, in us
  }
  return 2 ** (hist.length - 1);
}

export function meter(s, curve, lang = 'tr', { wallMs = null, baselineMs = null } = {}) {
  const tr = lang === 'tr';
  const f1 = fmt(lang);
  // Compression ratio of the codec, and of the tier's blocks (entry header
  // and rounding to 128 bytes included): the second is what fits.
  const ratio = (st) => (st.tierOutBytes ? f1(st.tierInBytes / st.tierOutBytes) : '—');
  const blockRatio = (st) => (st.tierBlockBytes ? f1(st.tierInBytes / st.tierBlockBytes) : '—');
  const lines = [];
  const pool = s.poolBytes / MB;
  const mem = s.memoryBytes / MB;
  const readMB = s.readBytes / MB;
  const writeMB = s.writeBytes / MB;
  const budget = s.writeBudgetBytes;
  const budgetPct = budget ? (100 * s.budgetUsedBytes) / budget : 0;
  const daily = s.budgetScope === 'day'; // a budget store keeps it across runs
  const over = budgetPct > 100;
  const coarse = s.timerResolutionUs !== undefined && s.timerResolutionUs > 5;
  const p50 = coarse ? null : histPercentile(s.hist, 0.5);
  const p99 = coarse ? null : histPercentile(s.hist, 0.99);

  if (tr) {
    lines.push(`Depolama: ${s.backend}. Sayfa havuzu: ${f1(pool)} MiB (gerçek wasm belleği: ${f1(mem)} MiB).`);
    if (s.backend === 'file') lines.push('(Dosya depolaması: işletim sisteminin dosya önbelleği okumaları hızlandırmış olabilir; soğuk disk daha yavaştır.)');
    lines.push(`Sayfa hataları: ${s.majorRead} diskten okuma, ${s.zeroFill} boş (sıfır) sayfa, ${s.minor} ucuz yeniden eşleme (G/Ç yok).`);
    const bt = daily ? 'son 24 saatin yazma bütçesi' : 'bu çalıştırmanın yazma bütçesi';
    lines.push(`Diskten okunan: ${f1(readMB)} MiB (${s.readaheadPages} sayfa önden okundu). Diske yazılan: ${f1(writeMB)} MiB (${bt}: %${f1(budgetPct)}${over ? ', bütçe aşıldı' : ''}).`);
    if (s.compressBytes) {
      lines.push(`Sıkıştırılmış katman: ${f1(s.compressBytes / MB)} MiB JS belleği (wasm belleğine ek), şu an ${s.tierPages} sayfa. ${s.tierHits} sayfa hatası diske gitmeden buradan karşılandı; ${s.tierStores} sayfa girdi (sıkıştırma ${ratio(s)}:1, blok payıyla ${blockRatio(s)}:1), ${s.tierRejects} sayfa yeterince sıkışmadığı için katmanı atladı. Katmandan diske ${s.tierSpills + s.tierFlushes} sayfa yazıldı, ${s.tierDrops} temiz sayfa yazılmadan atıldı (diske yazılanlar yukarıdaki toplamın içinde).`);
    }
    if (p50 !== null) lines.push(`Diske giden bir sayfa hatası: ortanca ≤${p50} µs, en yavaş %1 hariç ≤${p99} µs (RAM erişimi ~0,1 µs).`);
    if (coarse) lines.push(`(Bu ortamın zamanlayıcısı kaba, ~${f1(s.timerResolutionUs)} µs: tek tek sayfa hatası süreleri ölçülemedi.)`);
    if (wallMs !== null && !coarse) lines.push(`Toplam süre: ${f1(wallMs)} ms. Sayfa hatalarında geçen pay: ~%${f1((100 * s.faultTimeMs) / wallMs)}.`);
    else if (wallMs !== null) lines.push(`Toplam süre: ${f1(wallMs)} ms.`);
    if (baselineMs !== null && wallMs !== null) lines.push(`Aynı iş tamamen RAM'de ${f1(baselineMs)} ms sürdü: bu çalışma ${f1(wallMs / baselineMs)} kat yavaş.`);
    if (curve && curve.predicted) {
      const p = curve.predicted.map((x) => `${x.poolMultiplier} kat havuzla ~${x.storageReads}`).join(', ');
      lines.push(`Tahmin (yaklaşık): diskten sayfa okuma sayısı şu an ${curve.measuredStorageReads}; ${p}.`);
    }
    lines.push('Not: Bu araç RAM eklemez, hiçbir şeyi hızlandırmaz. Belleğe sığmayan işin çökmeden, daha yavaş da olsa bitmesini sağlar.');
  } else {
    lines.push(`Storage: ${s.backend}. Page pool: ${f1(pool)} MiB (real wasm memory: ${f1(mem)} MiB).`);
    if (s.backend === 'file') lines.push('(File storage: the OS file cache may have sped up reads; a cold disk is slower.)');
    lines.push(`Page faults: ${s.majorRead} read from storage, ${s.zeroFill} zero pages, ${s.minor} cheap remaps (no I/O).`);
    const bt = daily ? 'the last 24 hours\' write budget' : 'this run\'s write budget';
    lines.push(`Read: ${f1(readMB)} MiB (${s.readaheadPages} pages read ahead). Written: ${f1(writeMB)} MiB, ${f1(budgetPct)}% of ${bt}${over ? ' (over budget)' : ''}.`);
    if (s.compressBytes) {
      lines.push(`Compressed tier: ${f1(s.compressBytes / MB)} MiB of JS memory (besides the wasm memory), ${s.tierPages} pages in it now. ${s.tierHits} faults were served from it without storage I/O; ${s.tierStores} pages went in (compressed ${ratio(s)}:1, ${blockRatio(s)}:1 in its blocks), ${s.tierRejects} did not compress enough and bypassed it. ${s.tierSpills + s.tierFlushes} of its pages were written to storage (counted in Written above), ${s.tierDrops} clean ones dropped without a write.`);
    }
    if (p50 !== null) lines.push(`A fault that went to storage: median ≤${p50} µs, p99 ≤${p99} µs (a RAM access is ~0.1 µs).`);
    if (coarse) lines.push(`(This environment's timer is coarse, ~${f1(s.timerResolutionUs)} µs: per-fault times could not be measured.)`);
    if (wallMs !== null && !coarse) lines.push(`Total ${f1(wallMs)} ms; ~${f1((100 * s.faultTimeMs) / wallMs)}% of it was spent in page faults.`);
    else if (wallMs !== null) lines.push(`Total ${f1(wallMs)} ms.`);
    if (baselineMs !== null && wallMs !== null) lines.push(`The same job fully in RAM took ${f1(baselineMs)} ms: this run was ${f1(wallMs / baselineMs)}x slower.`);
    if (curve && curve.predicted) {
      const p = curve.predicted.map((x) => `~${x.storageReads} with a ${x.poolMultiplier}x pool`).join(', ');
      lines.push(`Estimate (approximate): page reads from storage now ${curve.measuredStorageReads}; ${p}.`);
    }
    lines.push('Note: this adds no RAM and makes nothing faster. It lets work that does not fit in memory finish, slower, instead of crashing.');
  }
  return lines.join('\n');
}
