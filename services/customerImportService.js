/**
 * IMPORT PELANGGAN DARI EXCEL
 * ---------------------------------------------------------------------------
 * Modul ini menggantikan logika import yang sebelumnya menyatu di route dan
 * punya satu cacat fatal: baris dengan kolom ID selalu diarahkan ke
 * updateCustomer(), dan bila ID itu tidak ada di database, SQLite hanya
 * mengubah 0 baris — tanpa error. Baris itu lenyap, tetapi tetap dihitung
 * sebagai berhasil, sehingga admin melihat "Berhasil mengimpor 7 data" padahal
 * hanya 6 yang tersimpan.
 *
 * Prinsip yang dipegang di sini:
 *
 *  1. TIDAK ADA KEGAGALAN DIAM-DIAM. Setiap baris menghasilkan keputusan yang
 *     dilaporkan: dibuat, diperbarui, atau gagal beserta alasannya.
 *  2. SATU BARIS RUSAK TIDAK MENGGAGALKAN SISANYA. Untuk 200 pelanggan, satu
 *     salah ketik tidak boleh membatalkan 199 baris lain.
 *  3. TIDAK MENIMPA DIAM-DIAM. Membuat pelanggan yang nomor/PPPoE-nya sudah
 *     dipakai akan ditolak, bukan menghasilkan data ganda.
 */
const customerSvc = require('./customerService');
const odpSvc = require('./odpService');
const oltSvc = require('./oltService');
const adminSvc = require('./adminService');
const mikrotikService = require('./mikrotikService');
const { logger } = require('../config/logger');

/** Kolom yang dikenali, beserta nama alternatifnya. */
const KOLOM = {
  id: ['ID', 'id', 'Id'],
  name: ['Nama', 'name', 'Name', 'NAMA'],
  phone: ['Telepon', 'phone', 'Phone', 'No HP', 'No. HP', 'Nomor HP', 'HP'],
  email: ['Email', 'email', 'E-mail', 'email_address'],
  address: ['Alamat', 'address', 'Address'],
  package: ['Paket', 'package', 'Package', 'Paket Internet'],
  router: ['Router', 'router', 'Router Name'],
  connection: ['Tipe Koneksi', 'connection_type', 'Connection Type', 'Tipe'],
  onu: ['Tag ONU', 'genieacs_tag', 'Tag Onu', 'ONU'],
  pppoe: ['PPPoE Username', 'pppoe_username', 'PPPOE Username', 'PPPoE'],
  hotspot: ['Hotspot Username', 'hotspot_username'],
  staticIp: ['Static IP', 'static_ip', 'IP Statis'],
  isolirProfile: ['Isolir Profile', 'isolir_profile', 'Profil Isolir'],
  status: ['Status', 'status'],
  installDate: ['Tanggal Pasang', 'install_date', 'Tgl Pasang'],
  autoIsolate: ['Auto Isolir', 'auto_isolate', 'Auto Isolate'],
  isolateDay: ['Tgl Isolir', 'isolate_day', 'Tanggal Isolir'],
  odp: ['ODP', 'odp', 'ODP Name', 'Nama ODP'],
  olt: ['OLT', 'olt', 'Perangkat OLT', 'Nama OLT'],
  ponPort: ['Port PON', 'pon_port', 'PON Port', 'Port'],
  collector: ['Kolektor', 'collector', 'Kolektor Penagihan', 'Penagih'],
  lat: ['Latitude', 'latitude', 'Lat', 'lat'],
  lng: ['Longitude', 'longitude', 'Lng', 'lng'],
  notes: ['Catatan', 'notes', 'Note', 'Keterangan']
};

/**
 * Urutan kolom pada template & export.
 *
 * Kolektor, OLT, dan Port PON ditaruh berdekatan dengan ODP karena sama-sama
 * data lapangan. Ketiganya ditulis dengan NAMA, bukan ID — admin tidak hafal
 * bahwa kolektor "Budi" bernomor 3, dan angka yang salah ketik akan menempel
 * ke orang yang keliru tanpa ketahuan.
 */
