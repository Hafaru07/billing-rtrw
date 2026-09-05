/**
 * NOTIFIKASI WHATSAPP "PEMBAYARAN BERHASIL"
 * ---------------------------------------------------------------------------
 * Tagihan bisa dilunasi dari banyak pintu: admin, kasir, approval kolektor,
 * auto-approve kolektor di lapangan, dan agen. Semuanya harus mengirim pesan
 * yang sama, dari template yang sama, dengan penjagaan yang sama — kalau
 * tidak, pelanggan menerima bentuk pesan berbeda tergantung siapa yang
 * kebetulan menerima uangnya.
 *
 * Modul ini menjadi satu-satunya tempat pesan itu disusun dan dikirim.
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

/**
 * Kirim satu pesan WhatsApp ke pelanggan.
 *
 * Mengembalikan false (bukan melempar) pada setiap kegagalan: pembayarannya
 * sendiri sudah tersimpan di database, dan notifikasi yang gagal tidak boleh
 * membatalkan transaksi yang sudah sah.
 *
 * @returns {Promise<boolean>} true bila pesan benar-benar terkirim
 */
async function trySendWhatsappPayment(customerPhone, message) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;

    const to = String(customerPhone || '').trim();
    const text = String(message || '').trim();
    if (!to || !text) return false;

    // whatsappBot.mjs adalah ES module — HARUS lewat import() dinamis.
    // `require()` padanya melempar ERR_REQUIRE_ESM.
    const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') return false;

    await sendWA(to, text);
    return true;
  } catch (e) {
    logger.warn(`[WA-Bayar] Gagal kirim notifikasi ke ${customerPhone}: ${e.message}`);
    return false;
  }
}

/**
 * Kirim notifikasi "pembayaran berhasil" memakai template dari panel admin.
 *
 * @param {string} customerPhone
 * @param {string} customerName
 * @param {string} periodText  mis. 'September 2026' atau daftar beberapa periode
 * @param {string} amountText  nominal yang sudah diformat, mis. '100.000'
 * @param {string} paidBy      mis. 'Kolektor Anas (@anas)'
 * @returns {Promise<boolean>}
 */
async function sendPaymentSuccessWA(customerPhone, customerName, periodText, amountText, paidBy) {
  try {
    const template = db.getAppSetting('whatsapp_payment_success_message', DEFAULT_SUCCESS_TEMPLATE)
                     || DEFAULT_SUCCESS_TEMPLATE;

    const pesan = String(template)
      .replace(/{{\s*nama\s*}}/gi, customerName || 'Pelanggan')
      .replace(/{{\s*periode\s*}}/gi, periodText || '-')
      .replace(/{{\s*total\s*}}/gi, amountText || '-')
      .replace(/{{\s*metode\s*}}/gi, paidBy || '-');

    return await trySendWhatsappPayment(customerPhone, pesan);
  } catch (e) {
    logger.warn(`[WA-Bayar] Gagal menyusun notifikasi: ${e.message}`);
    return false;
  }
}

module.exports = {
  trySendWhatsappPayment,
  sendPaymentSuccessWA,
  DEFAULT_SUCCESS_TEMPLATE
};
