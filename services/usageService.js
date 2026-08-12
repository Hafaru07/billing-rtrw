/**
 * PELACAKAN PEMAKAIAN KUOTA (USAGE TRACKING)
 * ---------------------------------------------------------------------------
 * Angka pemakaian TIDAK boleh dibaca langsung dari MikroTik setiap kali
 * dibutuhkan. Penghitung di MikroTik bersifat per sesi: nol lagi setiap kali
 * pelanggan tersambung ulang, dan hilang sama sekali bila router di-reboot.
 * Kalau FUP bergantung padanya, kuota pelanggan ikut ter-reset setiap kali
 * modem mati — bukan itu yang diinginkan.
 *
 * Karena itu yang disimpan di sini adalah AKUMULASI: setiap pengambilan sampel
 * hanya menambahkan SELISIH sejak sampel sebelumnya ke `customer_usage`.
 * Angka totalnya hidup di database, bukan di router.
 *
 * Tiga keadaan yang harus dibedakan saat menghitung selisih:
 *
 *  1. Sesi sama, angka naik      -> selisih = sekarang - terakhir
 *  2. Sesi berganti / angka turun -> pelanggan reconnect atau router reboot.
 *                                    Penghitung mulai dari nol lagi, jadi
 *                                    seluruh angka sekarang adalah pemakaian
 *                                    baru dan ditambahkan penuh.
 *  3. Ganti bulan                 -> baris periode baru dibuat, tetapi titik
 *                                    acuan penghitungnya DIWARISI dari bulan
 *                                    sebelumnya. Tanpa ini, sesi yang sedang
 *                                    berjalan akan dihitung ulang dari nol dan
 *                                    kuota bulan baru langsung terpakai besar.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getCurrentDateInTimezone } = require('../config/settingsManager');

const GB = 1024 * 1024 * 1024;

/** Periode aktif menurut zona waktu aplikasi, bukan zona waktu server. */
function periodeSekarang() {
  const now = getCurrentDateInTimezone();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

function getUsage(customerId, month, year) {
  const p = (month && year) ? { month, year } : periodeSekarang();
  return db.prepare(
    'SELECT * FROM customer_usage WHERE customer_id = ? AND period_month = ? AND period_year = ?'
  ).get(customerId, p.month, p.year);
}

/** Total pemakaian bulan berjalan dalam GB. */
function getTotalGB(customerId, month, year) {
  const u = getUsage(customerId, month, year);
  if (!u) return 0;
  return ((Number(u.bytes_in) || 0) + (Number(u.bytes_out) || 0)) / GB;
}

/** Baris pemakaian terakhir milik pelanggan, dari periode mana pun. */
function barisTerakhir(customerId) {
  return db.prepare(`
    SELECT * FROM customer_usage
    WHERE customer_id = ?
    ORDER BY period_year DESC, period_month DESC
    LIMIT 1
  `).get(customerId);
}

/**
 * Catat satu sampel penghitung dari MikroTik.
 *
 * @param {number} customerId
 * @param {{bytesIn:number, bytesOut:number, sessionId?:string}} sampel
 *        Nilai KUMULATIF sesi saat ini apa adanya dari router.
 * @returns {{deltaIn:number, deltaOut:number, alasan:string}}
 */
function recordSample(customerId, sampel) {
  const totalIn = Math.max(0, Number(sampel.bytesIn) || 0);
  const totalOut = Math.max(0, Number(sampel.bytesOut) || 0);
  const sessionId = String(sampel.sessionId || '');

  const { month, year } = periodeSekarang();
  const barisPeriode = getUsage(customerId, month, year);

  // Titik acuan: dari periode berjalan bila ada, kalau tidak diwarisi dari
  // baris terakhir pelanggan (kasus pergantian bulan).
  const acuan = barisPeriode || barisTerakhir(customerId);

  let deltaIn = 0;
  let deltaOut = 0;
  let alasan;

  if (!acuan) {
    // Belum pernah tercatat sama sekali. Angka sesi saat ini bisa jadi sudah
    // berjalan lama sebelum fitur ini menyala; menambahkannya penuh akan
    // melonjakkan kuota secara tidak adil. Sampel pertama dipakai sebagai
    // titik nol saja.
    deltaIn = 0;
    deltaOut = 0;
    alasan = 'sampel-pertama';
  } else {
    const sesiBerganti = sessionId && acuan.last_session_id && sessionId !== acuan.last_session_id;
    const angkaTurun = totalIn < (Number(acuan.last_total_bytes_in) || 0)
                    || totalOut < (Number(acuan.last_total_bytes_out) || 0);

    if (sesiBerganti || angkaTurun) {
      // Penghitung router sudah kembali ke nol; semua yang terbaca sekarang
      // adalah pemakaian baru.
      deltaIn = totalIn;
      deltaOut = totalOut;
      alasan = sesiBerganti ? 'sesi-baru' : 'penghitung-reset';
    } else {
      deltaIn = totalIn - (Number(acuan.last_total_bytes_in) || 0);
      deltaOut = totalOut - (Number(acuan.last_total_bytes_out) || 0);
      alasan = 'lanjut';
    }
  }

  if (barisPeriode) {
    db.prepare(`
      UPDATE customer_usage
      SET bytes_in = bytes_in + ?,
          bytes_out = bytes_out + ?,
          last_total_bytes_in = ?,
          last_total_bytes_out = ?,
          last_session_id = ?,
          updated_at = NOW_LOCAL()
      WHERE id = ?
    `).run(deltaIn, deltaOut, totalIn, totalOut, sessionId, barisPeriode.id);
  } else {
    // Baris bulan baru dimulai dari nol pemakaian, tetapi titik acuannya
    // langsung diisi angka sesi sekarang supaya sampel berikutnya menghitung
    // selisih dengan benar.
    db.prepare(`
      INSERT INTO customer_usage
        (customer_id, period_month, period_year, bytes_in, bytes_out,
         last_total_bytes_in, last_total_bytes_out, last_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(customerId, month, year, deltaIn, deltaOut, totalIn, totalOut, sessionId);
  }

  return { deltaIn, deltaOut, alasan };
}

/**
 * Nolkan titik acuan penghitung tanpa menghapus akumulasi.
 * Dipakai bila admin ingin memaksa sampel berikutnya dihitung dari awal.
 */
function resetUsageCounter(customerId) {
  const { month, year } = periodeSekarang();
  return db.prepare(`
    UPDATE customer_usage
    SET last_total_bytes_in = 0, last_total_bytes_out = 0, last_session_id = ''
    WHERE customer_id = ? AND period_month = ? AND period_year = ?
  `).run(customerId, month, year);
}

/** Kosongkan pemakaian satu pelanggan pada periode berjalan. */
function clearUsage(customerId) {
  const { month, year } = periodeSekarang();
  const r = db.prepare(`
    UPDATE customer_usage
    SET bytes_in = 0, bytes_out = 0, updated_at = NOW_LOCAL()
    WHERE customer_id = ? AND period_month = ? AND period_year = ?
  `).run(customerId, month, year);
  logger.info(`[Usage] Pemakaian pelanggan ${customerId} periode ${month}/${year} dikosongkan.`);
  return r;
}

module.exports = {
  getUsage,
  getTotalGB,
  recordSample,
  resetUsageCounter,
  clearUsage,
  periodeSekarang,
  GB
};