const HEADER_TEMPLATE = [
  'ID', 'Nama', 'Telepon', 'Email', 'Alamat', 'Paket', 'Router', 'Tipe Koneksi',
  'Tag ONU', 'PPPoE Username', 'Hotspot Username', 'Static IP', 'Isolir Profile',
  'Status', 'Tanggal Pasang', 'Auto Isolir', 'Tgl Isolir', 'ODP', 'OLT',
  'Port PON', 'Kolektor', 'Latitude', 'Longitude', 'Catatan'
];

/** Ambil nilai kolom dari baris, mencoba semua nama alternatif. */
function ambil(row, kunci) {
  for (const nama of (KOLOM[kunci] || [])) {
    if (row[nama] !== undefined && row[nama] !== null) return row[nama];
  }
  return undefined;
}

/** Jadikan teks bersih; angka dari Excel ikut ditangani. */
function teks(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/**
 * Rapikan nomor telepon.
 *
 * Excel gemar mengubah "085290587638" menjadi angka 85290587638 — angka nol di
 * depan hilang. Kalau dibiarkan, nomor tersimpan salah dan pesan WhatsApp tidak
 * pernah sampai. Semua bentuk dikembalikan ke format lokal 08xxx.
 */
function rapikanTelepon(v) {
  let s = teks(v).replace(/[\s\-().]/g, '');
  if (!s) return '';

  if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/\D/g, '');
  if (!s) return '';

  if (s.startsWith('62')) s = '0' + s.slice(2);
  else if (s.startsWith('8')) s = '0' + s;   // nol di depan yang dimakan Excel

  return s;
}

/**
 * Baca tanggal dari sel Excel.
 *
 * Sel tanggal bisa datang sebagai objek Date, angka serial Excel, atau teks.
 * Angka serial yang tidak diterjemahkan akan tersimpan sebagai "45874" dan
 * merusak perhitungan prorata.
 */
function rapikanTanggal(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);

  if (typeof v === 'number' && isFinite(v)) {
    // Serial Excel: hari sejak 30 Desember 1899.
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  const s = teks(v);
  if (!s || s === '-') return null;

  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);            // 2026-08-03
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);                // 03/08/2026
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

/** Terima banyak cara menulis "ya"/"tidak". */
function rapikanYaTidak(v, bawaan = 1) {
  if (v === undefined || v === null || v === '') return bawaan;
  const s = teks(v).toLowerCase();
  if (['ya', 'yes', 'y', '1', 'true', 'aktif', 'on'].includes(s)) return 1;
  if (['tidak', 'no', 'n', '0', 'false', 'nonaktif', 'off'].includes(s)) return 0;
  if (typeof v === 'number') return v ? 1 : 0;
  return bawaan;
}

const STATUS_SAH = ['active', 'suspended', 'inactive'];
const KONEKSI_SAH = ['pppoe', 'hotspot', 'static'];

/**
 * Periksa dan susun satu baris menjadi data pelanggan siap simpan.
 *
 * @returns {{ok:true, aksi:'buat'|'perbarui', data:object, id?:number, catatan:string[]}}
 *        | {ok:false, alasan:string}
 */
