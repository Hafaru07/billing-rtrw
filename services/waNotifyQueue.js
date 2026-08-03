/**
 * ANTREAN NOTIFIKASI WHATSAPP
 * ---------------------------------------------------------------------------
 * Beberapa aksi admin memicu banyak pesan WhatsApp sekaligus — misalnya
 * "Bayar Massal" yang melunasi puluhan tagihan dalam sekali klik.
 *
 * Mengirim beruntun tanpa jeda adalah pola yang paling mudah dikenali sebagai
 * spam oleh Meta, dan berisiko membuat akun WhatsApp diblokir.
 *
 * Modul ini menampung pesan-pesan itu lalu mengirimnya SATU PER SATU dengan
 * jeda acak 30-90 detik. Karena berjalan di latar belakang, admin tidak perlu
 * menunggu — halaman langsung merespons setelah tagihan tersimpan.
 *
 * Catatan: antrean disimpan di memori. Bila aplikasi di-restart saat antrean
 * belum habis, sisanya batal terkirim. Ini disengaja — notifikasi "pembayaran
 * berhasil" tidak sepenting data pembayarannya sendiri, yang sudah tersimpan
 * di database sebelum antrean dimulai.
 */
const { logger } = require('../config/logger');

/** Rentang jeda antar pesan (milidetik). */
const MIN_DELAY_MS = 30 * 1000;
const MAX_DELAY_MS = 90 * 1000;

const queue = [];
let running = false;

/** Jeda acak merata 30-90 detik — pola tak beraturan, tidak seperti mesin. */
function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Proses antrean sampai habis.
 *
 * Jeda diberikan DI ANTARA pesan, bukan sebelum pesan pertama, supaya
 * notifikasi untuk satu pelanggan tetap terasa seketika.
 */
async function drain() {
  running = true;
  let sent = 0;
  let failed = 0;

  while (queue.length > 0) {
    const task = queue.shift();
    try {
      await task.fn();
      sent++;
    } catch (e) {
      failed++;
      logger.error(`[WA-Antrean] Gagal kirim "${task.label}": ${e.message}`);
    }

    if (queue.length > 0) {
      const d = randomDelay();
      logger.info(`[WA-Antrean] Sisa ${queue.length} pesan. Jeda ${Math.round(d / 1000)} detik...`);
      await sleep(d);
    }
  }

  running = false;
  logger.info(`[WA-Antrean] Selesai: ${sent} terkirim, ${failed} gagal.`);
}

/**
 * Masukkan satu pengiriman ke antrean.
 *
 * @param {string} label keterangan singkat untuk log
 * @param {() => Promise<any>} fn fungsi yang benar-benar mengirim pesan
 */
function enqueue(label, fn) {
  if (typeof fn !== 'function') return;
  queue.push({ label: String(label || 'pesan'), fn });

  // Jalankan pemroses bila belum berjalan. Sengaja TIDAK di-await supaya
  // pemanggil (route HTTP) bisa langsung membalas ke admin.
  if (!running) {
    drain().catch(e => {
      running = false;
      logger.error(`[WA-Antrean] Pemroses berhenti tak terduga: ${e.message}`);
    });
  }
}

/** Masukkan banyak sekaligus. */
function enqueueAll(tasks) {
  for (const t of (Array.isArray(tasks) ? tasks : [])) enqueue(t.label, t.fn);
}

/** Jumlah pesan yang masih menunggu. */
function pendingCount() {
  return queue.length;
}

/**
 * Perkiraan waktu habisnya antrean, dalam menit.
 * Memakai rata-rata jeda (60 detik) dikali jumlah antrean.
 */
function estimateMinutes(count) {
  const n = Number(count) || queue.length;
  if (n <= 1) return 0;
  const avg = (MIN_DELAY_MS + MAX_DELAY_MS) / 2;
  return Math.ceil(((n - 1) * avg) / 60000);
}

module.exports = {
  enqueue,
  enqueueAll,
  pendingCount,
  estimateMinutes,
  MIN_DELAY_MS,
  MAX_DELAY_MS
};
