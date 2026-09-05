/**
 * CETAK INVOICE — HANDLER BERSAMA ADMIN & KOLEKTOR
 * ---------------------------------------------------------------------------
 * Invoice yang sama bisa dicetak dari panel admin maupun dari HP kolektor di
 * depan pelanggan. Bila masing-masing portal menyiapkan datanya sendiri,
 * cepat atau lambat keduanya berbeda — dan struk kolektor yang tidak sama
 * dengan invoice admin adalah masalah kepercayaan, bukan sekadar bug tampilan.
 *
 * Modul ini menjadi satu-satunya jalur penyiapan halaman cetak dan data
 * ESC/POS. Yang membedakan antar portal hanya alamat tautan (`basePath`) dan
 * pemeriksaan hak akses, yang tetap menjadi tanggung jawab masing-masing
 * router pemanggil.
 */
const billingSvc = require('../services/billingService');
const customerSvc = require('../services/customerService');
const invoiceRenderSvc = require('../services/invoiceRenderService');
const escposSvc = require('../services/escposService');
const { getSettings, getNowLocal, formatDateLocal } = require('../config/settingsManager');
const { logger } = require('../config/logger');

/**
 * Ambil invoice + pelanggan sekaligus.
 * @returns {{inv:object, customer:object}|null}
 */
function loadInvoice(invoiceId) {
  const inv = billingSvc.getInvoiceById(invoiceId);
  if (!inv) return null;
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return null;
  return { inv, customer };
}

/** Nomor invoice yang tampil di semua dokumen: INV-YYYYMM-00042 */
function invoiceNumber(inv) {
  return 'INV-' + inv.period_year +
         String(inv.period_month).padStart(2, '0') + '-' +
         String(inv.id).padStart(5, '0');
}

/**
 * Render halaman cetak invoice (A4 atau struk termal).
 *
 * @param {object} req
 * @param {object} res
 * @param {object} opts
 * @param {string} opts.basePath alamat dasar portal pemanggil, mis.
 *        '/admin/billing' atau '/collector/invoice'. Dipakai halaman termal
 *        untuk memanggil endpoint ESC/POS dan berpindah ke tampilan A4.
 * @param {string} opts.backUrl  tujuan tombol "Kembali"
 * @param {{type:string, text:string}} [opts.notice] pesan yang perlu dilihat
 *        petugas saat halaman terbuka, mis. hasil pengiriman notifikasi
 *        WhatsApp setelah pembayaran dicatat.
 */
function renderPrintPage(req, res, opts) {
  const found = loadInvoice(req.params.id);
  if (!found) return res.status(404).send('Tagihan tidak ditemukan');
  const { inv, customer } = found;

  const settings = getSettings();
  const company = settings.company_header || 'ALIJAYA DIGITAL NETWORK';

  // Struk termal 58mm/80mm (printer kasir & printer Bluetooth kolektor)
  if (String(req.query.format || '').toLowerCase() === 'thermal') {
    return res.render('admin/print_invoice_thermal', {
      invoice: inv,
      customer,
      company,
      settings,
      basePath: opts.basePath,
      backUrl: opts.backUrl,
      notice: opts.notice || null
    });
  }

  // Detail paket untuk badge kecepatan (speed_down tidak ikut di getCustomerById)
  let pkg = null;
  try {
    if (customer.package_id) pkg = customerSvc.getPackageById(customer.package_id);
  } catch (e) { /* opsional, invoice tetap tercetak tanpa ini */ }

  return res.render('admin/print_invoice', {
    invoice: inv,
    customer,
    pkg,
    company,
    settings,
    breakdown: invoiceRenderSvc.buildInvoiceLines(inv),
    dueInfo: invoiceRenderSvc.buildDueInfo(inv, customer),
    verifyCode: invoiceRenderSvc.invoiceVerifyCode(inv),
    issuedToCustomer: false,
    basePath: opts.basePath,
    backUrl: opts.backUrl,
    notice: opts.notice || null
  });
}

/**
 * Data cetak ESC/POS untuk printer thermal.
 *
 * Nominal & rincian dihitung ulang lewat invoiceRenderService yang sama dengan
 * invoice A4, supaya struk termal tidak pernah berbeda angka dengan invoice
 * yang dicetak admin.
 *
 * ?width=80|58   lebar kertas
 * ?logo=0        tanpa logo
 * ?raw=1         unduh biner mentah (untuk penelusuran masalah)
 */
async function sendEscpos(req, res) {
  try {
    const found = loadInvoice(req.params.id);
    if (!found) return res.status(404).json({ ok: false, error: 'Tagihan tidak ditemukan' });
    const { inv, customer } = found;

    const width = req.query.width === '58' ? '58' : '80';

    const buf = await escposSvc.buildInvoiceReceipt({
      invoice: inv,
      customer,
      settings: getSettings(),
      breakdown: invoiceRenderSvc.buildInvoiceLines(inv),
      dueInfo: invoiceRenderSvc.buildDueInfo(inv, customer),
      verifyCode: invoiceRenderSvc.invoiceVerifyCode(inv),
      width,
      logo: req.query.logo !== '0',
      // Tanggal dibentuk di sini, bukan di dalam service: formatnya harus
      // sama persis dengan yang tampil di invoice A4.
      printedAt: getNowLocal(),
      paidAtText: inv.paid_at ? formatDateLocal(inv.paid_at) : ''
    });

    const invNo = invoiceNumber(inv);

    if (req.query.raw === '1') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${invNo}.bin"`);
      return res.send(buf);
    }

    const cols = escposSvc.PROFILES[width].cols;

    return res.json({
      ok: true,
      invoiceNo: invNo,
      bytes: buf.length,
      cols,
      preview: escposSvc.toPlainText(buf, cols),
      b64: buf.toString('base64')
    });
  } catch (e) {
    logger.error(`[escpos] Gagal menyusun struk invoice ${req.params.id}: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { renderPrintPage, sendEscpos, loadInvoice, invoiceNumber };
