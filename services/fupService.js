/**
 * FAIR USAGE POLICY (FUP)
 * ---------------------------------------------------------------------------
 * Menurunkan kecepatan pelanggan yang pemakaiannya sudah melewati batas paket,
 * lalu mengembalikannya saat kuota di-reset tanggal 1.
 *
 * Dua keputusan penting di modul ini:
 *
 *  1. KEADAAN NYATA MENGALAHKAN PENANDA DATABASE.
 *     Profile pelanggan bisa berubah di luar sepengetahuan modul ini —
 *     activateCustomer(), misalnya, mengembalikan profile ke nama paket setiap
 *     kali pelanggan diaktifkan setelah isolir. Kalau FUP hanya percaya kolom
 *     `fup_applied`, pelanggan yang sudah lewat kuota bisa diam-diam kembali
 *     kencang. Maka setiap evaluasi memeriksa profile yang benar-benar
 *     terpasang di MikroTik.
 *
 *  2. PROFILE SEBELUMNYA HARUS DISIMPAN.
 *     Tanpa mencatat profile asal, tidak ada cara mengembalikan pelanggan ke
 *     kecepatan normal tanggal 1 — mereka akan tertahan lambat selamanya.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const customerSvc = require('./customerService');
const usageSvc = require('./usageService');
const mikrotikService = require('./mikrotikService');

/** Paket yang FUP-nya benar-benar siap dipakai. */
function fupSiap(pkg) {
  return !!(pkg
    && Number(pkg.use_fup) === 1
    && Number(pkg.fup_limit_gb) > 0
    && String(pkg.fup_profile_name || '').trim());
}

function setKeadaanFup(customerId, applied, prevProfile) {
  db.prepare(`
    UPDATE customers
    SET fup_applied = ?,
        fup_applied_at = CASE WHEN ? = 1 THEN NOW_LOCAL() ELSE NULL END,
        fup_prev_profile = ?
    WHERE id = ?
  `).run(applied ? 1 : 0, applied ? 1 : 0, prevProfile || null, customerId);
}

/**
 * Evaluasi satu pelanggan.
 *
 * @param {object} c            baris pelanggan
 * @param {object} opsi
 * @param {boolean} opsi.dryRun hanya menghitung, tidak menyentuh MikroTik
 * @returns {Promise<{aksi:string, pesan:string, terpakaiGB:number, batasGB:number}>}
 */
