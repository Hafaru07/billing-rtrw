# Catatan Perubahan

Fork ini berbasis [alijayanet/billing-rtrw](https://github.com/alijayanet/billing-rtrw).
Berkas ini mencatat apa saja yang ditambahkan/diperbaiki, supaya mudah diingat
saat menarik pembaruan dari repo asal.

---

## Fitur Baru

### Peta Jaringan — Server & Tiang
Sebelumnya peta hanya punya ODP. Sekarang topologi penuh:
**Server → Tiang → Tiang → ODP → Pelanggan**

- Tabel baru `servers` (POP/OLT/Router/Backbone/BTS) dan `poles` (beton/besi/kayu/numpang)
- Kolom baru di `odps`: `server_id`, `pole_id`, `cable_path`
- Jalur kabel tiap segmen bisa digambar manual (tarik titik), sama seperti ODP→Pelanggan
- Penanda: Server ungu, Tiang hijau, ODP oranye
- Penjaga rantai melingkar — tiang tidak bisa jadi induk dirinya/turunannya
- Menghapus server/tiang hanya melepas anaknya, **tidak** menghapus berantai
- Peta teknisi menampilkan keduanya (hanya-lihat)

**Berkas:** `services/serverService.js`, `services/poleService.js` (baru),
`services/odpService.js`, `routes/adminPortal.js`, `routes/techPortal.js`,
`views/admin/map.ejs`, `views/tech/map.ejs`, `config/database.js`

### Grafik Trafik MikroTik di Dashboard
Tiga kartu grafik RX/TX realtime, tiap kartu bisa memilih router + interface sendiri.

- Refresh 2 detik, konfigurasi tersimpan di database (berlaku untuk semua admin)
- Cache sisi server 1,8 detik + dedupe — beban ke router tetap sama
  berapa pun jumlah admin yang membuka dashboard
- Interface pada router yang sama digabung jadi satu koneksi RouterOS
- Polling berhenti otomatis saat tab disembunyikan

**Berkas:** `services/mikrotikService.js`, `routes/adminPortal.js`, `views/admin/dashboard.ejs`

### Invoice A4 Profesional
Sebelumnya hanya struk termal 58mm polos.

- Invoice A4 berlogo: rincian Biaya Bulanan + PPN, stempel LUNAS/BELUM LUNAS,
  jatuh tempo, info pembayaran (QRIS/rekening), terbilang, tanda tangan digital
- PPN memakai model **harga sudah termasuk pajak** — total yang dibayar pelanggan
  tidak berubah, invoice hanya memecahnya jadi DPP + PPN
- Struk termal tetap ada di `?format=thermal`
- Tombol cetak juga muncul untuk tagihan **belum lunas**
- Tanda tangan: taruh di `public/img/signature.png`, ukuran ideal **600 × 240 px** PNG transparan

**Berkas:** `views/admin/print_invoice.ejs`, `views/admin/print_invoice_thermal.ejs` (baru),
`routes/adminPortal.js`, `views/admin/billing.ejs`

### Laporan Laba/Rugi Dirombak
- Rincian **pemasukan** (sebelumnya hanya angka gelondongan) + rincian pengeluaran
- Kolom porsi % dan bar proporsi tiap kategori
- Label otomatis jadi "Rugi Bersih" saat minus
- Header/footer bawaan browser (URL, nomor halaman) dihilangkan

**Berkas:** `views/admin/reports_print.ejs`, `routes/adminPortal.js`

### Tampilan Responsif (HP)
Satu lapisan CSS global menjinakkan inline style tanpa mengedit puluhan view.

- Grid kolom tetap otomatis menumpuk di layar sempit
- Tabel lebar bergulir di wadahnya, bukan mendorong seluruh halaman
- Input dipaksa 16px di HP — mencegah iOS Safari zoom paksa saat mengetik
- `100vh` → `100dvh` supaya bagian bawah tidak tertutup bilah browser

**Berkas:** `public/css/responsive.css` (baru), `public/css/admin.css`, +63 view

---

## Perbaikan Bug

### QRIS tidak pernah terkirim ke WhatsApp — `Jimp.read is not a function`
`package.json` memakai **jimp v1.6**, tapi kode ditulis dengan gaya v0.x:

```js
const Jimp = require('jimp');   // v1.x mengembalikan OBJEK, bukan kelas
Jimp.read(...)                  // undefined -> TypeError
```

Setiap pembuatan gambar QRIS gagal, lalu error ditelan `catch` tanpa log —
sehingga bertahun-tahun tampak "hanya kirim teks" tanpa sebab yang jelas.

**Perbaikan:** Jimp dibuang dari pembuatan QR (PNG langsung dari pustaka QRCode —
lossless dan ~5× lebih kecil). API Jimp diperbaiki untuk jalur baca QRIS dari
gambar, plus dekoder cadangan jsQR. Error tidak lagi ditelan.

### Struk termal selalu tertulis "LUNAS"
Teks status di-hardcode tanpa cek. Tagihan belum bayar tercetak seolah lunas.

### Nominal unik QRIS tidak tampil di invoice
Invoice mencetak nominal dasar, padahal pelanggan harus membayar nominal unik
agar pencocokan otomatis berhasil. Akibatnya fitur kode unik jadi sia-sia.

### `createInstallProrataCatchUpInvoice()` selalu error
Mengembalikan variabel `amount` yang tidak pernah dideklarasikan → ReferenceError.

### Pengingat tagihan otomatis
- Jam kirim dikunci **07:00** dengan timezone eksplisit (`node-cron` memakai
  timezone OS bila tidak diberi — di VPS UTC, 07:00 meleset jadi 14:00 WIB)
- Jeda antar pesan diacak **30–120 detik** (sebelumnya tetap, lebih mirip bot)
- Bisa **dilanjutkan setelah restart** — tabel `billing_reminder_logs` menandai
  siapa yang sudah dikirimi, jadi proses 4 jam yang terpotong tidak diulang dari awal
- `isolate_day = 1` sebelumnya **tidak pernah** dapat pengingat (0×/tahun);
  tanggal 29/30/31 terlewat di bulan pendek. Sudah diperbaiki: semua 12×/tahun
- Pengingat otomatis kini ikut mengirim **gambar QRIS** dengan nominal tertanam

### Tagihan bulanan bisa hangus sebulan penuh
`node-cron` tidak menjalankan jadwal yang terlewat. Kalau server mati saat
tanggal 1 pukul 00:01, tagihan sebulan tidak pernah dibuat — pengingat dan
isolir otomatis ikut mati, tanpa error apa pun.

**Perbaikan:** pengaman saat startup + cron harian 00:30 yang memastikan tagihan
bulan berjalan lengkap. Idempoten, tidak membuat tagihan dobel.

### Nominal unik QRIS terlalu besar
Rentang 1–999 → **1–20** (bisa diatur di Pengaturan). Tagihan Rp 150.000
jadi Rp 150.007, bukan Rp 150.847.

### Tombol "Fokus" ODP di peta error
`odpMarkers` menyimpan array koordinat tapi kode mengakses `.marker`.

---

## Pengaturan Baru

| Kunci | Bawaan | Fungsi |
|---|---|---|
| `invoice_ppn_percentage` | `12` | PPN yang dipecah di invoice |
| `qris_unique_min` / `qris_unique_max` | `1` / `20` | Rentang kode unik QRIS |
| `invoice_bank_name` / `_account` / `_holder` | kosong | Info transfer di invoice |
| `invoice_note` | kosong | Catatan/syarat di invoice |

## Tabel Database Baru

`servers`, `poles`, `billing_reminder_logs`
Kolom baru di `odps`: `server_id`, `pole_id`, `cable_path`

Semua dibuat otomatis saat aplikasi start — **tidak perlu migrasi manual**.
