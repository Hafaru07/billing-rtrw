/**
 * NOTIFIKASI WHATSAPP "PEMBAYARAN BERHASIL"
 * ---------------------------------------------------------------------------
 * Tagihan bisa dilunasi dari banyak pintu: admin, kasir, approval kolektor,
 * auto-approve kolektor di lapangan, dan agen. Semuanya harus mengirim pesan
 * yang sama, dari template yang sama, dengan penjagaan yang sama — kalau
 * tidak, pelanggan menerima bentuk pesan berbeda tergantung siapa yang
 * kebetulan menerima uangnya.
 *
 * SETIAP jalur keluar mencatat alasannya ke log dan mengembalikannya ke
 * pemanggil. Versi sebelumnya hanya mengembalikan `false` tanpa keterangan,
 * sehingga "kok tidak terkirim?" tidak bisa dijawab tanpa membongkar kode —
 * padahal penyebabnya biasanya sepele: WhatsApp belum tersambung, fitur
 * sedang dimatikan, atau nomor pelanggan kosong.
 */
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');

const DEFAULT_SUCCESS_TEMPLATE =
  `Yth. Pelanggan {{nama}},\n\n` +
  `*PEMBAYARAN BERHASIL (LUNAS)*\n\n` +
  `📅 *Periode:* {{periode}}\n` +
  `💰 *Total Bayar:* Rp {{total}}\n` +
  `💳 *Metode:* {{metode}}\n\n` +
  `Layanan internet Anda aktif. Terima kasih atas kerja samanya.`;

/** Keterangan siap-tampil untuk tiap alasan gagal. */
const ALASAN = {
  ok:          'Terkirim',
  wa_disabled: 'fitur WhatsApp dimatikan di Pengaturan',
  no_phone:    'nomor HP pelanggan kosong',
  no_text:     'isi pesan kosong',
  wa_offline:  'bot WhatsApp belum tersambung',
  send_failed: 'WhatsApp menolak mengirim (nomor tidak terdaftar?)',
  error:       'terjadi kesalahan teknis'
};

/** Ubah kode alasan menjadi kalimat untuk ditampilkan ke petugas. */
function alasanText(reason) {
  return ALASAN[reason] || String(reason || 'sebab tidak diketahui');
}

/**
 * Kirim satu pesan WhatsApp ke pelanggan.
 *
 * Tidak pernah melempar: pembayarannya sendiri sudah tersimpan di database,
 * dan notifikasi yang gagal tidak boleh membatalkan transaksi yang sah.
 *
 * @param {string} customerPhone
 * @param {string} message
 * @param {string} [konteks] keterangan untuk log, mis. 'kolektor auto-approve'
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
async function trySendWhatsappPayment(customerPhone, message, konteks = 'pembayaran') {
  const to = String(customerPhone || '').trim();
  const text = String(message || '').trim();
  const jejak = `[WA-Bayar/${konteks}]`;

  try {
    if (!getSetting('whatsapp_enabled', false)) {
      logger.warn(`${jejak} Tidak dikirim: whatsapp_enabled = false di settings.json.`);
      return { ok: false, reason: 'wa_disabled' };
    }
    if (!to) {
      logger.warn(`${jejak} Tidak dikirim: nomor HP pelanggan kosong.`);
      return { ok: false, reason: 'no_phone' };
    }
    if (!text) {
      logger.warn(`${jejak} Tidak dikirim: isi pesan kosong.`);
      return { ok: false, reason: 'no_text' };
    }

    // whatsappBot.mjs adalah ES module — HARUS lewat import() dinamis.
    // `require()` padanya melempar ERR_REQUIRE_ESM.
    const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');

    const koneksi = whatsappStatus && whatsappStatus.connection;
    if (koneksi !== 'open') {
      logger.warn(`${jejak} Tidak dikirim ke ${to}: bot WhatsApp berstatus "${koneksi || 'tidak diketahui'}", ` +
                  `bukan "open". Scan ulang di menu Admin > WhatsApp.`);
      return { ok: false, reason: 'wa_offline' };
    }

    const terkirim = await sendWA(to, text);
    if (!terkirim) {
      logger.warn(`${jejak} sendWA() mengembalikan false untuk ${to}.`);
      return { ok: false, reason: 'send_failed' };
    }

    logger.info(`${jejak} Notifikasi terkirim ke ${to}.`);
    return { ok: true, reason: 'ok' };
  } catch (e) {
    logger.error(`${jejak} Gagal kirim ke ${to}: ${e.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Kirim notifikasi "pembayaran berhasil" memakai template dari panel admin.
 *
 * @param {string} customerPhone
 * @param {string} customerName
 * @param {string} periodText  mis. 'September 2026'
 * @param {string} amountText  nominal terformat, mis. '100.000'
 * @param {string} paidBy      mis. 'Kolektor Anas (@anas)'
 * @param {string} [konteks]   keterangan untuk log
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
async function sendPaymentSuccessWA(customerPhone, customerName, periodText, amountText, paidBy, konteks = 'pembayaran') {
  try {
    const template = db.getAppSetting('whatsapp_payment_success_message', DEFAULT_SUCCESS_TEMPLATE)
                     || DEFAULT_SUCCESS_TEMPLATE;

    const pesan = String(template)
      .replace(/{{\s*nama\s*}}/gi, customerName || 'Pelanggan')
      .replace(/{{\s*periode\s*}}/gi, periodText || '-')
      .replace(/{{\s*total\s*}}/gi, amountText || '-')
      .replace(/{{\s*metode\s*}}/gi, paidBy || '-');

    return await trySendWhatsappPayment(customerPhone, pesan, konteks);
  } catch (e) {
    logger.error(`[WA-Bayar/${konteks}] Gagal menyusun notifikasi: ${e.message}`);
    return { ok: false, reason: 'error' };
  }
}

module.exports = {
  trySendWhatsappPayment,
  sendPaymentSuccessWA,
  alasanText,
  DEFAULT_SUCCESS_TEMPLATE
};
