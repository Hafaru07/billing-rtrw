/**
 * QRIS SERVICE — sumber kebenaran tunggal untuk pembuatan QR dinamis.
 *
 * Logika yang sama sebelumnya tersalin di app-customer.js, routes/adminPortal.js,
 * dan routes/customerPortal.js. Perbaikan pada satu tempat tidak ikut ke tempat
 * lain, sehingga rawan perilaku berbeda-beda. Modul ini menyatukannya.
 *
 * Konsep singkat:
 *   QRIS STATIS  = nominal kosong, pembeli mengetik sendiri jumlahnya.
 *   QRIS DINAMIS = nominal sudah tertanam di dalam kode QR, tinggal scan.
 *
 * Nominal ditanam pada tag EMV "54". Karena isi payload berubah, checksum
 * CRC pada tag "63" WAJIB dihitung ulang — kalau tidak, QR akan ditolak
 * aplikasi pembayaran.
 */
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
// PENTING: jimp v1.x mengekspor OBJEK ({ Jimp, JimpMime, ... }), bukan kelas.
// Menulis `const Jimp = require('jimp')` seperti gaya v0.x membuat Jimp.read
// menjadi undefined dan setiap pemakaian melempar TypeError.
const { Jimp, JimpMime } = require('jimp');
const { logger } = require('../config/logger');

/** Bersihkan payload: buang spasi/baris baru dan potong tepat setelah CRC. */
function normalizeQrisPayload(raw) {
  let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
  const idx = s.indexOf('000201');
  if (idx > 0) s = s.slice(idx);
  const lastCrc = s.lastIndexOf('6304');
  if (lastCrc >= 0 && s.length >= lastCrc + 8) s = s.slice(0, lastCrc + 8);
  return s;
}

