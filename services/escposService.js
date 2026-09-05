/**
 * ESC/POS — PEMBUAT DATA CETAK UNTUK PRINTER THERMAL
 * ---------------------------------------------------------------------------
 * Printer thermal tidak mengerti HTML. `window.print()` selalu lewat driver
 * sistem operasi, sehingga selalu memunculkan dialog cetak dan hasilnya
 * di-raster seperti dokumen A4 — itulah sebabnya struk tidak pernah keluar
 * "native" dari printer Bluetooth.
 *
 * Modul ini membuat aliran byte ESC/POS: bahasa yang benar-benar dipahami
 * printer thermal. Hasilnya dikirim apa adanya ke printer (lewat RawBT di
 * Android, atau Web Bluetooth untuk printer BLE), tanpa dialog cetak dan
 * tanpa driver.
 *
 * Referensi perintah: Epson ESC/POS Command Reference — didukung hampir semua
 * printer thermal 58mm/80mm di pasaran yang mengklaim "ESC/POS compatible".
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  INIT:          [ESC, 0x40],            // ESC @   — reset printer
  CODEPAGE_437:  [ESC, 0x74, 0x00],      // ESC t 0 — CP437 (isi sudah di-fold ke ASCII)
  ALIGN_LEFT:    [ESC, 0x61, 0x00],
  ALIGN_CENTER:  [ESC, 0x61, 0x01],
  ALIGN_RIGHT:   [ESC, 0x61, 0x02],
  BOLD_ON:       [ESC, 0x45, 0x01],
  BOLD_OFF:      [ESC, 0x45, 0x00],
  UNDERLINE_ON:  [ESC, 0x2d, 0x01],
  UNDERLINE_OFF: [ESC, 0x2d, 0x00],
  SIZE_NORMAL:   [GS, 0x21, 0x00],       // GS ! n — bit 4-6 lebar, bit 0-2 tinggi
  SIZE_TALL:     [GS, 0x21, 0x01],       // tinggi 2x, lebar normal
  SIZE_DOUBLE:   [GS, 0x21, 0x11],       // lebar & tinggi 2x
  CUT:           [GS, 0x56, 0x42, 0x00]  // GS V 66 0 — umpan lalu potong sebagian
};

/**
 * Profil kertas.
 *
 * `cols` dihitung dari lebar cetak efektif dibagi lebar Font A (12 dot):
 *   80mm -> area cetak 72mm @203dpi = 576 dot / 12 = 48 karakter
 *   58mm -> area cetak 48mm @203dpi = 384 dot / 12 = 32 karakter
 * Salah menghitung ini membuat baris membungkus sendiri dan kolom nominal
 * jadi berantakan — jangan diubah tanpa mengukur ulang di printer.
 *
 * `margin` adalah jarak kiri-kanan dalam karakter. Tanpa ini teks menempel
 * ke tepi kiri kertas dan struk terlihat berat sebelah; dengan margin yang
 * sama di kedua sisi, blok teks duduk di tengah kertas.
 */
const PROFILES = {
  '80': { cols: 48, dots: 576, logoDots: 384, margin: 2 },
  '58': { cols: 32, dots: 384, logoDots: 256, margin: 1 }
};

function profileFor(width) {
  const key = String(width || '80').replace(/[^\d]/g, '');   // terima '80', '80mm', 80
  return PROFILES[key] || PROFILES['80'];
}

// ─── TEKS ───────────────────────────────────────────────────────────────────

/**
 * Printer thermal memakai code page 8-bit, bukan UTF-8. Karakter seperti em
 * dash, titik tengah, atau kutip melengkung yang lazim ada di alamat dan
 * catatan akan tercetak sebagai simbol acak. Semua dipetakan ke ASCII dulu.
 */
const FOLD = {
  '—': '-',  '–': '-',  '−': '-',  '‐': '-',   // em/en dash, minus, hyphen
  '‘': "'",  '’': "'",  '“': '"',  '”': '"',   // kutip melengkung
  '·': '.',  '•': '*',  '…': '...', '×': 'x',  // middle dot, bullet, elipsis
  '→': '->', '°': ' ',  '©': '(c)',
  ' ': ' ',  ' ': ' ',  ' ': ' ',                    // spasi non-breaking / sempit / tipis
  '™': '',   '®': ''
};