function periksaBaris(rowMentah, konteks) {
  const row = {};
  Object.keys(rowMentah || {}).forEach(k => { row[String(k).trim()] = rowMentah[k]; });

  const nama = teks(ambil(row, 'name'));
  if (!nama) return { ok: false, alasan: 'Kolom Nama kosong.' };

  const catatan = [];

  // ── Paket: wajib, karena tanpa paket pelanggan tidak bisa ditagih ──
  const namaPaket = teks(ambil(row, 'package'));
  let paket = null;
  if (namaPaket && namaPaket !== '-') {
    paket = konteks.packages.find(p => String(p.name).trim().toLowerCase() === namaPaket.toLowerCase());
    if (!paket) {
      return {
        ok: false,
        alasan: `Paket "${namaPaket}" tidak ada. Paket tersedia: ${konteks.packages.map(p => p.name).join(', ') || '(belum ada paket)'}.`
      };
    }
  } else {
    return { ok: false, alasan: 'Kolom Paket kosong. Pelanggan tanpa paket tidak bisa ditagih.' };
  }

  // ── Router: opsional, tetapi bila diisi harus benar ──
  const namaRouter = teks(ambil(row, 'router'));
  let router = null;
  if (namaRouter && namaRouter !== '-') {
    router = konteks.routers.find(r => String(r.name).trim().toLowerCase() === namaRouter.toLowerCase());
    if (!router) {
      return {
        ok: false,
        alasan: `Router "${namaRouter}" tidak ada. Router tersedia: ${konteks.routers.map(r => r.name).join(', ') || '(belum ada router)'}.`
      };
    }
  }

  // ── ODP: benar-benar opsional, salah ketik cukup jadi catatan ──
  const namaOdp = teks(ambil(row, 'odp'));
  let odp = null;
  if (namaOdp && namaOdp !== '-') {
    odp = konteks.odps.find(o => String(o.name).trim().toLowerCase() === namaOdp.toLowerCase());
    if (!odp) catatan.push(`ODP "${namaOdp}" tidak ditemukan — dikosongkan.`);
  }

  // ── OLT: opsional. Salah ketik hanya dicatat, sama seperti ODP, karena
  //    keduanya hanya keterangan lokasi perangkat — tidak memutus layanan.
  const namaOlt = teks(ambil(row, 'olt'));
  let olt = null;
  if (namaOlt && namaOlt !== '-') {
    olt = konteks.olts.find(o => String(o.name).trim().toLowerCase() === namaOlt.toLowerCase());
    if (!olt) catatan.push(`OLT "${namaOlt}" tidak ditemukan — dikosongkan.`);
  }

  // ── Kolektor: DITOLAK bila salah, tidak sekadar dicatat.
  //    Kolektor menentukan siapa yang berhak menagih dan menerima setoran.
  //    Mengosongkannya diam-diam berarti tagihan itu tidak tertagih oleh
  //    siapa pun, dan baru ketahuan saat uangnya kurang.
  const namaKolektor = teks(ambil(row, 'collector'));
  let kolektor = null;
  if (namaKolektor && namaKolektor !== '-') {
    kolektor = konteks.collectors.find(k => String(k.name).trim().toLowerCase() === namaKolektor.toLowerCase());
    if (!kolektor) {
      return {
        ok: false,
        alasan: `Kolektor "${namaKolektor}" tidak ada. Kolektor tersedia: ${konteks.collectors.map(k => k.name).join(', ') || '(belum ada kolektor)'}.`
      };
    }
  }

  // ── Tipe koneksi ──
  let koneksi = teks(ambil(row, 'connection')).toLowerCase() || 'pppoe';
  if (!KONEKSI_SAH.includes(koneksi)) {
    catatan.push(`Tipe Koneksi "${koneksi}" tidak dikenal — dipakai "pppoe".`);
    koneksi = 'pppoe';
  }

  const pppoe = teks(ambil(row, 'pppoe'));
  const hotspot = teks(ambil(row, 'hotspot'));
  const staticIp = teks(ambil(row, 'staticIp'));

  if (koneksi === 'pppoe' && !pppoe) {
    return { ok: false, alasan: 'Tipe Koneksi "pppoe" tetapi kolom PPPoE Username kosong.' };
  }
  if (koneksi === 'hotspot' && !hotspot) {
    return { ok: false, alasan: 'Tipe Koneksi "hotspot" tetapi kolom Hotspot Username kosong.' };
  }
  if (koneksi === 'static' && !staticIp) {
    return { ok: false, alasan: 'Tipe Koneksi "static" tetapi kolom Static IP kosong.' };
  }

  // ── Status ──
  let status = teks(ambil(row, 'status')).toLowerCase() || 'active';
  if (!STATUS_SAH.includes(status)) {
    catatan.push(`Status "${status}" tidak dikenal — dipakai "active".`);
    status = 'active';
  }

  // ── Tanggal isolir ──
  let tglIsolir = parseInt(teks(ambil(row, 'isolateDay')), 10);
  if (!Number.isFinite(tglIsolir) || tglIsolir < 1 || tglIsolir > 31) {
    if (teks(ambil(row, 'isolateDay')) && teks(ambil(row, 'isolateDay')) !== '-') {
      catatan.push(`Tgl Isolir "${teks(ambil(row, 'isolateDay'))}" tidak masuk akal — dipakai 10.`);
    }
    tglIsolir = 10;
  }

  const telepon = rapikanTelepon(ambil(row, 'phone'));
  const teleponAsli = teks(ambil(row, 'phone'));
  if (teleponAsli && telepon !== teleponAsli.replace(/[\s\-().+]/g, '')) {
    catatan.push(`Telepon dirapikan: "${teleponAsli}" → "${telepon}".`);
  }

  const data = {
    name: nama,
    phone: telepon,
    email: teks(ambil(row, 'email')),
    address: teks(ambil(row, 'address')),
    package_id: paket ? paket.id : null,
    router_id: router ? router.id : null,
    odp_id: odp ? odp.id : null,
    olt_id: olt ? olt.id : null,
    pon_port: teks(ambil(row, 'ponPort')) === '-' ? '' : teks(ambil(row, 'ponPort')),
    collector_id: kolektor ? kolektor.id : null,
    lat: teks(ambil(row, 'lat')),
    lng: teks(ambil(row, 'lng')),
    genieacs_tag: teks(ambil(row, 'onu')) === '-' ? '' : teks(ambil(row, 'onu')),
    pppoe_username: koneksi === 'pppoe' ? pppoe : '',
    hotspot_username: koneksi === 'hotspot' ? hotspot : '',
    static_ip: koneksi === 'static' ? staticIp : '',
    connection_type: koneksi,
    isolir_profile: teks(ambil(row, 'isolirProfile')) || 'isolir',
    status,
    install_date: rapikanTanggal(ambil(row, 'installDate')),
    auto_isolate: rapikanYaTidak(ambil(row, 'autoIsolate'), 0),
    isolate_day: tglIsolir,
    notes: teks(ambil(row, 'notes'))
  };

  // ── Tentukan: perbarui yang sudah ada, atau buat baru ──
  const idMentah = teks(ambil(row, 'id'));
  if (idMentah && idMentah !== '-') {
    const id = parseInt(idMentah, 10);
    if (!Number.isFinite(id)) {
      return { ok: false, alasan: `Kolom ID "${idMentah}" bukan angka.` };
    }
    if (!konteks.idAda.has(id)) {
      // Inilah kegagalan yang dulu terjadi diam-diam.
      return {
        ok: false,
        alasan: `ID ${id} tidak ada di database. Untuk MENAMBAH pelanggan baru, kosongkan kolom ID.`
      };
    }
    return { ok: true, aksi: 'perbarui', id, data, catatan };
  }

  // Tanpa ID = pelanggan baru. Pastikan tidak bentrok dengan yang sudah ada.
  if (data.pppoe_username) {
    const bentrok = konteks.pppoeAda.get(data.pppoe_username.toLowerCase());
    if (bentrok) {
      return { ok: false, alasan: `PPPoE Username "${data.pppoe_username}" sudah dipakai pelanggan "${bentrok}".` };
    }
  }
  if (data.phone) {
    const bentrok = konteks.teleponAda.get(data.phone);
    if (bentrok) {
      return { ok: false, alasan: `Telepon "${data.phone}" sudah dipakai pelanggan "${bentrok}".` };
    }
  }

  return { ok: true, aksi: 'buat', data, catatan };
}

