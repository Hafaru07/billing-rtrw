/**
 * Utilitas nominal unik QRIS.
 *
 * Cara kerja pencocokan pembayaran QRIS statis: tiap tagihan diberi "kode unik"
 * beberapa rupiah yang ditambahkan ke nominal tagihan, sehingga tiap transaksi
 * punya nominal yang berbeda dan bisa dicocokkan otomatis dari notifikasi bank.
 *
 * Rentang dibuat kecil (default 1-20 rupiah) supaya nominal yang dibayar
 * pelanggan tidak melenceng jauh dari tagihan aslinya.
 *
 * CATATAN KAPASITAS: keunikan dihitung dari nominal AKHIR (tagihan + kode),
 * jadi batasnya hanya berlaku antar tagihan yang nominal dasarnya SAMA.
 * Dengan rentang 1-20, maksimal 20 tagihan bernominal sama yang boleh
 * menunggu pembayaran QRIS pada saat bersamaan. Tagihan yang sudah lunas
 * otomatis melepas slotnya kembali.
 */
const { getSetting } = require('../config/settingsManager');

const DEFAULT_MIN = 1;
const DEFAULT_MAX = 20;

/** Rentang kode unik yang berlaku, sudah divalidasi agar selalu masuk akal. */
function getQrisUniqueRange() {
  let min = parseInt(getSetting('qris_unique_min', DEFAULT_MIN), 10);
  let max = parseInt(getSetting('qris_unique_max', DEFAULT_MAX), 10);

  if (!Number.isFinite(min) || min < 1) min = DEFAULT_MIN;
  if (!Number.isFinite(max) || max < 1) max = DEFAULT_MAX;
  if (max > 999) max = 999;          // batas atas wajar, kode unik bukan biaya
  if (min > max) [min, max] = [max, min];

  return { min, max, size: max - min + 1 };
}

/**
 * Pilih satu kode unik yang nominal akhirnya belum dipakai tagihan lain.
 *
 * Seluruh kemungkinan kode diacak lalu dicoba satu per satu, sehingga:
 *  - urutannya tetap acak (tidak mudah ditebak / tidak selalu mulai dari 1), dan
 *  - kalau masih ada slot kosong, PASTI ketemu — tidak bergantung keberuntungan
 *    seperti pendekatan "coba 50 kali secara acak".
 *
 * @param {number} baseAmount nominal tagihan asli
 * @param {(amount:number)=>boolean} isAvailable pemeriksa apakah nominal masih bebas
 * @returns {{code:number, amount:number}|null} null bila seluruh slot terpakai
 */
function pickQrisUniqueAmount(baseAmount, isAvailable) {
  const base = Number(baseAmount) || 0;
  const { min, max } = getQrisUniqueRange();

  const codes = [];
  for (let c = min; c <= max; c++) codes.push(c);

  // Acak urutan (Fisher-Yates)
  for (let i = codes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [codes[i], codes[j]] = [codes[j], codes[i]];
  }

  for (const code of codes) {
    const amount = base + code;
    if (isAvailable(amount)) return { code, amount };
  }
  return null;
}

/** Pesan error seragam saat seluruh slot kode unik sedang terpakai. */
function qrisRangeFullMessage() {
  const { min, max } = getQrisUniqueRange();
  return `Semua kode unik (${min}-${max}) sedang terpakai oleh tagihan lain dengan nominal sama. ` +
         `Tunggu salah satunya lunas, atau perbesar rentang di Pengaturan.`;
}

module.exports = { getQrisUniqueRange, pickQrisUniqueAmount, qrisRangeFullMessage, DEFAULT_MIN, DEFAULT_MAX };
