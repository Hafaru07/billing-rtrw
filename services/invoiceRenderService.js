/**
 * PENYIAPAN DATA CETAK INVOICE
 * ---------------------------------------------------------------------------
 * Invoice bisa dicetak dari dua tempat: halaman admin dan portal pelanggan.
 * Bila masing-masing menyiapkan datanya sendiri, cepat atau lambat keduanya
 * berbeda — dan invoice pelanggan yang tidak sama dengan invoice admin adalah
 * masalah kepercayaan, bukan sekadar bug tampilan.
 *
 * Modul ini menjadi satu-satunya sumber perhitungan tersebut.
 */
const crypto = require('crypto');
const { getSetting, getSettingsWithCache, getCurrentDateInTimezone } = require('../config/settingsManager');

/**
 * Pecah total tagihan menjadi baris DPP + pajak.
 *
 * Dua kemungkinan bentuk data:
 *  1. Pajak memang ditambahkan saat penagihan — tercatat di kolom notes
 *     dengan pola "AUTO: PPN 12% (Rp 12.000) | ...". Nilainya dipakai apa
 *     adanya supaya cetakan cocok dengan yang ditagihkan.
 *  2. Tidak ada catatan pajak — harga dianggap SUDAH termasuk PPN, lalu
 *     dipecah mundur tanpa mengubah total.
 */
function buildInvoiceLines(invoice) {
  const total = Number(invoice?.amount) || 0;
  const notes = String(invoice?.notes || '');
  const result = { taxes: [], adjustments: [], subtotal: total, mode: 'inclusive' };

  const parseRp = (s) => {
    const n = String(s || '').replace(/[^\d]/g, '');
    return n ? Number(n) : 0;
  };

  const autoMatch = notes.match(/AUTO:\s*(.+)/i);
  let taxTotal = 0;

  if (autoMatch) {
    for (const partRaw of autoMatch[1].split('|')) {
      const part = partRaw.trim();
      if (!part) continue;

      const ppn = part.match(/PPN\s*([\d.,]+)\s*%\s*\(Rp\s*([\d.,]+)\)/i);
      if (ppn) {
        const val = parseRp(ppn[2]);
        result.taxes.push({ label: `PPN ${ppn[1]}%`, amount: val });
        taxTotal += val;
        continue;
      }

      const uso = part.match(/USO\s*([\d.,]+)\s*%\s*\(Rp\s*([\d.,]+)\)/i);
      if (uso) {
        const val = parseRp(uso[2]);
        result.taxes.push({ label: `USO ${uso[1]}%`, amount: val });
        taxTotal += val;
        continue;
      }

      // Keterangan lain (promo, prorata, susulan) tampil sebagai catatan baris
      result.adjustments.push(part);
    }
  }

  if (result.taxes.length > 0) {
    result.mode = 'billed';
    result.subtotal = Math.max(0, total - taxTotal);
    return result;
  }

  const pct = Number(getSetting('invoice_ppn_percentage', 12)) || 12;
  if (pct > 0 && total > 0) {
    const dpp = Math.round(total / (1 + pct / 100));
    const ppnVal = total - dpp; // sisa dibebankan ke PPN agar penjumlahan tepat
    result.subtotal = dpp;
    result.taxes.push({ label: `PPN ${pct % 1 === 0 ? pct : pct.toFixed(2)}%`, amount: ppnVal, inclusive: true });
  }
  return result;
}

/**
 * Jatuh tempo = tanggal isolir pelanggan pada bulan periode tagihan.
 * Bila tanggal isolir melebihi jumlah hari bulan itu (mis. 31 di Februari),
 * digeser ke hari terakhir bulan tersebut.
 */
function buildDueInfo(invoice, customer) {
  try {
    const dueDay = Number(customer?.isolate_day || 0) || Number(getSetting('isolir_day', 10) || 10) || 10;
    const lastDay = new Date(invoice.period_year, invoice.period_month, 0).getDate();
    const day = Math.min(Math.max(1, dueDay), lastDay);
    const due = new Date(invoice.period_year, invoice.period_month - 1, day);

    const today = getCurrentDateInTimezone();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffDays = Math.round((due - todayMid) / 86400000);

    return {
      date: due,
      day,
      month: invoice.period_month,
      year: invoice.period_year,
      isOverdue: invoice.status === 'unpaid' && diffDays < 0,
      daysLeft: diffDays
    };
  } catch (e) {
    return null; // jatuh tempo bersifat opsional; invoice tetap tercetak
  }
}

/**
 * Kode verifikasi dokumen.
 *
 * Invoice yang bisa dicetak sendiri oleh pelanggan berpotensi disunting lalu
 * diakui sebagai bukti lunas. Kode ini mengikat NOMOR, NOMINAL, dan STATUS
 * tagihan ke sebuah HMAC yang hanya bisa dihitung server. Mengubah salah satu
 * angka di kertas tidak mengubah kodenya, sehingga ketidakcocokan langsung
 * ketahuan saat admin memeriksanya.
 *
 * Ini bukan tanda tangan digital penuh — tujuannya membuat pemalsuan bisa
 * DIDETEKSI, bukan mustahil dilakukan.
 */
function invoiceVerifyCode(invoice) {
  const settings = getSettingsWithCache();
  const secret = String(settings.session_secret || 'rahasia-portal-pelanggan-default-ganti-ini');
  const material = [
    'INV',
    Number(invoice?.id || 0),
    Number(invoice?.amount || 0),
    String(invoice?.status || ''),
    Number(invoice?.period_month || 0),
    Number(invoice?.period_year || 0)
  ].join(':');

  return crypto.createHmac('sha256', secret)
    .update(material)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase()
    .replace(/(.{5})(.{5})/, '$1-$2');
}

module.exports = {
  buildInvoiceLines,
  buildDueInfo,
  invoiceVerifyCode
};