/**
 * Jalankan import untuk sekumpulan baris hasil pembacaan Excel.
 *
 * @param {object[]} rows        hasil XLSX.utils.sheet_to_json
 * @param {object}   opsi
 * @param {boolean}  opsi.simulasi  true = hanya periksa, tidak menyimpan apa pun
 */
function importCustomers(rows, opsi = {}) {
  const simulasi = !!opsi.simulasi;

  const konteks = {
    packages: customerSvc.getAllPackages() || [],
    routers: mikrotikService.getAllRouters() || [],
    odps: odpSvc.getAllOdps() || [],
    olts: oltSvc.getAllOlts() || [],
    collectors: adminSvc.getAllCollectors() || [],
    idAda: new Set(),
    pppoeAda: new Map(),
    teleponAda: new Map()
  };

  for (const c of (customerSvc.getAllCustomers() || [])) {
    konteks.idAda.add(Number(c.id));
    if (c.pppoe_username) konteks.pppoeAda.set(String(c.pppoe_username).toLowerCase(), c.name);
    if (c.phone) konteks.teleponAda.set(String(c.phone), c.name);
  }

  const laporan = { total: 0, dibuat: 0, diperbarui: 0, gagal: 0, baris: [] };

  for (let i = 0; i < rows.length; i++) {
    // +2 supaya cocok dengan nomor baris di Excel (baris 1 = judul kolom)
    const noBaris = i + 2;
    const rowMentah = rows[i];

    // Baris yang seluruh selnya kosong dilewati tanpa dianggap gagal —
    // Excel kerap menyisakan baris kosong di bawah data.
    const adaIsi = Object.values(rowMentah || {}).some(v => teks(v) !== '');
    if (!adaIsi) continue;

    laporan.total++;
    let hasil;
    try {
      hasil = periksaBaris(rowMentah, konteks);
    } catch (e) {
      hasil = { ok: false, alasan: 'Kesalahan tak terduga: ' + e.message };
    }

    const nama = teks(ambil(rowMentah, 'name')) || '(tanpa nama)';

    if (!hasil.ok) {
      laporan.gagal++;
      laporan.baris.push({ baris: noBaris, nama, status: 'gagal', pesan: hasil.alasan });
      continue;
    }

    if (simulasi) {
      // Baris yang "akan dibuat" ikut didaftarkan ke konteks, sama seperti pada
      // import sungguhan. Tanpa ini, dua baris berisi nomor telepon sama di
      // dalam satu berkas akan lolos saat simulasi tetapi ditolak saat impor
      // dijalankan — pratinjau yang tidak cocok dengan hasil justru menyesatkan.
      if (hasil.aksi === 'buat') {
        if (hasil.data.pppoe_username) konteks.pppoeAda.set(hasil.data.pppoe_username.toLowerCase(), nama);
        if (hasil.data.phone) konteks.teleponAda.set(hasil.data.phone, nama);
      }

      laporan[hasil.aksi === 'buat' ? 'dibuat' : 'diperbarui']++;
      laporan.baris.push({
        baris: noBaris, nama,
        status: hasil.aksi === 'buat' ? 'akan dibuat' : 'akan diperbarui',
        pesan: hasil.catatan.join(' ')
      });
      continue;
    }

    // Simpan. Satu baris gagal tidak boleh menghentikan sisanya.
    try {
      if (hasil.aksi === 'perbarui') {
        const sebelum = customerSvc.getCustomerById(hasil.id);
        // cable_path TIDAK ada di Excel. Bila tidak diteruskan, updateCustomer
        // akan menulisnya menjadi NULL dan jalur kabel di peta jaringan hilang.
        customerSvc.updateCustomer(hasil.id, {
          ...hasil.data,
          cable_path: sebelum ? sebelum.cable_path : null
        });
        laporan.diperbarui++;
        laporan.baris.push({ baris: noBaris, nama, status: 'diperbarui', pesan: hasil.catatan.join(' ') });
      } else {
        const r = customerSvc.createCustomer(hasil.data);
        const idBaru = Number(r.lastInsertRowid);
        // Daftarkan ke konteks supaya baris berikutnya di file yang sama tidak
        // membuat duplikat dari data yang baru saja dibuat.
        konteks.idAda.add(idBaru);
        if (hasil.data.pppoe_username) konteks.pppoeAda.set(hasil.data.pppoe_username.toLowerCase(), nama);
        if (hasil.data.phone) konteks.teleponAda.set(hasil.data.phone, nama);

        laporan.dibuat++;
        laporan.baris.push({ baris: noBaris, nama, status: 'dibuat', pesan: hasil.catatan.join(' ') });
      }
    } catch (e) {
      laporan.gagal++;
      laporan.baris.push({ baris: noBaris, nama, status: 'gagal', pesan: 'Gagal menyimpan: ' + e.message });
      logger.error(`[Import] Baris ${noBaris} (${nama}) gagal: ${e.message}`);
    }
  }

  logger.info(`[Import] Selesai${simulasi ? ' (simulasi)' : ''}: ${laporan.dibuat} dibuat, ${laporan.diperbarui} diperbarui, ${laporan.gagal} gagal dari ${laporan.total} baris.`);
  return laporan;
}

module.exports = {
  importCustomers,
  HEADER_TEMPLATE,
  // diekspor untuk pengujian
  rapikanTelepon,
  rapikanTanggal,
  rapikanYaTidak,
  periksaBaris
};