async function evaluateCustomer(c, opsi = {}) {
  const dryRun = !!opsi.dryRun;
  const hasil = (aksi, pesan, terpakaiGB = 0, batasGB = 0) => ({ aksi, pesan, terpakaiGB, batasGB, nama: c.name, id: c.id });

  if (!c.pppoe_username) return hasil('lewati', 'Bukan pelanggan PPPoE — FUP hanya berlaku untuk PPPoE.');
  if (!c.package_id) return hasil('lewati', 'Belum punya paket.');

  const pkg = customerSvc.getPackageById(c.package_id);
  if (!fupSiap(pkg)) {
    return hasil('lewati', 'FUP belum diaktifkan di paket, atau batas/profile FUP belum diisi.');
  }

  const batasGB = Number(pkg.fup_limit_gb);
  const terpakaiGB = usageSvc.getTotalGB(c.id);
  const profileFup = String(pkg.fup_profile_name).trim();
  const profileNormal = String(c.fup_prev_profile || pkg.name || '').trim();

  const lewatBatas = terpakaiGB >= batasGB;

  // Pelanggan yang sedang diisolir tidak disentuh: profile mereka adalah
  // profile isolir, dan menggantinya akan membuka kembali akses yang sengaja
  // ditutup karena tunggakan.
  if (c.status !== 'active') {
    return hasil('lewati', `Status "${c.status}" — profile tidak diubah.`, terpakaiGB, batasGB);
  }

  // Profile nyata dibaca untuk KEDUA mode. Membaca tidak mengubah apa pun, dan
  // tanpa ini simulasi akan melaporkan "akan diturunkan" untuk pelanggan yang
  // PPPoE-nya ternyata sudah tidak ada di MikroTik — pratinjau yang lebih
  // optimistis daripada kenyataan justru menyesatkan.
  const profileSekarang = await mikrotikService.getPppoeSecretProfile(c.pppoe_username, c.router_id);
  if (profileSekarang === null) {
    return hasil('gagal', `PPPoE "${c.pppoe_username}" tidak ditemukan di MikroTik.`, terpakaiGB, batasGB);
  }

  const sedangKenaFup = profileSekarang === profileFup;

  if (dryRun) {
    if (lewatBatas) {
      return sedangKenaFup
        ? hasil('sudah-turun', `${terpakaiGB.toFixed(2)} / ${batasGB} GB — sudah di profile FUP.`, terpakaiGB, batasGB)
        : hasil('akan-diturunkan', `${terpakaiGB.toFixed(2)} / ${batasGB} GB — profile "${profileSekarang}" akan diganti ke "${profileFup}".`, terpakaiGB, batasGB);
    }
    return sedangKenaFup
      ? hasil('akan-dipulihkan', `${terpakaiGB.toFixed(2)} / ${batasGB} GB — profile akan dikembalikan ke "${profileNormal || pkg.name}".`, terpakaiGB, batasGB)
      : hasil('aman', `${terpakaiGB.toFixed(2)} / ${batasGB} GB.`, terpakaiGB, batasGB);
  }

  if (lewatBatas) {
    if (sedangKenaFup) {
      // Sudah benar. Penanda database dirapikan bila sempat tidak sinkron.
      if (Number(c.fup_applied) !== 1) setKeadaanFup(c.id, true, c.fup_prev_profile || pkg.name || null);
      return hasil('sudah-turun', `${terpakaiGB.toFixed(2)} / ${batasGB} GB — sudah di profile FUP.`, terpakaiGB, batasGB);
    }

    // Profile asal dicatat SEBELUM diganti, supaya bisa dikembalikan nanti.
    const asal = profileSekarang || pkg.name || null;
    await mikrotikService.setPppoeProfile(c.pppoe_username, profileFup, c.router_id);
    setKeadaanFup(c.id, true, asal);
    logger.warn(`[FUP] ${c.name} melewati batas (${terpakaiGB.toFixed(2)}/${batasGB} GB). Profile "${asal}" -> "${profileFup}".`);
    return hasil('diturunkan', `${terpakaiGB.toFixed(2)} / ${batasGB} GB — profile "${asal}" diganti ke "${profileFup}".`, terpakaiGB, batasGB);
  }

  // Di bawah batas. Ini terjadi bila admin menaikkan batas atau mengosongkan
  // pemakaian di tengah bulan; pelanggan berhak kembali normal tanpa menunggu
  // tanggal 1.
  if (sedangKenaFup) {
    const tujuan = profileNormal || pkg.name;
    if (!tujuan) {
      return hasil('gagal', 'Profile normal tidak diketahui — tidak bisa dipulihkan.', terpakaiGB, batasGB);
    }
    await mikrotikService.setPppoeProfile(c.pppoe_username, tujuan, c.router_id);
    setKeadaanFup(c.id, false, null);
    logger.info(`[FUP] ${c.name} kembali di bawah batas. Profile dipulihkan ke "${tujuan}".`);
    return hasil('dipulihkan', `${terpakaiGB.toFixed(2)} / ${batasGB} GB — profile dikembalikan ke "${tujuan}".`, terpakaiGB, batasGB);
  }

  if (Number(c.fup_applied) === 1) setKeadaanFup(c.id, false, null);
  return hasil('aman', `${terpakaiGB.toFixed(2)} / ${batasGB} GB.`, terpakaiGB, batasGB);
}

/**
 * Jalankan pemeriksaan FUP untuk semua pelanggan.
 * @param {{dryRun?:boolean}} opsi
 */
async function runFupCheck(opsi = {}) {
  const dryRun = !!opsi.dryRun;
  const ringkasan = { diperiksa: 0, diturunkan: 0, dipulihkan: 0, sudahTurun: 0, aman: 0, dilewati: 0, gagal: 0, rincian: [] };

  const customers = customerSvc.getAllCustomers() || [];
  for (const c of customers) {
    let r;
    try {
      r = await evaluateCustomer(c, { dryRun });
    } catch (e) {
      r = { aksi: 'gagal', pesan: e.message, nama: c.name, id: c.id, terpakaiGB: 0, batasGB: 0 };
      logger.error(`[FUP] ${c.name}: ${e.message}`);
    }

    ringkasan.diperiksa++;
    if (r.aksi === 'lewati') ringkasan.dilewati++;
    else if (r.aksi === 'diturunkan' || r.aksi === 'akan-diturunkan') ringkasan.diturunkan++;
    else if (r.aksi === 'dipulihkan') ringkasan.dipulihkan++;
    else if (r.aksi === 'sudah-turun') ringkasan.sudahTurun++;
    else if (r.aksi === 'gagal') ringkasan.gagal++;
    else ringkasan.aman++;

    // Pelanggan yang dilewati karena paketnya memang tanpa FUP tidak perlu
    // memenuhi laporan.
    if (r.aksi !== 'lewati' || /tidak ditemukan|gagal/i.test(r.pesan)) ringkasan.rincian.push(r);
  }

  logger.info(`[FUP] Pemeriksaan${dryRun ? ' (simulasi)' : ''} selesai: ${ringkasan.diturunkan} diturunkan, ${ringkasan.dipulihkan} dipulihkan, ${ringkasan.sudahTurun} sudah turun, ${ringkasan.aman} aman, ${ringkasan.gagal} gagal.`);
  return ringkasan;
}

