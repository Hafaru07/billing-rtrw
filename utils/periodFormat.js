/**
 * Format periode tagihan untuk teks yang DIBACA PELANGGAN.
 *
 * Sebelumnya periode ditulis "8/2026" di banyak tempat. Bagi pelanggan itu
 * ambigu (mudah terbaca sebagai tanggal 8) dan terasa seperti keluaran mesin.
 * Modul ini menyatukan formatnya menjadi "Agustus 2026".
 *
 * Dipakai lintas berkas supaya pesan WhatsApp, keterangan pembayaran, dan
 * invoice memakai gaya penulisan yang sama.
 */

const BULAN_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const BULAN_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Ubah bulan+tahun menjadi teks yang mudah dibaca.
 *
 *   formatPeriod(8, 2026)  ->  'Agustus 2026'
 *
 * Bulan di luar 1-12 dikembalikan apa adanya ("8/2026") agar tidak ada
 * informasi yang hilang bila datanya ternyata rusak.
 *
 * @param {number|string} month 1-12
 * @param {number|string} year
 * @param {string} [lang='id'] 'id' atau 'en'
 * @returns {string}
 */
function formatPeriod(month, year, lang = 'id') {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (!Number.isFinite(m) || !Number.isFinite(y)) return `${month || '-'}/${year || '-'}`;
  if (m < 1 || m > 12) return `${m}/${y}`;
  const names = String(lang).toLowerCase() === 'en' ? BULAN_EN : BULAN_ID;
  return `${names[m - 1]} ${y}`;
}

/**
 * Gabungkan beberapa periode invoice menjadi satu kalimat.
 *
 *   formatPeriodList([{period_month:7,period_year:2026},
 *                     {period_month:8,period_year:2026}])
 *   ->  'Juli 2026, Agustus 2026'
 *
 * Periode kembar otomatis disatukan, dan urutannya dijaga dari yang paling
 * lama supaya pelanggan mudah membaca tunggakannya.
 *
 * @param {Array<{period_month:number, period_year:number}>} invoices
 * @param {string} [lang='id']
 * @param {string} [separator=', ']
 * @returns {string}
 */
function formatPeriodList(invoices, lang = 'id', separator = ', ') {
  const list = Array.isArray(invoices) ? invoices : [];
  const seen = new Set();
  const items = [];

  for (const inv of list) {
    const m = parseInt(inv?.period_month, 10);
    const y = parseInt(inv?.period_year, 10);
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, text: formatPeriod(m, y, lang) });
  }

  items.sort((a, b) => a.key.localeCompare(b.key));
  return items.map(i => i.text).join(separator);
}

/**
 * Format tanggal lengkap untuk teks yang dibaca pelanggan.
 *
 *   formatDateLong(new Date(2026, 7, 10))  ->  '10 Agustus 2026'
 *
 * @param {Date} date
 * @param {string} [lang='id']
 * @returns {string} string kosong bila tanggal tidak valid
 */
function formatDateLong(date, lang = 'id') {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  const names = String(lang).toLowerCase() === 'en' ? BULAN_EN : BULAN_ID;
  return `${date.getDate()} ${names[date.getMonth()]} ${date.getFullYear()}`;
}

module.exports = { formatPeriod, formatPeriodList, formatDateLong, BULAN_ID, BULAN_EN };
