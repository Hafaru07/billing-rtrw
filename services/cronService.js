/**
 * Service: Penjadwalan Tugas Otomatis (Cron)
 */
const cron = require('node-cron');
const billingSvc = require('./billingService');
const { logger } = require('../config/logger');

const customerSvc = require('./customerService');
const mikrotikService = require('./mikrotikService');
const usageSvc = require('./usageService');
const fupSvc = require('./fupService');
const { getSetting, getSettings, getNowLocal, getCurrentDateInTimezone } = require('../config/settingsManager');
const db = require('../config/database');
const qrisSvc = require('./qrisService');
const { pickQrisUniqueAmount } = require('../utils/qrisUnique');
const { formatPeriod, formatPeriodList, formatDateLong } = require('../utils/periodFormat');

// ─── KONFIGURASI TERKUNCI: PENGINGAT TAGIHAN OTOMATIS ──────────────────────
// Nilai di bawah ini SENGAJA di-hardcode dan tidak dapat diubah dari panel
// admin, supaya perilaku anti-spam WhatsApp tidak bisa dilonggarkan tanpa
// sadar (risiko akun WhatsApp di-banned oleh Meta).

/** Jam pengiriman pengingat tagihan (waktu lokal sesuai CRON_TIMEZONE). */
const REMINDER_CRON = '0 7 * * *'; // setiap hari pukul 07:00

/**
 * Penyapu lanjutan: tiap 30 menit antara 07:00-21:30. Melanjutkan pengiriman
 * yang terpotong restart, atau yang tertunda karena WhatsApp sempat offline.
 * Nyaris selalu berakhir tanpa kerja (satu query ringan) bila semua sudah beres.
 */
const REMINDER_RESUME_CRON = '*/30 7-21 * * *';

/** Pengaman harian: pastikan tagihan bulan berjalan sudah dibuat. */
const INVOICE_SAFETY_CRON = '30 0 * * *'; // setiap hari pukul 00:30

/** Rentang jeda acak antar pesan: 30 - 120 detik. */
const REMINDER_DELAY_MIN_MS = 30 * 1000;
const REMINDER_DELAY_MAX_MS = 120 * 1000;

/**
 * Timezone untuk SEMUA cron. node-cron memakai timezone sistem operasi bila
 * opsi ini tidak diberikan — di VPS yang defaultnya UTC, '0 7 * * *' akan
 * jalan pukul 14:00 WIB. Karena itu timezone selalu diteruskan eksplisit.
 */
function cronTz() {
  return String(getSetting('timezone', 'Asia/Jakarta') || 'Asia/Jakarta');
}

function cronOpts() {
  return { timezone: cronTz() };
}

/**
 * Jeda acak antar pesan pengingat: 30-120 detik (terdistribusi merata).
 * Pola acak lebar seperti ini jauh lebih menyerupai perilaku manusia
 * dibanding jeda tetap, sehingga lebih aman dari deteksi spam.
 */
function getReminderDelay() {
  return Math.floor(Math.random() * (REMINDER_DELAY_MAX_MS - REMINDER_DELAY_MIN_MS + 1)) + REMINDER_DELAY_MIN_MS;
}

// Helper: Random delay generator untuk smart rate limiting (dipakai fitur lain)
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

/** Jumlah hari dalam bulan tertentu (month: 1-12). */
function daysInMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate();
}

/**
 * Hari-hari pengingat dikirim, dihitung mundur dari tanggal jatuh tempo.
 *
 * H-5 memberi pelanggan waktu menyiapkan dana, H-1 sebagai pengingat terakhir.
 * H-4 sampai H-2 sengaja dilewati supaya tidak terasa seperti spam.
 */
const REMINDER_DAYS_BEFORE = [5, 1];

/**
 * Cari tanggal jatuh tempo BERIKUTNYA untuk pelanggan.
 *
 * Tahan terhadap tanggal isolir yang beragam (karena tanggal pasang = tanggal
 * tagih):
 *  - isolate_day melebihi jumlah hari bulan ini (mis. 31 di Februari)
 *    -> digeser ke hari terakhir bulan tersebut.
 *  - bila jatuh tempo bulan ini sudah lewat, otomatis lompat ke bulan depan.
 *    Ini yang membuat isolate_day = 1 bekerja: pada akhir Agustus, jatuh
 *    temponya adalah 1 September, sehingga H-5 dan H-1 jatuh di akhir Agustus.
 *
 * @returns {Date|null} tengah malam pada tanggal jatuh tempo
 */
function resolveDueDate(dueDay, today) {
  const d = Number(dueDay);
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;

  const y = today.getFullYear();
  const m = today.getMonth();                       // 0-11
  const todayMid = new Date(y, m, today.getDate());

  // Kandidat bulan ini
  const lastThis = daysInMonth(y, m + 1);
  const dueThis = new Date(y, m, Math.min(d, lastThis));
  if (dueThis.getTime() >= todayMid.getTime()) return dueThis;

  // Sudah lewat -> pakai bulan berikutnya
  const nextY = m === 11 ? y + 1 : y;
  const nextM = m === 11 ? 0 : m + 1;
  const lastNext = daysInMonth(nextY, nextM + 1);
  return new Date(nextY, nextM, Math.min(d, lastNext));
}