function ascii(input) {
  const s = String(input == null ? '' : input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  return s.replace(/[^\x20-\x7E\n]/g, (ch) => (FOLD[ch] !== undefined ? FOLD[ch] : '?'));
}

function padRight(s, n) {
  const v = String(s).slice(0, n);
  return v + ' '.repeat(Math.max(0, n - v.length));
}

function padLeft(s, n) {
  const v = String(s).slice(0, n);
  return ' '.repeat(Math.max(0, n - v.length)) + v;
}

function wrapText(text, n) {
  const width = Math.max(1, n);
  const words = ascii(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  for (const word of words) {
    if (!cur) cur = word;
    else if ((cur + ' ' + word).length <= width) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
    // Kata tunggal lebih panjang dari kertas (mis. URL) — dipotong paksa
    while (cur.length > width) {
      lines.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function formatRp(n) {
  const v = Math.round(Math.abs(Number(n) || 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
               'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** Terbilang rupiah (tanpa sen) — algoritma sama dengan invoice A4. */
function terbilang(n) {
  const num = Math.floor(Math.abs(Number(n) || 0));
  const sat = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh',
               'delapan', 'sembilan', 'sepuluh', 'sebelas'];
  function conv(x) {
    if (x < 12) return sat[x];
    if (x < 20) return conv(x - 10) + ' belas';
    if (x < 100) return conv(Math.floor(x / 10)) + ' puluh' + (x % 10 ? ' ' + conv(x % 10) : '');
    if (x < 200) return 'seratus' + (x - 100 ? ' ' + conv(x - 100) : '');
    if (x < 1000) return conv(Math.floor(x / 100)) + ' ratus' + (x % 100 ? ' ' + conv(x % 100) : '');
    if (x < 2000) return 'seribu' + (x - 1000 ? ' ' + conv(x - 1000) : '');
    if (x < 1000000) return conv(Math.floor(x / 1000)) + ' ribu' + (x % 1000 ? ' ' + conv(x % 1000) : '');
    if (x < 1000000000) return conv(Math.floor(x / 1000000)) + ' juta' + (x % 1000000 ? ' ' + conv(x % 1000000) : '');
    return conv(Math.floor(x / 1000000000)) + ' miliar' + (x % 1000000000 ? ' ' + conv(x % 1000000000) : '');
  }
  if (num === 0) return 'Nol';
  const s = conv(num).replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── LOGO (raster bitmap) ───────────────────────────────────────────────────

/**
 * Ubah berkas gambar menjadi perintah raster ESC/POS `GS v 0`.
 *
 * Printer hanya bisa hitam atau putih — tidak ada abu-abu. Logo diperkecil
 * dengan box sampling lalu di-dither Bayer 4x4, supaya gradasi dan tepi
 * anti-alias tidak berubah jadi blok hitam pekat.
 *
 * Mengembalikan null bila gambar tidak ada atau gagal dibaca: struk tetap
 * tercetak tanpa logo, karena logo bukan alasan yang sah untuk menggagalkan
 * pencetakan bukti pembayaran.
 *
 * @param {string} filePath
 * @param {number} targetDots  lebar logo yang diinginkan, dalam dot
 * @param {number} [canvasDots] bila diisi, logo diletakkan di tengah kanvas
 *        selebar ini. Banyak printer MENGABAIKAN `ESC a` (rata tengah) untuk
 *        gambar raster dan selalu mencetaknya menempel ke kiri. Menengahkan
 *        gambar di dalam bitmap-nya sendiri membuat hasilnya tetap di tengah
 *        pada printer mana pun, tanpa bergantung pada perilaku itu.
 */
async function buildLogoRaster(filePath, targetDots, canvasDots) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;

    // jimp v1.x mengekspor objek, bukan kelas — harus di-destructure.
    const { Jimp } = require('jimp');
    const img = await Jimp.read(filePath);
    const sw = Number(img && img.bitmap && img.bitmap.width) || 0;
    const sh = Number(img && img.bitmap && img.bitmap.height) || 0;
    const src = img && img.bitmap && img.bitmap.data;
    if (!sw || !sh || !src) return null;

    // Lebar raster wajib kelipatan 8 (satu byte = 8 dot horizontal)
    let dstW = Math.floor(Math.min(targetDots, sw < targetDots ? sw : targetDots) / 8) * 8;
    if (dstW < 8) dstW = 8;
    let dstH = Math.max(1, Math.round((sh / sw) * dstW));

    const MAX_H = 200; // batasi supaya logo tidak menghabiskan kertas
    if (dstH > MAX_H) {
      dstH = MAX_H;
      dstW = Math.max(8, Math.floor(((sw / sh) * dstH) / 8) * 8);
    }

    // Box sampling: rata-rata luminansi tiap blok sumber -> satu piksel tujuan
    const lum = new Float64Array(dstW * dstH);
    for (let y = 0; y < dstH; y++) {
      const y0 = Math.floor((y * sh) / dstH);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dstH));
      for (let x = 0; x < dstW; x++) {
        const x0 = Math.floor((x * sw) / dstW);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dstW));
        let sum = 0;
        let count = 0;
        for (let yy = y0; yy < y1 && yy < sh; yy++) {
          for (let xx = x0; xx < x1 && xx < sw; xx++) {
            const i = (yy * sw + xx) * 4;
            const a = src[i + 3] / 255;
            // Komposit di atas putih: bagian transparan harus jadi putih.
            // Tanpa ini, logo PNG transparan tercetak sebagai kotak hitam.
            const l = (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * a + 255 * (1 - a);
            sum += l;
            count++;
          }
        }
        lum[y * dstW + x] = count ? sum / count : 255;
      }
    }

    const BAYER = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5]
    ];

    const imgBytes = dstW / 8;

    // Kanvas dibulatkan ke byte penuh; sisa 1-7 dot tidak kasat mata pada
    // 203 dpi (kurang dari 0,9 mm), jadi pembulatan ini aman untuk mata.
    const canvasBytes = Math.max(imgBytes, Math.floor((canvasDots || dstW) / 8));
    const padBytes = Math.floor((canvasBytes - imgBytes) / 2);

    const data = Buffer.alloc(canvasBytes * dstH, 0); // 0 = putih
    for (let y = 0; y < dstH; y++) {
      const rowStart = y * canvasBytes + padBytes;
      for (let x = 0; x < dstW; x++) {
        const threshold = ((BAYER[y & 3][x & 3] + 0.5) / 16) * 255;
        if (lum[y * dstW + x] < threshold) {
          // bit 1 = titik hitam, MSB lebih dulu
          data[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }

    const header = Buffer.from([
      GS, 0x76, 0x30, 0x00,
      canvasBytes & 0xff, (canvasBytes >> 8) & 0xff,
      dstH & 0xff, (dstH >> 8) & 0xff
    ]);
    return Buffer.concat([header, data]);
  } catch (e) {
    logger.warn(`[escpos] Logo dilewati: ${e.message}`);
    return null;
  }
}

// ─── PENYUSUN STRUK ─────────────────────────────────────────────────────────

class Writer {
  /**
   * @param {number} cols    lebar kertas dalam karakter
   * @param {number} margin  jarak kiri-kanan dalam karakter
   */
  constructor(cols, margin = 0) {
    this.paperCols = cols;
    this.margin = Math.max(0, Math.min(margin, Math.floor(cols / 4)));
    this.cols = cols - this.margin * 2;   // lebar area teks yang bisa dipakai
    this.align = 'left';
    this.parts = [];
  }
  raw(bytes) { this.parts.push(Buffer.from(bytes)); return this; }
  text(s) { this.parts.push(Buffer.from(ascii(s), 'latin1')); return this; }

  // Perataan dicatat, bukan sekadar dikirim, karena `line()` perlu tahu
  // kapan boleh menambahkan indentasi margin.
  alignLeft() { this.align = 'left'; return this.raw(CMD.ALIGN_LEFT); }
  alignCenter() { this.align = 'center'; return this.raw(CMD.ALIGN_CENTER); }

  /**
   * Indentasi hanya diberikan pada baris rata kiri.
   *
   * Baris rata tengah sudah ditengahkan printer terhadap lebar kertas PENUH;
   * menambahkan spasi di depannya justru menggeser teks ke kanan dan membuat
   * judul tidak lagi sejajar dengan blok di bawahnya.
   */
  line(s = '') {
    const indent = this.align === 'left' ? ' '.repeat(this.margin) : '';
    return this.text(indent + String(s) + '\n');
  }
  lines(arr) { for (const l of arr) this.line(l); return this; }
  divider(ch = '-') { return this.line(ch.repeat(this.cols)); }
  bold(on) { return this.raw(on ? CMD.BOLD_ON : CMD.BOLD_OFF); }
  feed(n = 1) { return this.raw([ESC, 0x64, Math.max(0, Math.min(255, n))]); }

  /** Baris dua kolom: keterangan di kiri, nominal rata kanan. */
  row(left, right) {
    const r = ascii(right);
    const maxLeft = Math.max(1, this.cols - r.length - 1);
    const wrapped = wrapText(left, maxLeft);
    for (let i = 0; i < wrapped.length - 1; i++) this.line(wrapped[i]);
    const last = wrapped[wrapped.length - 1] || '';
    return this.line(padRight(last, this.cols - r.length) + r);
  }

  /**
   * Baris "Label : isi" dengan label lebar tetap agar titik dua rapi menurun.
   *
   * Lebar label tidak boleh memotong labelnya sendiri: di kertas 58mm,
   * "Jatuh Tempo" (11 karakter) pernah tercetak "Jatuh Temp" karena lebar
   * dihitung dari lebar kertas saja. Panjang label selalu jadi batas bawah.
   */
  field(label, value, labelWidth) {
    const base = labelWidth || Math.min(14, Math.max(8, Math.floor(this.cols / 3)));
    const lw = Math.max(base, ascii(label).length);
    const head = padRight(ascii(label), lw) + ': ';
    const body = wrapText(value, this.cols - head.length);
    this.line(head + (body[0] || ''));
    for (let i = 1; i < body.length; i++) this.line(' '.repeat(head.length) + body[i]);
    return this;
  }

  build() { return Buffer.concat(this.parts); }
}

/**
 * Susun struk tagihan / bukti bayar menjadi byte ESC/POS.
 *
 * @param {object}   o
 * @param {object}   o.invoice     baris invoice (billingService.getInvoiceById)
 * @param {object}   o.customer    data pelanggan
 * @param {object}   o.settings    isi settings.json
 * @param {object}  [o.breakdown]  rincian DPP + pajak (invoiceRenderService.buildInvoiceLines)
 * @param {object}  [o.dueInfo]    info jatuh tempo (invoiceRenderService.buildDueInfo)
 * @param {string}  [o.verifyCode] kode verifikasi dokumen
 * @param {string}  [o.width]      '80' atau '58'
 * @param {boolean} [o.logo]       sertakan logo perusahaan
 * @param {string}  [o.printedAt]  waktu cetak yang sudah diformat
 * @param {string}  [o.paidAtText] waktu bayar yang sudah diformat
 * @returns {Promise<Buffer>}
 */
async function buildInvoiceReceipt(o) {
  const invoice = o.invoice || {};
  const customer = o.customer || {};
  const settings = o.settings || {};
  const breakdown = o.breakdown || null;
  const dueInfo = o.dueInfo || null;
  const verifyCode = String(o.verifyCode || '');
  const printedAt = String(o.printedAt || '');
  const prof = profileFor(o.width);
  const w = new Writer(prof.cols, o.margin != null ? Number(o.margin) : prof.margin);

  const isPaid = invoice.status === 'paid';
  const qrisAmount = Number(invoice.qris_amount_unique || 0) || 0;
  const qrisCode = Number(invoice.qris_unique_code || 0) || 0;
  const hasQris = !isPaid && qrisAmount > 0;
  const total = Number(invoice.amount) || 0;
  const payAmount = hasQris ? qrisAmount : total;

  const invNo = 'INV-' + invoice.period_year +
                String(invoice.period_month).padStart(2, '0') + '-' +
                String(invoice.id).padStart(5, '0');
  const periodText = (BULAN[Number(invoice.period_month) - 1] || '') + ' ' + invoice.period_year;

  w.raw(CMD.INIT).raw(CMD.CODEPAGE_437);

  // ── Kepala ──────────────────────────────────────────────────────────────
  if (o.logo !== false) {
    const logoPath = path.join(__dirname, '..', 'public', 'img', 'logo.png');
    const raster = await buildLogoRaster(logoPath, prof.logoDots, prof.dots);
    if (raster) w.alignCenter().raw(raster).line().alignLeft();
  }

  w.alignCenter().raw(CMD.SIZE_TALL).bold(true);
  w.lines(wrapText(settings.company_header || 'ISP', w.cols));
  w.bold(false).raw(CMD.SIZE_NORMAL);

  if (settings.company_address) w.lines(wrapText(settings.company_address, w.cols));
  const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers[0])
    ? '+' + settings.whatsapp_admin_numbers[0]
    : (settings.company_phone || '');
  if (phone) w.lines(wrapText('Telp/WA: ' + phone, w.cols));
  w.alignLeft().divider('=');

  w.alignCenter().bold(true);
  w.line(isPaid ? 'BUKTI PEMBAYARAN' : 'TAGIHAN INTERNET');
  w.bold(false).alignLeft().divider();

  // ── Identitas dokumen ───────────────────────────────────────────────────
  w.field(isPaid ? 'No. Struk' : 'No. Tagihan', invNo);
  // paidAtText sudah diformat pemanggil agar sama dengan invoice A4; nilai
  // mentah dari database hanya dipakai bila pemanggil tidak menyediakannya.
  const paidText = String(o.paidAtText || invoice.paid_at || '');
  w.field('Tanggal', isPaid && paidText ? paidText : (printedAt || '-'));
  if (isPaid && invoice.paid_by_name) w.field('Diterima', invoice.paid_by_name);
  w.divider();

  // ── Pelanggan ───────────────────────────────────────────────────────────
  w.bold(true).lines(wrapText('Yth. ' + (customer.name || '-'), w.cols)).bold(false);
  w.lines(wrapText('ID/Tag: ' + (customer.phone || customer.genieacs_tag || '-'), w.cols));
  if (customer.address) w.lines(wrapText(customer.address, w.cols));
  w.divider();

  // ── Layanan ─────────────────────────────────────────────────────────────
  w.field('Periode', periodText);
  w.field('Paket', customer.package_name || invoice.package_name || 'Layanan Internet');
  if (dueInfo && dueInfo.date) {
    w.field('Jatuh Tempo', String(dueInfo.day).padStart(2, '0') + ' ' +
                           (BULAN[dueInfo.month - 1] || '') + ' ' + dueInfo.year);
  }
  w.divider();

  // ── Rincian nominal ─────────────────────────────────────────────────────
  if (breakdown && Array.isArray(breakdown.taxes) && breakdown.taxes.length > 0) {
    w.row('Biaya Bulanan', 'Rp ' + padLeft(formatRp(breakdown.subtotal), 10));
    for (const tax of breakdown.taxes) {
      w.row(tax.label, 'Rp ' + padLeft(formatRp(tax.amount), 10));
    }
    if (Array.isArray(breakdown.adjustments)) {
      for (const adj of breakdown.adjustments) w.lines(wrapText('* ' + adj, w.cols));
    }
  } else {
    w.row('Biaya Bulanan ' + periodText, 'Rp ' + padLeft(formatRp(total), 10));
  }
  w.divider();

  // ── Total ───────────────────────────────────────────────────────────────
  w.bold(true)
   .row(isPaid ? 'TOTAL BAYAR' : 'TOTAL TAGIHAN', 'Rp ' + padLeft(formatRp(total), 10))
   .bold(false);

  if (hasQris) {
    w.divider();
    w.alignCenter().bold(true).line('BAYAR TEPAT SEJUMLAH').bold(false);
    w.raw(CMD.SIZE_DOUBLE).bold(true).line('Rp ' + formatRp(qrisAmount)).bold(false).raw(CMD.SIZE_NORMAL);
    w.lines(wrapText('Kode unik ' + qrisCode + ' - jangan dibulatkan', w.cols));
    w.alignLeft();
  }

  w.lines(wrapText('Terbilang: ' + terbilang(payAmount) + ' rupiah', w.cols));
  w.divider();

  // ── Status ──────────────────────────────────────────────────────────────
  w.alignCenter().bold(true).raw(CMD.SIZE_TALL);
  w.line(isPaid ? '*** L U N A S ***' : '*** BELUM LUNAS ***');
  w.raw(CMD.SIZE_NORMAL).bold(false);

  if (isPaid) {
    w.lines(wrapText('Terima kasih atas pembayaran Anda.', w.cols));
    w.lines(wrapText('Simpan struk ini sebagai bukti pembayaran yang sah.', w.cols));
  } else {
    w.lines(wrapText('Mohon segera lakukan pembayaran.', w.cols));
    w.lines(wrapText('Lembar ini BUKAN bukti pembayaran.', w.cols));
  }

  if (settings.invoice_note) {
    w.line();
    w.lines(wrapText(String(settings.invoice_note), w.cols));
  }

  w.alignLeft().divider();
  w.alignCenter();
  if (verifyCode) w.lines(wrapText('Kode Verifikasi: ' + verifyCode, w.cols));
  if (printedAt) w.lines(wrapText('Dicetak: ' + printedAt, w.cols));
  w.alignLeft();

  // Umpan kertas sebelum potong: tanpa ini, beberapa baris terakhir masih
  // berada di dalam mekanisme printer dan ikut tersobek saat kertas ditarik.
  w.feed(4).raw(CMD.CUT);

  return w.build();
}

/**
 * Ubah buffer ESC/POS kembali menjadi teks biasa untuk pratinjau di layar.
 *
 * Pratinjau sengaja dibuat DARI buffer yang akan dikirim ke printer, bukan
 * dari HTML terpisah. Kalau keduanya disusun sendiri-sendiri, cepat atau
 * lambat tampilan di layar berbeda dengan kertas yang keluar — dan pada
 * dokumen bukti pembayaran, selisih seperti itu bukan sekadar salah tampilan.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function toPlainText(buf, cols) {
  const width = Number(cols) || 0;
  let out = '';
  let line = '';
  let align = 0;   // 0 = kiri, 1 = tengah, 2 = kanan

  /**
   * Baris rata tengah/kanan tidak memuat spasi apa pun di dalam buffer —
   * yang menggesernya adalah printer, lewat `ESC a`. Kalau pratinjau hanya
   * membuang perintah dan mencetak teksnya, semua baris tampak rata kiri dan
   * layar tidak lagi menggambarkan kertas. Di sini perataan itu diperagakan
   * ulang dengan spasi, supaya pratinjau benar-benar sesuai hasil cetak.
   */
  const flush = () => {
    const body = line.replace(/\s+$/, '');
    // Baris kosong tetap kosong: menengahkan string kosong hanya menghasilkan
    // setengah baris spasi yang tidak terlihat di kertas tapi mengotori
    // pratinjau dan berkas .bin.
    if (!body) { out += '\n'; line = ''; return; }
    if (width > 0 && align === 1) {
      out += ' '.repeat(Math.max(0, Math.floor((width - body.length) / 2))) + body;
    } else if (width > 0 && align === 2) {
      out += ' '.repeat(Math.max(0, width - body.length)) + body;
    } else {
      out += line;
    }
    out += '\n';
    line = '';
  };

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];

    if (b === GS && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      // GS v 0 — raster: lewati header 8 byte + seluruh data gambar
      const widthBytes = buf[i + 4] | (buf[i + 5] << 8);
      const height = buf[i + 6] | (buf[i + 7] << 8);
      line += '[ LOGO ]';
      flush();
      i += 8 + widthBytes * height - 1;
      continue;
    }

    if (b === ESC) {
      const n = buf[i + 1];
      if (n === 0x40) { i += 1; continue; }                        // ESC @
      if (n === 0x61) { align = buf[i + 2] || 0; i += 2; continue; } // ESC a n
      if (n === 0x74 || n === 0x45 ||
          n === 0x2d || n === 0x64) { i += 2; continue; }           // ESC t/E/-/d n
      i += 1; continue;
    }

    if (b === GS) {
      const n = buf[i + 1];
      if (n === 0x21) { i += 2; continue; }                         // GS ! n
      if (n === 0x56) { i += 3; continue; }                         // GS V m n
      i += 1; continue;
    }

    if (b === 0x0a) { flush(); continue; }                          // LF
    line += String.fromCharCode(b);
  }

  if (line) flush();
  return out;
}

module.exports = {
  buildInvoiceReceipt,
  buildLogoRaster,
  toPlainText,
  ascii,
  formatRp,
  terbilang,
  wrapText,
  PROFILES,
  CMD
};
