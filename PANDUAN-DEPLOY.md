# Panduan Deploy — Push ke GitHub Sendiri

Panduan ini untuk memindahkan proyek ke repo GitHub Anda, lalu memperbarui
server produksi cukup dengan `git pull`, **tanpa** mengganggu pengaturan,
database, dan sesi WhatsApp yang sudah berjalan.

---

## Konsep dasar

Bayangkan proyek ini punya dua bagian:

| | Contoh | Ikut Git? |
|---|---|---|
| **Kode** | `routes/`, `services/`, `views/`, `public/css/` | ✅ Ya |
| **Data & rahasia** | `settings.json`, `database/`, `auth_info_baileys/`, `public/uploads/` | ❌ Tidak |

Kode boleh ditimpa saat `git pull` — memang itu tujuannya.
Data **tidak boleh** tertimpa, karena tiap server punya isinya sendiri.

Pemisahan ini diatur oleh berkas `.gitignore` yang sudah disiapkan.

---

## ⚠️ Baca dulu sebelum push

`settings.json` Anda berisi:

- Password admin
- `session_secret` dan `admin_api_key`
- Password MikroTik & GenieACS
- API key payment gateway (Tripay, Midtrans, Xendit, Duitku), Digiflazz
- Token bot Telegram

Folder `auth_info_baileys/` berisi **kredensial login WhatsApp** — kalau bocor,
bot WhatsApp Anda bisa dipakai orang lain.

Menambahkan berkas ke `.gitignore` **tidak otomatis** mengeluarkannya dari Git
kalau sebelumnya sudah pernah ter-commit. Langkah 2 di bawah menangani itu.
**Jangan dilewati.**

---

## Langkah 1 — Buat repo di GitHub

Buat repo baru, misalnya `billing-rtrw`. Kalau ragu soal kebocoran rahasia,
pilih **Private** dulu; bisa diubah ke Public nanti.

Jangan centang "Add a README" — repo harus kosong.

---

## Langkah 2 — Siapkan folder lokal (di komputer Windows Anda)

```bash
cd "N:\Claude Zone\Remake Billing"

git init                     # lewati bila sudah ada folder .git
git remote remove origin     # lepas remote lama (repo orang), abaikan bila error
git remote add origin https://github.com/USERNAME-ANDA/billing-rtrw.git
```

**Penting** — keluarkan berkas rahasia dari pantauan Git.
Perintah `--cached` hanya melepas dari Git; **berkas di komputer Anda tetap aman**:

```bash
git rm -r --cached settings.json database auth_info_baileys data public/uploads node_modules
git rm --cached public/img/logo.png public/img/signature.png
```

Kalau muncul `did not match any files`, artinya berkas itu memang belum
terlacak Git — aman, lanjut saja.

Pastikan `settings.json` benar-benar tidak ikut:

```bash
git status --short | grep settings.json
```

Kalau **tidak ada keluaran**, berarti aman.
Kalau muncul, berarti masih terlacak — ulangi `git rm --cached settings.json`.

---

## Langkah 3 — Push pertama

```bash
git add .
git commit -m "Fork: fitur peta server/tiang, grafik trafik, invoice A4, perbaikan QRIS"
git branch -M main
git push -u origin main
```

---

## Langkah 4 — Hubungkan server produksi (Debian)

Server Anda sekarang berisi salinan dari repo orang lain. Arahkan ke repo Anda:

```bash
cd ~/billing-rtrw

# Amankan dulu konfigurasi & data yang sedang jalan
cp settings.json ~/settings.json.backup
cp -r database ~/database.backup

git remote set-url origin https://github.com/USERNAME-ANDA/billing-rtrw.git
git fetch origin
git checkout -B main origin/main
git pull origin main
```

Kalau Git menolak karena ada perubahan lokal yang bentrok:

```bash
git stash          # simpan sementara perubahan lokal
git pull origin main
```

Pastikan konfigurasi lama masih utuh, lalu jalankan:

```bash
ls -la settings.json          # harus masih ada
npm install
pm2 restart billing-rtrw
pm2 logs billing-rtrw --lines 40
```

---

## Alur kerja sehari-hari

**Di komputer Anda** (setelah mengubah kode):

```bash
git add .
git commit -m "jelaskan perubahannya"
git push
```

**Di server produksi:**

```bash
cd ~/billing-rtrw && git pull && npm install && pm2 restart billing-rtrw
```

Pakai `pm2 restart`, **jangan** `pm2 start -f` — itu membuat proses ganda.
Kalau sampai ada dua proses, yang lama tetap memakai kode lama dan akan
memunculkan error aneh (mis. `... is not defined`).

Cek jumlah proses kapan saja dengan `pm2 status`. Kalau ada yang dobel:

```bash
pm2 delete all
pm2 start app-customer.js --name billing-rtrw
pm2 save
```

---

## Instalasi di server baru

```bash
git clone https://github.com/USERNAME-ANDA/billing-rtrw.git
cd billing-rtrw
npm install
npm start
```

`settings.json` akan dibuat otomatis dari `settings.example.json` saat pertama
kali dijalankan. Setelah itu buka `/admin/login` (bawaan `admin` / `GANTI-PASSWORD-INI`)
lalu **segera ganti** di menu Pengaturan:

- Password admin
- `session_secret` dan `admin_api_key` — isi string acak panjang
- Kredensial MikroTik, GenieACS, payment gateway

Tabel database dibuat otomatis. Logo (`public/img/logo.png`) dan tanda tangan
(`public/img/signature.png`, 600 × 240 px PNG transparan) di-upload lewat
menu Pengaturan.

---

## Menarik pembaruan dari repo asal

Kalau pembuat aslinya merilis fitur baru dan Anda ingin mengambilnya:

```bash
git remote add upstream https://github.com/alijayanet/billing-rtrw.git
git fetch upstream
git merge upstream/main
```

Kemungkinan besar akan ada konflik pada berkas yang kita ubah
(daftarnya di `CHANGELOG.md`). Selesaikan konflik, uji di lokal, baru push.

Sarannya: lakukan ini di komputer lokal, jangan langsung di server produksi.

---

## Kalau terjadi masalah

**Aplikasi tidak mau start setelah pull**

```bash
pm2 logs billing-rtrw --err --lines 50
```

**Pengaturan hilang setelah pull**

Berarti `settings.json` sempat terlacak Git. Pulihkan dari cadangan:

```bash
cp ~/settings.json.backup settings.json
pm2 restart billing-rtrw
```

Lalu keluarkan dari Git: `git rm --cached settings.json && git commit -m "keluarkan settings" && git push`

**Kembali ke versi sebelumnya**

```bash
git log --oneline -5      # lihat daftar commit
git checkout <kode-commit>
pm2 restart billing-rtrw
```