/** CRC-16/CCITT-FALSE — algoritma checksum yang diwajibkan standar QRIS. */
function crc16CcittFalse(input) {
  const s = String(input || '');
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= (s.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function parseEmvTlvString(input) {
  const raw = String(input || '').replace(/[\r\n\t]+/g, '').trim();
  if (!raw) throw new Error('QRIS payload kosong');
  if (raw.length < 8) throw new Error('QRIS payload terlalu pendek');
  const items = [];
  let i = 0;
  while (i < raw.length) {
    if (i + 4 > raw.length) throw new Error('QRIS payload TLV tidak valid');
    const tag = raw.slice(i, i + 2);
    const lenStr = raw.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(lenStr)) throw new Error('QRIS payload TLV length tidak valid');
    const len = Number(lenStr);
    const end = i + 4 + len;
    if (end > raw.length) throw new Error('QRIS payload TLV length melebihi data');
    items.push({ tag, value: raw.slice(i + 4, end) });
    i = end;
  }
  return items;
}

function buildEmvTlvString(items) {
  let out = '';
  for (const it of (Array.isArray(items) ? items : [])) {
    const tag = String(it?.tag || '');
    const value = String(it?.value ?? '');
    if (!/^\d{2}$/.test(tag)) throw new Error('Tag TLV tidak valid');
    if (value.length > 99) throw new Error('TLV length > 99 tidak didukung');
    out += tag + String(value.length).padStart(2, '0') + value;
  }
  return out;
}

/**
 * Ubah QRIS statis menjadi dinamis dengan nominal tertanam.
 * Tag 01 diset "12" (sekali pakai) dan CRC dihitung ulang.
 */
function convertStaticQrisToDynamic(staticPayload, amount) {
  const amt = Math.max(0, Math.floor(Number(amount || 0) || 0));
  if (!amt) throw new Error('Nominal QRIS dinamis tidak valid');

  const source = parseEmvTlvString(staticPayload)
    .filter(x => x && x.tag)
    .map(x => ({ tag: String(x.tag), value: String(x.value ?? '') }));

  const managed = new Set(['54', '55', '56', '57', '63']);
  const result = [];
  let amountInserted = false;

  for (const el of source) {
    if (managed.has(el.tag)) continue;
    if (el.tag === '01') { result.push({ tag: '01', value: '12' }); continue; }
    if (el.tag === '58' && !amountInserted) {
      result.push({ tag: '54', value: String(amt) });
      amountInserted = true;
    }
    result.push(el);
  }
  if (!amountInserted) result.push({ tag: '54', value: String(amt) });

  const partial = buildEmvTlvString(result) + '6304';
  return partial + crc16CcittFalse(partial).toString(16).toUpperCase().padStart(4, '0');
}

// Cache hasil pembacaan QR dari berkas gambar (mahal), dikunci nama + waktu ubah.
let _decodedCache = { file: '', mtimeMs: 0, payload: '' };

/**
 * Baca payload QRIS dari gambar yang di-upload admin, bila admin tidak
 * mengisi teks payload secara manual di Pengaturan.
 */
async function decodeQrisPayloadFromImage(qrisQrUrl) {
  const m = String(qrisQrUrl || '').match(/^\/uploads\/qris\/([^/?#]+)$/i);
  if (!m || !m[1]) return '';

  const safeName = path.basename(String(m[1]));
  const filePath = path.join(__dirname, '../public/uploads/qris', safeName);

  let st = null;
  try { st = await fs.promises.stat(filePath); } catch { return ''; }

  if (_decodedCache.file === safeName && _decodedCache.mtimeMs === st.mtimeMs && _decodedCache.payload) {
    return _decodedCache.payload;
  }

  try {
    const buf = await fs.promises.readFile(filePath);
    // Jimp v1.x: Jimp.read() tetap ada, tapi harus diambil dari objek ekspor
    const img = await Jimp.read(buf);
    const { width, height } = img.bitmap;

    // Dua pembaca dicoba berurutan. jsQR lebih toleran terhadap foto QR yang
    // agak miring/buram (kasus umum saat admin memotret QRIS), sementara
    // @zxing kadang berhasil pada gambar yang tidak terbaca jsQR.
    let text = '';

    try {
      const jsQR = require('jsqr');
      const rgba = new Uint8ClampedArray(img.bitmap.data);
      const res = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
      if (res && res.data) text = res.data;
    } catch (e) { /* lanjut ke pembaca kedua */ }

    if (!text) {
      try {
        const { MultiFormatReader, BarcodeFormat, RGBLuminanceSource, BinaryBitmap,
                HybridBinarizer, DecodeHintType } = require('@zxing/library');
        const rgba = new Uint8ClampedArray(img.bitmap.data);
        const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(rgba, width, height)));
        const reader = new MultiFormatReader();
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        reader.setHints(hints);
        const decoded = reader.decode(bitmap);
        text = typeof decoded?.getText === 'function' ? decoded.getText() : String(decoded?.text || '');
      } catch (e) { /* keduanya gagal */ }
    }

    if (!text) {
      logger.warn(`[QRIS] QR pada gambar ${safeName} tidak terbaca. Sebaiknya isi "Payload QRIS" berupa teks di Pengaturan.`);
      return '';
    }

    const payload = normalizeQrisPayload(text);
    if (!payload) return '';
    _decodedCache = { file: safeName, mtimeMs: st.mtimeMs, payload };
    return payload;
  } catch (e) {
    logger.warn(`[QRIS] Gagal membaca QR dari gambar ${safeName}: ${e.message}`);
    return '';
  }
}

/**
 * Ambil payload QRIS statis milik merchant: utamakan teks payload di
 * Pengaturan, kalau kosong coba baca dari gambar QRIS yang di-upload.
 */
async function resolveMerchantPayload(settings) {
  const s = settings || {};
  const fromSetting = normalizeQrisPayload(s.qris_static_payload);
  if (fromSetting) return fromSetting;
  return await decodeQrisPayloadFromImage(String(s.qris_static_qr_url || '').trim());
}

/** Apakah QRIS aktif dan datanya tersedia untuk dipakai? */
function isQrisEnabled(settings) {
  const s = settings || {};
  const raw = s.qris_static_enabled;
  const enabled = !(raw === false || raw === 'false' || raw === 0 || raw === '0');
  const hasData = !!String(s.qris_static_payload || '').trim() || !!String(s.qris_static_qr_url || '').trim();
  return enabled && hasData;
}

/**
 * Hasilkan gambar QR dinamis siap kirim ke WhatsApp.
 *
 * Sengaja menghasilkan PNG langsung dari pustaka QRCode tanpa konversi ke
 * JPEG. Alasannya:
 *  - PNG bersifat lossless; kompresi JPEG menimbulkan artefak pada pola
 *    hitam-putih tajam sehingga QR lebih rawan gagal dipindai.
 *  - Ukurannya jauh lebih kecil (~1,7 KB vs ~22 KB untuk QR yang sama).
 *  - Menghilangkan satu langkah pengolahan gambar, satu sumber kegagalan.
 * WhatsApp menerima PNG tanpa masalah.
 *
 * @returns {Promise<Buffer|null>} null bila QRIS belum siap dipakai
 */
async function buildDynamicQrisImage(settings, amount) {
  try {
    if (!isQrisEnabled(settings)) {
      logger.warn('[QRIS] Dilewati: QRIS belum diaktifkan / payload & gambar belum diatur di Pengaturan.');
      return null;
    }
    const payload = await resolveMerchantPayload(settings);
    if (!payload) {
      logger.warn('[QRIS] Dilewati: payload merchant tidak terbaca (isi "Payload QRIS" di Pengaturan, atau unggah gambar QRIS yang jelas).');
      return null;
    }

    const dynamic = convertStaticQrisToDynamic(payload, amount);
    return await QRCode.toBuffer(dynamic, {
      errorCorrectionLevel: 'M', margin: 2, width: 512, type: 'png'
    });
  } catch (e) {
    logger.error(`[QRIS] Gagal membuat QR dinamis (nominal ${amount}): ${e.message}`);
    return null;
  }
}

// Nama lama dipertahankan agar pemanggil yang belum diperbarui tetap jalan.
const buildDynamicQrisJpg = buildDynamicQrisImage;

module.exports = {
  normalizeQrisPayload,
  crc16CcittFalse,
  parseEmvTlvString,
  buildEmvTlvString,
  convertStaticQrisToDynamic,
  decodeQrisPayloadFromImage,
  resolveMerchantPayload,
  isQrisEnabled,
  buildDynamicQrisImage,
  buildDynamicQrisJpg
};
