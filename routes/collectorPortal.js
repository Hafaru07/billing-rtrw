const express = require('express');
const router = express.Router();
const { getSetting, getCurrentDateInTimezone, getSettings, formatDateLocal, getNowLocal, formatTimeLocal, parseDateInTimezone } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const billingSvc = require('../services/billingService');
const customerSvc = require('../services/customerService');
const adminSvc = require('../services/adminService');
const attendanceSvc = require('../services/attendanceService');
const invoicePrint = require('./invoicePrint');
const { sendPaymentSuccessWA, alasanText } = require('../services/paymentNotifyService');
const { uploadAttendance, removeAttendanceFile } = require('../middleware/attendanceUpload');

function requireCollectorSession(req, res, next) {
  if (req.session && req.session.isCollector && req.session.collectorId) return next();
  return res.redirect('/collector/login');
}

/**
 * Apakah kolektor ini boleh menyentuh tagihan tersebut?
 *
 * Memakai batasan yang PERSIS sama dengan daftar tagihan di dasbor kolektor
 * (`c.collector_id = ? OR c.collector_id IS NULL`). Tanpa pemeriksaan ini,
 * menebak angka pada URL cukup untuk membuka struk pelanggan kolektor lain.
 */
function collectorCanAccessInvoice(collectorId, invoiceId) {
  return !!db.prepare(`
    SELECT 1
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ? AND (c.collector_id = ? OR c.collector_id IS NULL)
  `).get(Number(invoiceId), Number(collectorId));
}

/** Middleware: tolak tagihan di luar wilayah kolektor. */
function requireInvoiceInScope(req, res, next) {
  if (collectorCanAccessInvoice(req.session.collectorId, req.params.id)) return next();
  return res.status(404).send('Tagihan tidak ditemukan');
}

/**
 * Tujuan tombol "Kembali" pada halaman cetak.
 *
 * Hanya menerima alamat di dalam portal kolektor — parameter ?back= berasal
 * dari URL, jadi tanpa pembatasan ini halaman cetak bisa dipakai mengarahkan
 * kolektor ke situs luar.
 */
function safeCollectorBack(raw) {
  const candidate = String(raw || '').trim();
  if (!candidate.startsWith('/collector')) return '/collector';
  if (candidate.startsWith('//')) return '/collector';
  return candidate;
}

/**
 * Susun ulang filter daftar tagihan dari form yang dikirim.
 * Dipakai agar kolektor kembali ke halaman yang sama persis setelah beraksi.
 * @returns {string} '?month=9&year=2026...' atau '' bila tidak ada filter
 */
function buildListQuery(req) {
  const qs = new URLSearchParams();
  for (const key of ['month', 'year', 'status', 'search']) {
    if (req.body && req.body[key]) qs.set(key, String(req.body[key]));
  }
  const s = qs.toString();
  return s ? '?' + s : '';
}

function company() {
  return getSetting('company_header', 'ISP App');
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

router.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.settings = getSettings();
  res.locals.formatDateLocal = formatDateLocal;
  res.locals.formatTimeLocal = formatTimeLocal;
  res.locals.parseDateInTimezone = parseDateInTimezone;
  res.locals.getNowLocal = getNowLocal;
  next();
});

const { loginRateLimiter } = require('../middleware/rateLimiter');
const { formatPeriod, formatPeriodList } = require('../utils/periodFormat');

router.get('/login', (req, res) => {
  if (req.session && req.session.isCollector) return res.redirect('/collector');
  res.render('collector/login', { title: 'Login Kolektor', company: company(), error: null });
});

router.post('/login', loginRateLimiter, express.urlencoded({ extended: true }), (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const collector = adminSvc.authenticateCollector(username, password);
  if (collector) {
    req.session.isCollector = true;
    req.session.collectorId = collector.id;
    req.session.collectorName = collector.name;
    req.session.collectorUsername = collector.username;
    return res.redirect('/collector');
  }
  return res.render('collector/login', { title: 'Login Kolektor', company: company(), error: 'Username atau password salah!' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/collector/login');
});

// ─── COLLECTOR ATTENDANCE ────────────────────────────────────────────────────
router.get('/attendance', requireCollectorSession, (req, res) => {
  try {
    const collectorId = req.session.collectorId;
    const collectorName = req.session.collectorName;
    
    const todayAttendance = attendanceSvc.getTodayAttendance('collector', collectorId);
    const history = attendanceSvc.getAttendanceHistory('collector', collectorId, 10);
    
    const now = getCurrentDateInTimezone();
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      'collector', 
      collectorId, 
      now.getFullYear(), 
      now.getMonth() + 1
    );
    
    res.render('collector/attendance', {
      title: 'Absensi',
      company: company(),
      activePage: 'attendance',
      collectorName,
      todayAttendance,
      history,
      summary,
      msg: flashMsg(req)
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memuat absensi: ' + e.message };
    res.redirect('/collector');
  }
});

router.post('/attendance/checkin', requireCollectorSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const collectorId = req.session.collectorId;
    const collectorName = req.session.collectorName;

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-in wajib diunggah' });
    }
    
    const today = attendanceSvc.getTodayAttendance('collector', collectorId);
    if (today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah melakukan check-in hari ini' });
    }
    
    const result = attendanceSvc.checkIn({
      employee_type: 'collector',
      employee_id: collectorId,
      employee_name: collectorName,
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: 'Check-in berhasil!', id: result.lastInsertRowid });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-in: ' + e.message });
  }
});