/**
 * Reset bulanan — dijalankan tanggal 1.
 *
 * Kuota sendiri tidak perlu "dihapus": `customer_usage` disimpan per periode,
 * jadi bulan baru otomatis mulai dari nol. Yang WAJIB dikerjakan di sini adalah
 * mengembalikan profile pelanggan yang masih tertahan di kecepatan FUP.
 */
async function resetMonthlyFup(opsi = {}) {
  const dryRun = !!opsi.dryRun;
  const ringkasan = { kandidat: 0, dipulihkan: 0, dilewati: 0, gagal: 0, rincian: [] };

  const daftar = db.prepare(`
    SELECT * FROM customers
    WHERE fup_applied = 1 AND COALESCE(pppoe_username, '') <> ''
  `).all();

  ringkasan.kandidat = daftar.length;
  logger.info(`[FUP] Reset bulanan: ${daftar.length} pelanggan sedang dalam keadaan FUP.`);

  for (const c of daftar) {
    try {
      const pkg = customerSvc.getPackageById(c.package_id);
      const profileFup = String(pkg && pkg.fup_profile_name || '').trim();
      const tujuan = String(c.fup_prev_profile || (pkg && pkg.name) || '').trim();

      if (!tujuan) {
        ringkasan.gagal++;
        ringkasan.rincian.push({ nama: c.name, aksi: 'gagal', pesan: 'Profile asal tidak tercatat.' });
        continue;
      }

      if (dryRun) {
        ringkasan.dipulihkan++;
        ringkasan.rincian.push({ nama: c.name, aksi: 'akan-dipulihkan', pesan: `-> "${tujuan}"` });
        continue;
      }

      // Jangan mengganggu pelanggan yang profilnya sudah bukan profile FUP —
      // mereka sedang diisolir, atau sudah diubah manual oleh admin.
      const profileSekarang = await mikrotikService.getPppoeSecretProfile(c.pppoe_username, c.router_id);
      if (profileSekarang !== null && profileFup && profileSekarang !== profileFup) {
        setKeadaanFup(c.id, false, null);
        ringkasan.dilewati++;
        ringkasan.rincian.push({ nama: c.name, aksi: 'dilewati', pesan: `Profile sekarang "${profileSekarang}", bukan profile FUP — dibiarkan.` });
        continue;
      }

      await mikrotikService.setPppoeProfile(c.pppoe_username, tujuan, c.router_id);
      setKeadaanFup(c.id, false, null);
      ringkasan.dipulihkan++;
      ringkasan.rincian.push({ nama: c.name, aksi: 'dipulihkan', pesan: `Profile dikembalikan ke "${tujuan}".` });
      logger.info(`[FUP] ${c.name}: profile dikembalikan ke "${tujuan}".`);
    } catch (e) {
      ringkasan.gagal++;
      ringkasan.rincian.push({ nama: c.name, aksi: 'gagal', pesan: e.message });
      logger.error(`[FUP] Gagal memulihkan ${c.name}: ${e.message}`);
    }
  }

  logger.info(`[FUP] Reset bulanan selesai: ${ringkasan.dipulihkan} dipulihkan, ${ringkasan.dilewati} dilewati, ${ringkasan.gagal} gagal.`);
  return ringkasan;
}

/**
 * Ambil satu sampel pemakaian dari semua router dan simpan selisihnya.
 * Dipisah dari cron supaya bisa dipanggil manual dari panel admin.
 */
async function sampleUsage() {
  const ringkasan = { router: 0, sesi: 0, tercatat: 0, tanpaPelanggan: 0, sumber: new Set() };

  const routers = mikrotikService.getAllRouters() || [];
  const customers = customerSvc.getAllCustomers() || [];

  const petaPelanggan = new Map();
  for (const c of customers) {
    if (c.pppoe_username) petaPelanggan.set(String(c.pppoe_username).toLowerCase(), c);
  }

  for (const r of routers) {
    ringkasan.router++;
    try {
      const trafik = await mikrotikService.getPppoeTraffic(r.id);
      for (const t of trafik) {
        ringkasan.sesi++;
        ringkasan.sumber.add(t.source);

        const cust = petaPelanggan.get(String(t.username).toLowerCase());
        if (!cust) { ringkasan.tanpaPelanggan++; continue; }

        usageSvc.recordSample(cust.id, t);
        ringkasan.tercatat++;
      }
    } catch (e) {
      logger.error(`[Usage] Gagal mengambil trafik dari router ${r.name}: ${e.message}`);
    }
  }

  ringkasan.sumber = Array.from(ringkasan.sumber);
  logger.info(`[Usage] Sampel: ${ringkasan.sesi} sesi dari ${ringkasan.router} router, ${ringkasan.tercatat} tercatat, ${ringkasan.tanpaPelanggan} tanpa pelanggan cocok. Sumber: ${ringkasan.sumber.join(', ') || '-'}`);
  return ringkasan;
}

module.exports = {
  evaluateCustomer,
  runFupCheck,
  resetMonthlyFup,
  sampleUsage,
  fupSiap
};
