#!/bin/bash
# ============================================================================
#  update.sh — Tarik pembaruan dari GitHub lalu restart aplikasi
# ----------------------------------------------------------------------------
#  Pakai:  bash update.sh
#
#  Yang dilakukan:
#    1. Mencadangkan settings.json + database sebelum menyentuh apa pun
#    2. Menolak lanjut bila ada perubahan lokal yang belum disimpan
#       (mencegah pekerjaan Anda tertimpa diam-diam)
#    3. git pull -> npm install -> pm2 restart
#    4. Memverifikasi aplikasi benar-benar hidup setelah restart
#
#  Data TIDAK ikut tertimpa: settings.json, database/, auth_info_baileys/,
#  public/uploads/ semuanya sudah ada di .gitignore.
# ============================================================================

set -e

APP_NAME="${APP_NAME:-billing-rtrw}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$HOME/billing-backup/$(date +%Y%m%d-%H%M%S)"

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'
ok()   { echo -e "${G}[OK]${N} $1"; }
info() { echo -e "${B}[INFO]${N} $1"; }
warn() { echo -e "${Y}[PERINGATAN]${N} $1"; }
die()  { echo -e "${R}[GAGAL]${N} $1"; exit 1; }

cd "$SCRIPT_DIR"

echo ""
echo "════════════════════════════════════════════"
echo "  UPDATE $APP_NAME"
echo "════════════════════════════════════════════"
echo ""

# ── 1. Pastikan ini repo git ────────────────────────────────────────────────
[ -d .git ] || die "Folder ini bukan repo git. Jalankan 'git clone' dulu, jangan salin manual."

# ── 2. Cadangkan data penting ───────────────────────────────────────────────
info "Mencadangkan konfigurasi & database..."
mkdir -p "$BACKUP_DIR"
[ -f settings.json ] && cp settings.json "$BACKUP_DIR/"
[ -d database ] && cp -r database "$BACKUP_DIR/"
[ -d auth_info_baileys ] && cp -r auth_info_baileys "$BACKUP_DIR/"
ok "Cadangan tersimpan di $BACKUP_DIR"

# ── 3. Tolak bila ada perubahan lokal yang belum disimpan ───────────────────
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  warn "Ada perubahan lokal yang belum di-commit:"
  git status --short --untracked-files=no | sed 's/^/    /'
  echo ""
  echo "  Pilihan Anda:"
  echo "    git stash          -> simpan sementara, lalu jalankan update lagi"
  echo "    git checkout -- .  -> BUANG perubahan lokal (tidak bisa dibatalkan)"
  echo ""
  die "Update dihentikan supaya perubahan Anda tidak hilang."
fi

# ── 4. Tarik pembaruan ──────────────────────────────────────────────────────
BEFORE=$(git rev-parse --short HEAD)
info "Menarik pembaruan dari GitHub..."
git pull || die "git pull gagal. Cek koneksi internet atau kredensial GitHub."
AFTER=$(git rev-parse --short HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  ok "Sudah versi terbaru ($AFTER). Tidak ada yang perlu diperbarui."
  echo ""
  exit 0
fi

echo ""
info "Perubahan $BEFORE -> $AFTER:"
git log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'
echo ""

# ── 5. Perbarui dependensi hanya bila package.json berubah ──────────────────
if git diff --name-only "$BEFORE" "$AFTER" | grep -q "package.json"; then
  info "package.json berubah — menjalankan npm install..."
  npm install --omit=dev || die "npm install gagal."
  ok "Dependensi diperbarui."
else
  info "package.json tidak berubah — npm install dilewati."
fi

# ── 6. Restart ──────────────────────────────────────────────────────────────
info "Merestart aplikasi..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  warn "Proses '$APP_NAME' belum ada di PM2, membuat baru..."
  pm2 start app-customer.js --name "$APP_NAME"
fi
pm2 save > /dev/null 2>&1 || true

# ── 7. Pastikan benar-benar hidup ───────────────────────────────────────────
sleep 4
STATUS=$(pm2 jlist 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const a=JSON.parse(s).find(x=>x.name==='$APP_NAME');
      console.log(a?a.pm2_env.status:'notfound');}catch(e){console.log('unknown');}});
" 2>/dev/null || echo unknown)

echo ""
if [ "$STATUS" = "online" ]; then
  ok "Aplikasi berjalan normal (versi $AFTER)."
else
  warn "Status aplikasi: $STATUS — periksa log:"
  echo "    pm2 logs $APP_NAME --err --lines 40"
  echo ""
  echo "  Untuk kembali ke versi sebelumnya:"
  echo "    git reset --hard $BEFORE && pm2 restart $APP_NAME"
fi

echo ""
echo "  Cadangan  : $BACKUP_DIR"
echo "  Lihat log : pm2 logs $APP_NAME"
echo ""
