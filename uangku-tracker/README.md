# UangKu — Catatan & Rekomendasi Keuangan (Desktop & Android PWA)

Aplikasi catatan keuangan **Progressive Web App (PWA)** dengan sinkronisasi real-time paralel antara **Desktop** dan **Android**, dilengkapi rekap pengeluaran per kategori, evaluasi aturan 50/30/20, batas belanja harian aman (*Safe-to-Spend*), dan rekomendasi pengelolaan uang otomatis.

## Fitur Utama
- **Berjalan Paralel di Desktop & Android**:
  - Dapat di-install sebagai aplikasi native-like (PWA) di Windows/macOS (Chrome/Edge) dan Android (Chrome).
  - Sinkronisasi real-time via Server-Sent Events (`/api/events`) + antrean offline otomatis saat perangkat tidak terhubung internet.
  - Pairing cepat antar perangkat menggunakan **Link Pairing** & **Kode Workspace** (plus dukungan PIN keamanan opsional).
- **Tracking Kemana Saja Uangku**:
  - Catat pemasukan, pengeluaran, dan transfer antar dompet (`Tunai`, `Rekening Bank`, `E-Wallet/QRIS`).
  - Pencarian & filter berdasarkan tipe, kategori, dompet, dan bulan.
- **Rekap Habis di Bagian Apa**:
  - Grafik donat & breakdown kategori dengan persentase, frekuensi transaksi, perbandingan bulan lalu, dan status batas anggaran (*budget*).
  - Evaluasi **50/30/20** (Needs / Wants / Savings), tren harian, dan 5 pengeluaran terbesar.
- **Rekomendasi Kedepannya**:
  - **Skor Kesehatan Keuangan (0–100)**.
  - **Batas Aman Belanja Harian (Safe-to-Spend)** sesuai sisa hari bulan berjalan.
  - Deteksi lonjakan kategori, kebiasaan pengeluaran kecil berulang (*Latte Factor*), proyeksi dana darurat, dan saran target budget bulan depan.

## Menjalankan Secara Lokal (Desktop + Android dalam 1 Wi-Fi)
```bash
npm start
```
Buka `http://localhost:3000` di Desktop, dan buka alamat IP Wi-Fi yang tampil di terminal pada Chrome Android (atau salin **Link Pairing** di menu *Sync & Pengaturan*).

## Deploy ke Cloud (Sinkronisasi Beda Jaringan)
Proyek ini bebas dependensi eksternal (*zero-dependency Node.js*) dan siap di-deploy ke **Render**, **Railway**, **Fly.io**, atau **Docker**:
- Menggunakan `Dockerfile` atau `render.yaml` yang sudah tersedia.
- Setelah online (HTTPS), masukkan URL server cloud tersebut pada menu **Sync & Pengaturan** di Desktop maupun Android agar keduanya tersinkronisasi dari mana saja.

## Rekap & Otomatisasi CLI
```bash
npm run recap -- --ws pribadi --save
npm test
```