/** Selisih hari penuh antara hari ini dan tanggal jatuh tempo. */
function daysUntilDue(dueDate, today) {
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const b = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Tahap pengingat untuk hari ini.
 *
 * @returns {{stage:number, dueDate:Date}|null} null bila hari ini bukan
 *          H-5 maupun H-1, sehingga pelanggan tidak dikirimi apa pun.
 */
function getReminderStage(dueDay, today) {
  const dueDate = resolveDueDate(dueDay, today);
  if (!dueDate) return null;
  const left = daysUntilDue(dueDate, today);
  if (!REMINDER_DAYS_BEFORE.includes(left)) return null;
  return { stage: left, dueDate };
}

/** Dipertahankan untuk pemanggil lama: cukup tahu perlu kirim atau tidak. */
function isReminderDay(dueDay, today) {
  return getReminderStage(dueDay, today) !== null;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Helper: Message variation untuk menghindari spam detection
/**
 * Buat tiap pesan sedikit berbeda supaya tidak terbaca sebagai kiriman massal
 * yang identik.
 *
 * Versi lama menempelkan tanda baca yang terlihat — "_", "•", "▪" — di akhir
 * pesan. Fungsinya jalan, tapi hasilnya muncul di layar pelanggan sebagai
 * karakter nyasar yang terlihat seperti salah ketik, dan justru menurunkan
 * kesan profesional yang ingin dijaga.
 *
 * Sekarang memakai ZERO WIDTH SPACE (U+200B): tidak tampak sama sekali di
 * WhatsApp, tetapi tetap mengubah isi pesan sehingga sidik jarinya berbeda.
 */
function addMessageVariation(message, index) {
  const ZWSP = '​';
  return message + ZWSP.repeat(index % 5);
}

/**
 * Isi variabel template pengingat.
 *
 * Dipakai jalur teks MAUPUN caption gambar QRIS, supaya satu template di panel
 * admin menghasilkan pesan yang sama bentuknya di kedua jalur.
 *
 * Variabel QRIS ({{qris_nominal}}, {{qris_kode}}, {{qris_qr}}) tetap dikenali
 * walau QRIS sedang mati — diganti tanda '-' atau dikosongkan, supaya template
 * yang memakainya tidak pernah menyisakan tulisan "{{qris_nominal}}" mentah di
 * layar pelanggan.
 */
function fillReminderTemplate(template, data) {
  const rupiah = (n) => Number(n || 0).toLocaleString('id-ID');

  const nilai = {
    nama: data.nama || 'Pelanggan',
    paket: data.paket || '-',
    tagihan: rupiah(data.tagihan),
    rincian: data.rincian || '-',
    periode: data.periode || data.rincian || '-',
    jatuhtempo: data.jatuhtempo || '-',
    link: data.link || '',
    qris_nominal: data.qrisAmount > 0 ? rupiah(data.qrisAmount) : '-',
    qris_kode: data.qrisCode > 0 ? String(data.qrisCode) : '-',
    qris_qr: data.qrisImageUrl || ''
  };

  let hasil = String(template || '');
  for (const [kunci, isi] of Object.entries(nilai)) {
    hasil = hasil.replace(new RegExp(`{{\\s*${kunci}\\s*}}`, 'gi'), isi);
  }

  // Jaring pengaman: variabel yang salah ketik di panel admin tidak boleh
  // bocor mentah-mentah ke pelanggan.
  const tersisa = hasil.match(/{{\s*[\w.]+\s*}}/g);
  if (tersisa) {
    logger.warn(`[CRON] Variabel tidak dikenal di template pengingat: ${[...new Set(tersisa)].join(', ')} — dikosongkan.`);
    hasil = hasil.replace(/{{\s*[\w.]+\s*}}/g, '');
  }

  return addMessageVariation(hasil, data.variationIndex || 0);
}

// ─── PENGINGAT TAGIHAN: PENANDA TERKIRIM & RESUME ──────────────────────────

/** Tanggal lokal hari ini dalam format 'YYYY-MM-DD' (mengikuti timezone setting). */
function localDateKey() {
  return getNowLocal().slice(0, 10);
}

/** Lock proses supaya jadwal 07:00 dan cron resume tidak saling tumpang tindih. */
let reminderRunning = false;

const REMINDER_MAX_ATTEMPTS = 3;

/** Pelanggan yang sudah tuntas diproses hari ini (terkirim, atau gagal sampai batas). */
function getSettledCustomerIds(dateKey) {
  const rows = db.prepare(`
    SELECT customer_id FROM billing_reminder_logs
    WHERE reminder_date = ? AND (status = 'sent' OR attempts >= ?)
  `).all(dateKey, REMINDER_MAX_ATTEMPTS);
  return new Set(rows.map(r => Number(r.customer_id)));
}

/** Catat hasil kirim. UNIQUE(customer_id, reminder_date) membuat ini idempoten. */
function markReminder(customerId, dateKey, status, phone, error) {
  db.prepare(`
    INSERT INTO billing_reminder_logs (customer_id, reminder_date, status, attempts, phone, error)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(customer_id, reminder_date) DO UPDATE SET
      status   = excluded.status,
      attempts = billing_reminder_logs.attempts + 1,
      phone    = excluded.phone,
      error    = excluded.error,
      updated_at = NOW_LOCAL()
  `).run(Number(customerId), dateKey, status, String(phone || ''), String(error || ''));
}

/** Buang catatan pengingat yang sudah lama supaya tabel tidak menggelembung. */
function cleanupReminderLogs(retentionDays = 120) {
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS c FROM billing_reminder_logs
      WHERE reminder_date < date(NOW_LOCAL(), ?)
    `).get(`-${retentionDays} days`);
    if (Number(r?.c) > 0) {
      db.prepare(`DELETE FROM billing_reminder_logs WHERE reminder_date < date(NOW_LOCAL(), ?)`)
        .run(`-${retentionDays} days`);
      logger.info(`[CRON] Bersihkan ${r.c} catatan pengingat lebih dari ${retentionDays} hari.`);
    }
  } catch (e) {
    logger.error(`[CRON] Gagal bersihkan catatan pengingat: ${e.message}`);
  }
}

/**
 * Pastikan invoice punya nominal unik QRIS. Kalau belum ada, dibuatkan.
 *
 * Nominal unik inilah yang ditanam ke dalam QR sekaligus dicocokkan oleh
 * webhook pembayaran — keduanya harus persis sama agar tagihan bisa
 * ditandai lunas otomatis.
 *
 * @returns {{code:number, amount:number}|null}
 */
function ensureInvoiceQrisAmount(invoice) {
  const invId = Number(invoice?.id || 0);
  const baseAmount = Number(invoice?.amount || 0);
  if (!invId || !(baseAmount > 0)) return null;

  const existingAmount = Number(invoice.qris_amount_unique || 0) || 0;
  const existingCode = Number(invoice.qris_unique_code || 0) || 0;
  if (existingAmount > 0 && existingCode > 0) {
    return { code: existingCode, amount: existingAmount };
  }

  const exists = db.prepare(
    "SELECT id FROM invoices WHERE status='unpaid' AND qris_amount_unique=? AND id!=? LIMIT 1"
  );
  const picked = pickQrisUniqueAmount(baseAmount, (amt) => !exists.get(amt, invId));
  if (!picked) {
    logger.warn(`[CRON] Slot kode unik QRIS penuh untuk invoice ${invId} (nominal ${baseAmount}).`);
    return null;
  }

  db.prepare(`
    UPDATE invoices
    SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=NOW_LOCAL()
    WHERE id=?
  `).run(picked.code, picked.amount, invId);

  return { code: picked.code, amount: picked.amount };
}

function resolvePortalBaseUrl() {
  const explicit = String(getSetting('public_base_url', '') || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
  const port = Number(getSetting('server_port', 3001) || 3001);
  const hasProto = /^https?:\/\//i.test(hostRaw);
  const proto = port === 443 ? 'https' : 'http';
  const host = hasProto ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
  const withPort = (port === 80 || port === 443) ? host : `${host}:${port}`;
  return withPort.replace(/\/+$/, '');
}

/**
 * Kirim pengingat tagihan ke pelanggan yang jatuh tempo besok (H-1).
 *
 * Aman dipanggil berkali-kali dalam satu hari: setiap pelanggan yang berhasil
 * dikirimi (atau sudah gagal sebanyak REMINDER_MAX_ATTEMPTS) dicatat di tabel
 * billing_reminder_logs dan tidak akan diproses ulang pada hari yang sama.
 * Berkat itu, proses yang terpotong restart akan dilanjutkan oleh cron resume,
 * bukan diulang dari awal.
 *
 * @param {string} trigger label untuk log ('jadwal-07:00' | 'resume' | 'startup')
 */
/**
 * @typedef {Object} ReminderOptions
 * @property {boolean} [dryRun]        Hitung target saja — TIDAK mengirim WhatsApp
 *                                     dan TIDAK menulis penanda terkirim.
 * @property {string}  [simulateDate]  'YYYY-MM-DD'. Berpura-pura hari ini tanggal
 *                                     tersebut, untuk menguji logika H-1 tanpa
 *                                     menunggu atau mengubah data pelanggan.
 * @property {boolean} [ignoreSettled] Abaikan penanda "sudah dikirim hari ini",
 *                                     supaya uji bisa diulang berkali-kali.
 * @property {number}  [onlyCustomerId] Proses satu pelanggan saja.
 * @property {string}  [overridePhone] Kirim ke nomor ini, bukan nomor pelanggan.
 *                                     Dipakai agar pesan uji masuk ke HP admin.
 * @property {boolean} [noDelay]       Lewati jeda acak 30-120 detik (untuk uji).
 */

/**
 * Kirim pengingat tagihan.
 *
 * Selain dipakai cron harian, fungsi ini juga melayani mode UJI dari panel admin
 * (lihat ReminderOptions). Mode uji dibuat supaya fitur ini bisa diperiksa di
 * server produksi tanpa: menunggu jam 07:00, mengubah tanggal isolir pelanggan,
 * atau mengirim pesan nyata ke pelanggan.
 *
 * @param {string} trigger label untuk log
 * @param {ReminderOptions} [opts]
 */
async function runBillingReminders(trigger = 'manual', opts = {}) {
  const dryRun = !!opts.dryRun;

  if (reminderRunning) {
    logger.info(`[CRON] Pengingat (${trigger}) dilewati — proses lain masih berjalan.`);
    return { skipped: true, reason: 'running' };
  }

  const enabled = getSetting('whatsapp_auto_billing_enabled', false);
  const waEnabled = getSetting('whatsapp_enabled', false);
  const billingEnabled = getSetting('whatsapp_billing_to_customer_enabled', true);

  // Simulasi tetap boleh jalan walau fitur pengingat sedang dimatikan —
  // justru berguna untuk memastikan semuanya siap sebelum diaktifkan.
  if (!dryRun && (!enabled || !waEnabled || !billingEnabled)) {
    return { skipped: true, reason: 'disabled' };
  }

  // Tanggal acuan: normalnya hari ini, bisa dipura-purakan saat menguji.
  let today = getCurrentDateInTimezone();
  let dateKey = localDateKey();
  if (opts.simulateDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.simulateDate)) {
    const [y, m, d] = opts.simulateDate.split('-').map(Number);
    const sim = new Date(y, m - 1, d);
    if (!isNaN(sim.getTime())) {
      today = sim;
      dateKey = opts.simulateDate;
    }
  }

  // Susun daftar target dulu (murah) sebelum menyentuh WhatsApp.
  const customers = customerSvc.getAllCustomers();
  const settled = opts.ignoreSettled ? new Set() : getSettledCustomerIds(dateKey);

  const targetCustomers = [];
  const seenPhones = new Set();
  for (const c of customers) {
    if (opts.onlyCustomerId && Number(c.id) !== Number(opts.onlyCustomerId)) continue;

    const phone = c.phone ? String(c.phone).trim() : '';
    if (!phone || phone.length < 9) continue;
    let digits = phone.replace(/\D/g, '');
    if (!digits) continue;
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    if (seenPhones.has(digits)) continue;

    const unpaidCount = Number(c.unpaid_count || 0) || 0;
    if (unpaidCount <= 0) continue;

    const dueDay = Number(c.isolate_day || 0) || Number(getSetting('isolir_day', 10) || 10) || 10;
    const stageInfo = getReminderStage(dueDay, today);
    if (!stageInfo) continue;   // bukan H-5 maupun H-1 -> tidak dikirimi

    seenPhones.add(digits);
    if (settled.has(Number(c.id))) continue; // sudah diproses hari ini

    // Tempelkan info tahap & jatuh tempo agar tidak dihitung dua kali di bawah
    c._reminderStage = stageInfo.stage;      // 5 atau 1
    c._dueDate = stageInfo.dueDate;
    targetCustomers.push(c);
  }

  // ── MODE SIMULASI: laporkan siapa saja yang akan dikirimi, lalu berhenti ──
  if (dryRun) {
    const preview = targetCustomers.map(c => {
      const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
      const total = unpaid.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        package_name: c.package_name || '-',
        isolate_day: Number(c.isolate_day || 0) || Number(getSetting('isolir_day', 10) || 10),
        stage: c._reminderStage,                        // 5 = H-5, 1 = H-1
        jatuh_tempo: formatDateLong(c._dueDate),
        unpaid_count: unpaid.length,
        total_tagihan: total,
        periode: formatPeriodList(unpaid)
      };
    });
    const h5 = preview.filter(p => p.stage === 5).length;
    const h1 = preview.filter(p => p.stage === 1).length;
    logger.info(`[CRON] SIMULASI (${trigger}) tanggal ${dateKey}: ${preview.length} pelanggan (H-5: ${h5}, H-1: ${h1}). Tidak ada pesan yang dikirim.`);
    return { dryRun: true, dateKey, count: preview.length, h5, h1, targets: preview };
  }

  if (targetCustomers.length === 0) {
    if (trigger !== 'resume') {
      logger.info(`[CRON] Pengingat (${trigger}): tidak ada pelanggan yang perlu diingatkan hari ini.`);
    }
    return { skipped: true, reason: 'no-target', sent: 0, failed: 0 };
  }

  let sendWA, sendWAImage, whatsappStatus;
  try {
    const mod = await import('./whatsappBot.mjs');
    sendWA = mod.sendWA;
    sendWAImage = mod.sendWAImage;
    whatsappStatus = mod.whatsappStatus;
  } catch (e) {
    logger.error(`[CRON] Gagal load WhatsApp bot: ${e.message || e}`);
    return { skipped: true, reason: 'wa-load-error' };
  }

  if (!whatsappStatus || whatsappStatus.connection !== 'open') {
    // Tidak ditandai gagal — biar cron resume mencoba lagi saat WA sudah tersambung.
    logger.warn(`[CRON] Pengingat (${trigger}) ditunda: WhatsApp belum terhubung. ${targetCustomers.length} pelanggan menunggu.`);
    return { skipped: true, reason: 'wa-offline', pending: targetCustomers.length };
  }

  reminderRunning = true;
  const loginLink = `${resolvePortalBaseUrl()}/customer/login`;
  const batchSize = 15;
  const batchPauseMs = 120000;

  const defaultTemplate =
    `Yth. Pelanggan {{nama}},\n\n` +
    `Ini adalah pengingat sebelum tanggal jatuh tempo/isolir.\n\n` +
    `📦 *Paket:* {{paket}}\n` +
    `💰 *Total Tagihan:* Rp {{tagihan}}\n` +
    `📅 *Periode:* {{rincian}}\n\n` +
    `Mohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\n` +
    `Terima kasih atas kerja samanya.\n` +
    `Salam,\nAdmin ${getSetting('company_header', 'ISP')}`;
  // SATU template untuk pengingat otomatis: isi textarea "Isi Pesan WhatsApp"
  // di halaman Broadcast WhatsApp.
  //
  // Sebelumnya, saat QRIS aktif, cron mengambil `whatsapp_billing_qris_message`
  // — kunci milik tombol kirim manual, yang di panel admin pun berlabel
  // "Template Tagihan QRIS (Manual)". Akibatnya pengingat pagi hari berubah
  // menjadi lembar tagihan: tidak menyebut jatuh tempo, dan template pengingat
  // yang sudah admin susun tidak pernah terpakai.
  //
  // Sekarang template yang sama dipakai untuk kedua jalur — teks maupun caption
  // gambar QR — sehingga apa yang diketik admin di panel itulah yang terkirim.
  const template = String(db.getAppSetting('whatsapp_auto_billing_message', defaultTemplate) || defaultTemplate);

  // QRIS hanya dipakai bila admin sudah mengaturnya di Pengaturan
  const settingsNow = getSettings();
  const qrisReady = qrisSvc.isQrisEnabled(settingsNow);
  if (qrisReady) {
    logger.info('[CRON] QRIS aktif — pengingat akan dikirim sebagai gambar QR dinamis (nominal tertanam).');
  }

  const alreadyDone = settled.size;
  const estimateMin = Math.round(
    (targetCustomers.length * ((REMINDER_DELAY_MIN_MS + REMINDER_DELAY_MAX_MS) / 2)
      + Math.floor(Math.max(0, targetCustomers.length - 1) / batchSize) * batchPauseMs) / 60000
  );
  logger.info(
    `[CRON] Pengingat (${trigger}) mulai: ${targetCustomers.length} pelanggan` +
    (alreadyDone > 0 ? ` (melanjutkan, ${alreadyDone} sudah diproses hari ini)` : '') +
    `. Jeda acak ${REMINDER_DELAY_MIN_MS / 1000}-${REMINDER_DELAY_MAX_MS / 1000} detik/pesan, estimasi ~${estimateMin} menit.`
  );

  let sent = 0;
  let failed = 0;
  let batchCount = 0;

  try {
    for (let i = 0; i < targetCustomers.length; i++) {
      const c = targetCustomers[i];
      // Saat menguji, pesan diarahkan ke nomor admin agar pelanggan asli
      // tidak menerima apa pun. Isi pesannya tetap memakai data pelanggan
      // sungguhan supaya hasil uji mencerminkan kondisi nyata.
      const targetPhone = opts.overridePhone || c.phone;
      // Tanggal jatuh tempo untuk variabel {{jatuhtempo}} pada template pesan
      const jatuhTempo = formatDateLong(c._dueDate);
      let attemptCount = 0;

      while (attemptCount < REMINDER_MAX_ATTEMPTS) {
        try {
          // Jeda acak 30-120 detik (terkunci, tidak mengikuti setting admin).
          // Saat menguji dari panel admin, jeda dilewati agar hasil langsung terlihat.
          if (!opts.noDelay) {
            await new Promise(r => setTimeout(r, getReminderDelay()));
          }

          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
          const totalTagihan = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
          const rincianBulan = formatPeriodList(unpaidInvoices);

          let ok = false;

          // ── Jalur QRIS: kirim gambar QR dinamis dengan nominal tertanam ──
          //
          // Hanya dipakai bila pelanggan punya TEPAT SATU tagihan belum lunas.
          // Pencocokan pembayaran otomatis bekerja dengan mencari invoice yang
          // qris_amount_unique-nya sama persis dengan nominal masuk, jadi satu
          // QR hanya bisa mewakili satu invoice. Bila tunggakannya lebih dari
          // satu, mengirim QR untuk yang tertua sementara teksnya menyebut
          // total akan membuat pelanggan membayar angka yang tidak cocok —
          // dan pembayarannya tidak akan terdeteksi. Untuk kasus itu, pesan
          // dikirim sebagai teks berisi total beserta tautan portal.
          const bolehQris = qrisReady && unpaidInvoices.length === 1;

          if (bolehQris) {
            try {
              const inv = unpaidInvoices[0];
              const unique = ensureInvoiceQrisAmount(inv);

              if (unique && unique.amount > 0) {
                const jpg = await qrisSvc.buildDynamicQrisJpg(settingsNow, unique.amount);
                if (jpg) {
                  // {{tagihan}} sengaja diisi nominal unik, BUKAN nominal dasar.
                  // Inilah angka yang tertanam di QR dan yang harus dibayar agar
                  // pencocokan otomatis berhasil; menampilkan angka bulat di teks
                  // justru menuntun pelanggan membayar jumlah yang salah.
                  const caption = fillReminderTemplate(template, {
                    nama: c.name,
                    paket: c.package_name,
                    tagihan: unique.amount,
                    rincian: rincianBulan,
                    periode: formatPeriod(inv.period_month, inv.period_year),
                    jatuhtempo: jatuhTempo,
                    link: loginLink,
                    qrisAmount: unique.amount,
                    qrisCode: unique.code,
                    qrisImageUrl: `${resolvePortalBaseUrl()}/customer/qris/static.jpg?amount=${encodeURIComponent(String(unique.amount))}`,
                    variationIndex: i
                  });

                  ok = await sendWAImage(targetPhone, jpg, caption);
                }
              }
            } catch (e) {
              // Gagal membuat QR bukan alasan melewatkan pelanggan —
              // jatuh ke pesan teks biasa di bawah.
              logger.warn(`[CRON] QRIS gagal untuk ${c.name}: ${e.message}. Kirim sebagai teks.`);
            }
          } else if (qrisReady && unpaidInvoices.length > 1) {
            logger.info(`[CRON] ${c.name}: ${unpaidInvoices.length} tagihan belum lunas — dikirim sebagai teks (satu QR tidak bisa mewakili semuanya).`);
          }

          // ── Jalur teks biasa (QRIS nonaktif / >1 tagihan / QR gagal dibuat) ──
          if (!ok) {
            const formattedMsg = fillReminderTemplate(template, {
              nama: c.name,
              paket: c.package_name,
              tagihan: totalTagihan,
              rincian: rincianBulan,
              periode: rincianBulan,
              jatuhtempo: jatuhTempo,
              link: loginLink,
              variationIndex: i
            });

            ok = await sendWA(targetPhone, formattedMsg);
          }

          if (!ok) throw new Error('Gagal kirim pesan');

          // Tandai SEGERA setelah sukses — kalau proses mati sedetik kemudian,
          // pelanggan ini tidak akan dikirimi ulang.
          // Kiriman uji ke nomor admin tidak ditandai, supaya jadwal asli
          // pagi harinya tetap mengirim ke pelanggan yang bersangkutan.
          if (!opts.overridePhone) markReminder(c.id, dateKey, 'sent', c.phone, '');
          sent++;
          batchCount++;

          if (!opts.noDelay && batchCount >= batchSize && i < targetCustomers.length - 1) {
            logger.info(`[CRON] Selesai batch ${batchSize} pesan. Jeda ${Math.floor(batchPauseMs / 1000)} detik...`);
            await new Promise(r => setTimeout(r, batchPauseMs));
            batchCount = 0;
          }
          break;
        } catch (e) {
          attemptCount++;
          const errorMsg = e.message || e.toString();

          if (isPermanentError(errorMsg)) {
            logger.warn(`[CRON] SKIP permanen untuk ${c.phone}: ${errorMsg}`);
            if (!opts.overridePhone) markReminder(c.id, dateKey, 'failed', c.phone, `permanen: ${errorMsg}`);
            failed++;
            break;
          }

          logger.error(`[CRON] Gagal kirim ke ${c.phone} (percobaan ${attemptCount}/${REMINDER_MAX_ATTEMPTS}): ${errorMsg}`);

          if (attemptCount >= REMINDER_MAX_ATTEMPTS) {
            if (!opts.overridePhone) markReminder(c.id, dateKey, 'failed', c.phone, errorMsg);
            failed++;
          } else {
            await new Promise(r => setTimeout(r, getBackoffDelay(attemptCount)));
          }
        }
      }
    }
  } finally {
    reminderRunning = false;
  }

  logger.info(`[CRON] Pengingat (${trigger}) selesai: terkirim=${sent}, gagal=${failed}.`);
  return { skipped: false, sent, failed };
}

/**
 * Pengaman tagihan: pastikan invoice bulan berjalan sudah dibuat.
 * Dipanggil saat startup dan tiap hari 00:30 — aman diulang karena idempoten.
 */
function ensureInvoicesSafetyNet(trigger = 'cron') {
  try {
    const r = billingSvc.ensureCurrentMonthInvoices();
    if (r.created > 0) {
      logger.warn(
        `[CRON] PENGAMAN (${trigger}): ${r.created} tagihan periode ${r.month}/${r.year} baru dibuat susulan ` +
        `— kemungkinan jadwal tanggal 1 terlewat (server mati/restart).`
      );
    } else {
      logger.info(`[CRON] Pengaman tagihan (${trigger}): periode ${r.month}/${r.year} sudah lengkap.`);
    }
    return r;
  } catch (e) {
    logger.error(`[CRON] Pengaman tagihan (${trigger}) gagal: ${e.message}`);
    return null;
  }
}

function startCronJobs() {
  // 1. Generate Tagihan Otomatis setiap tanggal 1 jam 00:01
  cron.schedule('1 0 1 * *', () => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    
    logger.info(`[CRON] Menjalankan generate tagihan otomatis untuk ${month}/${year}`);
    try {
      const count = billingSvc.generateMonthlyInvoices(month, year);
      logger.info(`[CRON] Berhasil generate ${count} tagihan otomatis.`);
    } catch (error) {
      logger.error(`[CRON] Gagal generate tagihan otomatis: ${error.message}`);
    }
  }, cronOpts());

  // 2. Isolir Otomatis setiap hari jam 02:00
  cron.schedule('0 2 * * *', async () => {
    const today = new Date().getDate();
    // Kita cek semua pelanggan setiap hari untuk isolir otomatis
    logger.info(`[CRON] Menjalankan pengecekan isolir otomatis harian (Tanggal ${today})`);
    
    const customers = customerSvc.getAllCustomers();
    let isolatedCount = 0;

    for (const c of customers) {
      // Cek apakah isolir otomatis aktif untuk user ini dan hari ini adalah tanggal isolirnya
      const customerIsolirDay = c.isolate_day || 10;
      const isAutoIsolateEnabled = c.auto_isolate !== 0; // default aktif jika null/1

      if (isAutoIsolateEnabled && today >= customerIsolirDay) {
        // Jika pelanggan aktif tapi punya tagihan belum bayar
        if (c.status === 'active' && c.unpaid_count > 0) {
          try {
            logger.info(`[CRON] Isolir otomatis pelanggan: ${c.name} (${c.pppoe_username}) - Tanggal Tagihan: ${customerIsolirDay}`);
            
            // Gunakan fungsi terpusat untuk isolir
            await customerSvc.suspendCustomer(c.id);
            
            isolatedCount++;
          } catch (err) {
            logger.error(`[CRON] Gagal isolir ${c.name}: ${err.message}`);
          }
        }
      }
    }
    logger.info(`[CRON] Selesai pengecekan isolir. Total ${isolatedCount} pelanggan baru di-isolir.`);
  }, cronOpts());

  // 2b. PENGAMAN tagihan harian 00:30 — menambal jadwal tanggal 1 yang terlewat
  //     karena server mati/restart. Idempoten, tidak akan membuat invoice dobel.
  cron.schedule(INVOICE_SAFETY_CRON, () => {
    ensureInvoicesSafetyNet('harian-00:30');
    cleanupReminderLogs();
  }, cronOpts());

  // 3. Pengingat Tagihan Otomatis — jam & jeda TERKUNCI (lihat konstanta di atas)
  cron.schedule(REMINDER_CRON, () => runBillingReminders('jadwal-07:00'), cronOpts());

  // 3b. Lanjutan pengingat — menyapu sisa yang belum terkirim (mis. setelah restart).
  //     Idempoten: pelanggan yang sudah ditandai terkirim hari ini akan dilewati,
  //     dan lock mencegah tumpang tindih dengan proses yang masih berjalan.
  cron.schedule(REMINDER_RESUME_CRON, () => runBillingReminders('resume'), cronOpts());

  // 4. Jam Kalong (Night Speed) Start - Jam 00:00
  cron.schedule('0 0 * * *', async () => {
    logger.info('[CRON] Memulai Jam Kalong (Night Speed) - Ganti Profile...');
    try {
      const customers = customerSvc.getAllCustomers();
      let count = 0;

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        
        const pkg = customerSvc.getPackageById(c.package_id);
        if (pkg && pkg.use_night_speed === 1 && pkg.night_profile_name) {
          try {
            logger.info(`[CRON] Switching ${c.name} to Night Profile: ${pkg.night_profile_name}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, pkg.night_profile_name, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal switch Jam Kalong untuk ${c.name}: ${err.message}`);
          }
        }
      }
      logger.info(`[CRON] Jam Kalong aktif untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong Start: ${e.message}`);
    }
  }, cronOpts());

  // 5. Jam Kalong (Night Speed) End - Jam 06:00
  cron.schedule('0 6 * * *', async () => {
    logger.info('[CRON] Mengakhiri Jam Kalong (Night Speed) - Kembali ke Profile Normal...');
    try {
      const customers = customerSvc.getAllCustomers();
      let count = 0;

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;

        const pkg = customerSvc.getPackageById(c.package_id);
        if (pkg && pkg.use_night_speed === 1) {
          try {
            // Kembali ke profile asli (nama paket)
            const normalProfile = pkg.name;
            logger.info(`[CRON] Restoring ${c.name} to Normal Profile: ${normalProfile}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, normalProfile, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal restore profil normal untuk ${c.name}: ${err.message}`);
          }
        }
      }
      logger.info(`[CRON] Profil normal dikembalikan untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong End: ${e.message}`);
    }
  }, cronOpts());

  // 6. Catat Pemakaian Pelanggan — setiap 10 menit
  //
  // Yang disimpan adalah SELISIH sejak sampel sebelumnya, bukan angka mentah
  // dari MikroTik. Dengan begitu total pemakaian hidup di database dan tidak
  // ikut hilang saat router reboot atau pelanggan tersambung ulang.
  cron.schedule('*/10 * * * *', async () => {
    if (!getSetting('usage_tracking_enabled', true)) return;
    try {
      await fupSvc.sampleUsage();
    } catch (e) {
      logger.error(`[CRON] Gagal mencatat pemakaian: ${e.message}`);
    }
  }, cronOpts());

  // 7. Pemeriksaan FUP — setiap jam
  cron.schedule('0 * * * *', async () => {
    if (!getSetting('fup_enabled', true)) return;
    try {
      await fupSvc.runFupCheck();
    } catch (e) {
      logger.error(`[CRON] Gagal memeriksa FUP: ${e.message}`);
    }
  }, cronOpts());

  // 7b. Reset FUP bulanan — tanggal 1 pukul 00:05
  //
  // Kuotanya sendiri tidak perlu dihapus: pemakaian dicatat per periode, jadi
  // bulan baru otomatis mulai dari nol. Yang wajib dikerjakan adalah
  // MENGEMBALIKAN PROFILE pelanggan yang masih tertahan di kecepatan FUP —
  // tanpa langkah ini mereka akan lambat selamanya walaupun kuotanya sudah
  // kembali penuh.
  //
  // Dijalankan pukul 00:05, bukan 00:00, supaya tidak berebut dengan tugas
  // tengah malam lain seperti pembuatan tagihan.
  cron.schedule('5 0 1 * *', async () => {
    logger.info('[CRON] Tanggal 1 — mereset FUP dan mengembalikan profile normal...');
    try {
      await fupSvc.resetMonthlyFup();
    } catch (e) {
      logger.error(`[CRON] Gagal reset FUP bulanan: ${e.message}`);
    }
  }, cronOpts());

  // 8. Auto-Refresh ACS Devices & Sync IPs - Setiap 5 Menit
  cron.schedule('*/5 * * * *', async () => {
    const enabled = getSetting('use_builtin_acs', false) === true || getSetting('use_builtin_acs', false) === 'true';
    if (!enabled) return;

    logger.info('[CRON] Menjalankan sinkronisasi dan auto-refresh ACS Devices...');
    try {
      const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap();
      const acsDevices = db.prepare('SELECT id, ip_address, connection_request_url, params, last_inform FROM acs_devices').all();

      const acsServerService = require('./acsServerService');
      let triggeredCount = 0;
      let ipUpdatedCount = 0;

      for (const dev of acsDevices) {
        let params = {};
        try { params = JSON.parse(dev.params || '{}'); } catch (_) {}

        // Extract PPPoE user
        let pppoeUser = '';
        const pppoeUserKeys = [
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
          'Device.PPP.Interface.1.Username',
          'VirtualParameters.pppoeUsername',
          'VirtualParameters.pppUsername'
        ];
        for (const key of pppoeUserKeys) {
          if (params[key] && params[key] !== '-') {
            pppoeUser = params[key];
            break;
          }
        }
        
        if (!pppoeUser) {
          for (const key of Object.keys(params)) {
            if (key.toLowerCase().includes('wanpppconnection') && key.toLowerCase().endsWith('.username') && params[key]) {
              pppoeUser = params[key];
              break;
            }
          }
        }

        if (!pppoeUser || pppoeUser === '-') continue;

        const activeSession = activeSessionsMap.get(pppoeUser.toLowerCase());
        if (activeSession) {
          const currentIp = activeSession.ip;
          
          if (currentIp && currentIp !== dev.ip_address) {
            logger.info(`[ACS-Sync] IP address changed for device ${dev.id} (${pppoeUser}): ${dev.ip_address} -> ${currentIp}`);
            
            let newCrUrl = dev.connection_request_url || '';
            if (newCrUrl) {
              try {
                if (newCrUrl.startsWith('http')) {
                  const urlObj = new URL(newCrUrl);
                  urlObj.hostname = currentIp;
                  newCrUrl = urlObj.toString();
                } else {
                  newCrUrl = newCrUrl.replace(/(https?:\/\/)([^:/]+)(.*)/, `$1${currentIp}$3`);
                }
              } catch (e) {
                newCrUrl = newCrUrl.replace(/(https?:\/\/)([^:/]+)(.*)/, `$1${currentIp}$3`);
              }
            } else {
              newCrUrl = `http://${currentIp}:58000/`;
            }

            const now = new Date().toISOString();
            db.prepare('UPDATE acs_devices SET ip_address = ?, connection_request_url = ?, updated_at = ? WHERE id = ?')
              .run(currentIp, newCrUrl, now, dev.id);
            
            ipUpdatedCount++;
            
            dev.ip_address = currentIp;
            dev.connection_request_url = newCrUrl;
          }

          const lastInformTime = dev.last_inform ? new Date(dev.last_inform).getTime() : 0;
          const isStale = (Date.now() - lastInformTime) > 15 * 60 * 1000;

          if (isStale) {
            logger.info(`[ACS-Sync] Device ${dev.id} (${pppoeUser}) is active on MikroTik but offline/stale in ACS. Triggering connection request to refresh data.`);
            acsServerService.triggerConnectionRequest(dev.id).catch(err => {
              logger.warn(`[ACS-Sync] Failed to trigger connection request for ${dev.id}: ${err.message}`);
            });
            triggeredCount++;
          }
        }
      }

      logger.info(`[CRON] Selesai sinkronisasi ACS. IP diperbarui: ${ipUpdatedCount}, Connection requests dipicu: ${triggeredCount}`);
    } catch (e) {
      logger.error(`[CRON] Error Auto-Refresh ACS: ${e.message}`);
    }
  }, cronOpts());

  logger.info(`[CRON] Semua tugas penjadwalan telah aktif (timezone: ${cronTz()}).`);

  // ─── CATCH-UP SAAT STARTUP ───────────────────────────────────────────────
  // node-cron tidak menjalankan jadwal yang terlewat selama aplikasi mati.
  // Jeda 15 detik memberi waktu koneksi DB & WhatsApp bot siap lebih dulu.
  setTimeout(() => {
    ensureInvoicesSafetyNet('startup');
    cleanupReminderLogs();

    // Kalau aplikasi baru hidup setelah jam 07:00, sapu pengingat yang tertinggal.
    // Kalau semua sudah terkirim, fungsi ini berhenti di satu query ringan.
    const hour = getCurrentDateInTimezone().getHours();
    if (hour >= 7) {
      runBillingReminders('startup').catch(e =>
        logger.error(`[CRON] Catch-up pengingat saat startup gagal: ${e.message}`)
      );
    }
  }, 15000);
}

module.exports = {
  startCronJobs,
  runBillingReminders,
  ensureInvoicesSafetyNet,
  cleanupReminderLogs,
  isReminderDay,
  fillReminderTemplate   // diekspor agar bisa diuji terpisah
};