router.post('/attendance/checkout', requireCollectorSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const collectorId = req.session.collectorId;

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-out wajib diunggah' });
    }
    
    const today = attendanceSvc.getTodayAttendance('collector', collectorId);
    if (!today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda belum check-in hari ini' });
    }
    
    if (today.status === 'checked_out') {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah check-out hari ini' });
    }
    
    attendanceSvc.checkOut(today.id, {
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: 'Check-out berhasil!' });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-out: ' + e.message });
  }
});

router.get('/', requireCollectorSession, (req, res) => {
  const now = new Date();
  const month = Math.max(1, Math.min(12, parseInt(req.query.month || (now.getMonth() + 1), 10) || (now.getMonth() + 1)));
  const year = parseInt(req.query.year || now.getFullYear(), 10) || now.getFullYear();
  const status = String(req.query.status || 'unpaid').trim() || 'unpaid'; // unpaid, paid, all
  const search = String(req.query.search || '').trim();
  const scope = String(req.query.scope || '').trim(); // today, unpaid, isolir
  const todayDay = now.getDate();

  const collectorId = Number(req.session.collectorId || 0);
  
  let q = `
    SELECT i.*,
           c.name as customer_name,
           c.phone as customer_phone,
           c.address as customer_address,
           c.pppoe_username,
           c.genieacs_tag,
           c.connection_type,
           c.static_ip,
           c.status as customer_status,
           c.install_date,
           c.isolate_day,
           c.lat, c.lng,
           p.name as package_name,
           r.name as router_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    WHERE (c.collector_id = ? OR c.collector_id IS NULL)
  `;
  const params = [collectorId];
  if (scope !== 'multi') {
    q += ' AND i.period_month=? AND i.period_year=?';
    params.push(month, year);
  }
  if (scope === 'today') {
    q += ' AND c.isolate_day = ?';
    params.push(todayDay);
  } else if (scope === 'isolir') {
    q += " AND c.status = 'suspended'";
  } else if (scope === 'multi') {
    q += `
      AND i.status='unpaid'
      AND i.customer_id IN (
        SELECT customer_id FROM invoices
        WHERE status='unpaid'
        GROUP BY customer_id
        HAVING COUNT(1) > 1
      )
    `;
  }
  if (status !== 'all') {
    q += ' AND i.status=?';
    params.push(status);
  }
  if (search) {
    q += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ? OR c.pppoe_username LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  q += ' ORDER BY c.name ASC, i.id DESC LIMIT 500';
  const list = db.prepare(q).all(...params);

  const summaryPeriod = db.prepare(`
    SELECT
      SUM(CASE WHEN i.status='unpaid' THEN 1 ELSE 0 END) as unpaid_count,
      SUM(CASE WHEN i.status='unpaid' THEN i.amount ELSE 0 END) as unpaid_total,
      SUM(CASE WHEN i.status='unpaid' AND c.isolate_day=? THEN 1 ELSE 0 END) as today_count,
      SUM(CASE WHEN i.status='unpaid' AND c.isolate_day=? THEN i.amount ELSE 0 END) as today_total,
      SUM(CASE WHEN i.status='unpaid' AND c.status='suspended' THEN 1 ELSE 0 END) as isolir_count,
      SUM(CASE WHEN i.status='unpaid' AND c.status='suspended' THEN i.amount ELSE 0 END) as isolir_total
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    WHERE (c.collector_id = ? OR c.collector_id IS NULL)
      AND i.period_month=? AND i.period_year=?
  `).get(todayDay, todayDay, collectorId, month, year) || {};

  const summaryMulti = db.prepare(`
    SELECT
      COUNT(1) as multi_customer_count,
      SUM(x.cnt) as multi_invoice_count,
      SUM(x.total_amount) as multi_total
    FROM (
      SELECT i.customer_id, COUNT(1) as cnt, SUM(i.amount) as total_amount
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      WHERE i.status='unpaid'
        AND (c.collector_id = ? OR c.collector_id IS NULL)
      GROUP BY i.customer_id
      HAVING COUNT(1) > 1
    ) x
  `).get(collectorId) || {};

  const summary = { ...summaryPeriod, ...summaryMulti };

  const invoiceIds = list.map(i => Number(i?.id || 0)).filter(n => Number.isFinite(n) && n > 0);
  const pendingMap = new Map();
  if (invoiceIds.length > 0) {
    const placeholders = invoiceIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT r.*
      FROM collector_payment_requests r
      WHERE r.invoice_id IN (${placeholders})
      ORDER BY r.id DESC
    `).all(...invoiceIds);
    for (const r of rows) {
      const invId = Number(r.invoice_id || 0);
      if (!pendingMap.has(invId)) pendingMap.set(invId, r);
    }
  }

  const myReqs = db.prepare(`
    SELECT r.*, i.period_month, i.period_year, i.amount as invoice_amount, c.name as customer_name, c.phone as customer_phone
    FROM collector_payment_requests r
    JOIN invoices i ON i.id = r.invoice_id
    JOIN customers c ON c.id = r.customer_id
    WHERE r.collector_id = ?
    ORDER BY r.id DESC
    LIMIT 60
  `).all(collectorId);

  res.render('collector/dashboard', {
    title: 'Dashboard Kolektor',
    company: company(),
    month,
    year,
    status,
    search,
    scope,
    todayDay,
    summary,
    invoices: list,
    pendingMap,
    myReqs,
    msg: flashMsg(req)
  });
});

// ─── CETAK INVOICE / STRUK DI LAPANGAN ──────────────────────────────────────
// Kolektor menagih di depan pelanggan, jadi struk harus bisa dicetak dari HP
// tanpa harus login sebagai admin. Halaman & data ESC/POS-nya sama persis
// dengan milik admin (routes/invoicePrint.js).

router.get('/invoice/:id/print', requireCollectorSession, requireInvoiceInScope, (req, res) => {
  // Hasil notifikasi WhatsApp dibawa lewat ?wa= dari tombol Ajukan, supaya
  // kolektor melihatnya di halaman cetak — bukan baru setelah menekan Kembali.
  const wa = String(req.query.wa || '').trim();
  let notice = null;
  if (wa === 'ok') {
    notice = { type: 'ok', text: 'Konfirmasi WhatsApp terkirim ke pelanggan.' };
  } else if (wa) {
    notice = {
      type: 'warn',
      text: `Konfirmasi WhatsApp TIDAK terkirim (${alasanText(wa)}). ` +
            `Tagihan tetap tercatat LUNAS — serahkan struk cetak sebagai bukti.`
    };
  }

  return invoicePrint.renderPrintPage(req, res, {
    basePath: '/collector/invoice',
    backUrl: safeCollectorBack(req.query.back),
    notice
  });
});

router.get('/invoice/:id/escpos', requireCollectorSession, requireInvoiceInScope, invoicePrint.sendEscpos);

router.post('/payment-request', requireCollectorSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const invoiceId = Number(req.body.invoice_id || 0);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) throw new Error('Invoice ID tidak valid');
    const note = String(req.body.note || '').trim();

    const inv = billingSvc.getInvoiceById(invoiceId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status || '').toLowerCase() === 'paid') throw new Error('Tagihan sudah lunas');

    // Batas wilayah yang sama dengan daftar tagihan di dasbor. Tanpa ini,
    // mengirim invoice_id apa pun lewat form cukup untuk melunasi tagihan
    // pelanggan kolektor lain — dan pada auto-approve, uangnya langsung
    // tercatat atas nama kolektor yang mengirim.
    if (!collectorCanAccessInvoice(req.session.collectorId, invoiceId)) {
      throw new Error('Tagihan ini di luar wilayah tagih Anda');
    }

    const existingPending = db.prepare(`
      SELECT id FROM collector_payment_requests
      WHERE invoice_id = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 1
    `).get(invoiceId);
    if (existingPending) throw new Error('Tagihan ini sudah pernah diajukan dan masih menunggu approval');

    const collectorId = Number(req.session.collectorId || 0);
    const amount = Math.max(0, Number(inv.amount || 0) || 0);
    if (amount <= 0) throw new Error('Nominal tagihan tidak valid');

    // Check if auto-approve is enabled for this collector
    const collector = db.prepare('SELECT auto_approve FROM collectors WHERE id = ?').get(collectorId);
    const autoApproveEnabled = collector && collector.auto_approve === 1;

    if (autoApproveEnabled) {
      // Auto-approve: directly mark invoice as paid
      const collectorName = String(req.session.collectorName || '').trim();
      const collectorUsername = String(req.session.collectorUsername || '').trim();
      const collectorLabel = `Kolektor ${collectorName}${collectorUsername ? ` (@${collectorUsername})` : ''}`;
      
      const notesParts = [
        'Via Kolektor',
        collectorLabel,
        'Auto-Approved (Kolektor Setting Aktif)'
      ];
      if (note) notesParts.push(note);
      const notes = notesParts.join(' | ');

      // Mark invoice as paid
      billingSvc.markAsPaid(invoiceId, collectorLabel, notes);

      // Insert request with approved status
      db.prepare(`
        INSERT INTO collector_payment_requests (collector_id, invoice_id, customer_id, amount, note, status, decided_by_role, decided_by_name, decided_note, decided_at)
        VALUES (?, ?, ?, ?, ?, 'approved', 'system', 'Auto-Approve', 'Otomatis disetujui (kolektor setting aktif)', CURRENT_TIMESTAMP)
      `).run(collectorId, invoiceId, Number(inv.customer_id || 0), amount, note);

      // Notifikasi WhatsApp ke pelanggan.
      //
      // Sebelumnya blok ini memanggil `require('../services/whatsappBot.mjs')`
      // lalu `waBot.sendMessage(...)`. Keduanya salah: berkas itu ES module
      // (require() padanya melempar ERR_REQUIRE_ESM) dan fungsi yang ada
      // bernama `sendWA`, bukan `sendMessage`. Error-nya ditelan catch, jadi
      // notifikasi ini TIDAK PERNAH terkirim sejak awal.
      //
      // Sekarang memakai service bersama, sehingga pesannya identik dengan
      // yang dikirim saat admin/kasir menyetujui pembayaran.
      const customer = customerSvc.getCustomerById(inv.customer_id);
      const notif = await sendPaymentSuccessWA(
        customer && customer.phone,
        customer && customer.name,
        formatPeriod(inv.period_month, inv.period_year),
        Number(inv.amount || 0).toLocaleString('id-ID'),
        collectorLabel,
        'kolektor auto-approve'
      );

      // Buka isolir bila seluruh tagihan pelanggan sudah lunas.
      //
      // Jalur approval admin sudah melakukan ini; jalur auto-approve belum —
      // akibatnya pelanggan terisolir yang membayar tunai ke kolektor tetap
      // terputus meski tagihannya sudah ditandai lunas.
      try {
        const fresh = customerSvc.getAllCustomers().find(x => Number(x.id) === Number(inv.customer_id));
        if (fresh && fresh.status === 'suspended' && Number(fresh.unpaid_count) === 0) {
          await customerSvc.activateCustomer(inv.customer_id);
          logger.info(`[Kolektor] Isolir dibuka untuk ${fresh.name} — semua tagihan lunas.`);
        }
      } catch (e) {
        // Pembayarannya sudah sah dan tersimpan; kegagalan membuka isolir
        // tidak boleh membatalkan itu. Admin bisa membuka manual.
        logger.error(`[Kolektor] Gagal membuka isolir invoice ${invoiceId}: ${e.message}`);
      }

      // Hasil notifikasi ikut ditampilkan. Kolektor sedang berdiri di depan
      // pelanggan — kalau pesannya tidak terkirim, dia harus tahu SEKARANG,
      // bukan setelah pelanggan menelepon karena tidak menerima konfirmasi.
      const namaPelanggan = (customer && customer.name) || 'pelanggan';
      req.session._msg = notif.ok
        ? {
            type: 'success',
            text: `Tagihan ${formatPeriod(inv.period_month, inv.period_year)} atas nama ` +
                  `${namaPelanggan} sudah LUNAS. Konfirmasi WhatsApp terkirim.`
          }
        : {
            type: 'warning',
            text: `Tagihan ${formatPeriod(inv.period_month, inv.period_year)} atas nama ` +
                  `${namaPelanggan} sudah LUNAS, tetapi konfirmasi WhatsApp TIDAK terkirim ` +
                  `(${alasanText(notif.reason)}). Struk tetap bisa dicetak.`
          };

      // Langsung ke halaman cetak supaya kolektor bisa menyerahkan struk di
      // tempat, tanpa harus mencari tagihannya lagi di daftar.
      const back = '/collector' + buildListQuery(req);
      return res.redirect(
        `/collector/invoice/${invoiceId}/print?format=thermal` +
        `&back=${encodeURIComponent(back)}` +
        `&wa=${encodeURIComponent(notif.ok ? 'ok' : notif.reason)}`
      );
    } else {
      // Manual approval: insert as pending
      db.prepare(`
        INSERT INTO collector_payment_requests (collector_id, invoice_id, customer_id, amount, note, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(collectorId, invoiceId, Number(inv.customer_id || 0), amount, note);

      req.session._msg = { type: 'success', text: 'Berhasil. Status pembayaran menunggu approval Admin/Kasir.' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('/collector' + buildListQuery(req));
});

module.exports = router;
