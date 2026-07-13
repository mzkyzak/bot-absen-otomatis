<div align="center">
  <h1>🤖 WA Bot Dashboard PKL (v2.0)</h1>
  <p>
    <b>Sistem buatan WhatsApp mzkyzak untuk Otomatisasi Absensi, Jurnal, dan Dokumentasi PKL Terintegrasi Web Portfolio (Firebase Backend)</b>
  </p>
  
  <p>
    <img src="https://img.shields.io/badge/Node.js-18.x-green.svg?style=flat-square&logo=node.js" alt="Node.js" />
    <img src="https://img.shields.io/badge/Baileys-WhatsApp_Web_API-25D366.svg?style=flat-square&logo=whatsapp" alt="Baileys" />
    <img src="https://img.shields.io/badge/Firebase-Firestore-FFCA28.svg?style=flat-square&logo=firebase" alt="Firebase" />
  </p>
</div>

---

## 📑 Daftar Isi
- [Tentang Project](#-tentang-project)
- [Fitur Unggulan v2.0](#-fitur-unggulan-v20)
- [Daftar Perintah (Commands)](#-daftar-perintah-commands)
- [Persiapan & Instalasi](#-persiapan--instalasi)
- [Keamanan Sistem](#-keamanan-sistem)

---

## 📖 Tentang Project

Sistem ini adalah bot WhatsApp tingkat lanjut yang dirancang khusus sebagai **asisten pribadi selama masa Praktek Kerja Lapangan (PKL)** di BPS Jakarta Pusat. Bot ini menggantikan pencatatan manual yang melelahkan menjadi sangat efisien; cukup kirim pesan WhatsApp, dan seluruh data (Absensi, Lokasi, Foto Bukti, Jurnal Kerja, dan Tugas) akan langsung **tersinkronisasi secara real-time ke Website Portfolio Dashboard**.

Versi 2.0 difokuskan **secara eksklusif** pada integrasi Firebase yang super cepat, ringan, dan stabil.

---

## 🚀 Fitur Unggulan v2.0

### 📊 Integrasi Real-time Dashboard (Firebase Firestore)
Seluruh data yang dikirim melalui WhatsApp akan langsung tampil di antarmuka *Dashboard Portfolio* berbasis React JS tanpa perlu memuat ulang (*refresh*) halaman.

### 📸 Smart HD Image Compression (Anti-Limit 1MB)
Menyimpan foto absen dan dokumentasi langsung ke database seringkali terkendala limit kapasitas per-dokumen Firestore (Maksimal 1MB). Bot ini dilengkapi *Engine Kompresi Pintar* (menggunakan library `sharp` & `mozjpeg`) yang memastikan:
- Kualitas visual tetap tajam (HD 1600px).
- Ukuran data Base64 selalu ditekan aman di bawah limit (`< 950KB`).

### 🗺️ Geotagging & Validasi Lokasi Otomatis
- Saat melakukan absen, bot akan memvalidasi *Link Google Maps* yang dikirimkan.
- Menyimpan koordinat dengan akurat untuk divisualisasikan di dalam Dashboard (tombol "Lihat Lokasi").

### 📋 Manajemen Prioritas (Tugas & Jurnal)
Mendukung sistem pelabelan visual (Tinggi 🔴, Sedang 🟡, Rendah 🟢) untuk tugas dan jurnal, sehingga tampilan log aktivitas di dashboard menjadi sangat rapi dan mudah dibaca oleh pembimbing.

---

## 💬 Daftar Perintah (Commands)

Cukup kirimkan format berikut langsung ke nomor Bot melalui WhatsApp:

| Tipe Data | Format Perintah & Penggunaan | Penjelasan |
| :--- | :--- | :--- |
| **Absen Hadir** | Kirim Foto + Caption: `absen` <br> _(Lalu kirimkan link Google Maps)_ | Mencatat jam masuk, tanggal, lokasi GPS, dan menyimpan foto bukti hadir secara otomatis. |
| **Sakit / Izin** | Kirim Foto + Caption: `sakit [alasan]` <br> _atau_ `izin [alasan]` | Mengajukan status berhalangan hadir beserta foto buktinya (misal: surat dokter/surat izin). |
| **Dokumentasi** | Kirim Foto + Caption: `dokumentasi [judul]` | Menyimpan foto kegiatan (HD) langsung ke Galeri Web Portfolio. |
| **Jurnal Harian** | Teks: `jurnal [aktivitas]` <br> Teks: `jurnal tinggi [aktivitas] 🔴` <br> Teks: `jurnal sedang [aktivitas] 🟡` <br> Teks: `jurnal rendah [aktivitas] 🟢` | Mencatat log pekerjaan harian secara cepat tanpa foto. (Default: Sedang). |
| **Tugas PKL** | Teks: `tugas [keterangan]` <br> _atau tambahkan label tinggi/sedang/rendah_ | Mencatat daftar tugas/to-do list dari pembimbing kantor. |
| **Bantuan** | Teks: `menu` / `help` / `info` | Menampilkan panduan dan status *uptime* dari Bot. |

---

## ⚙️ Persiapan & Instalasi

### 1. Prasyarat Sistem
- **Node.js** (Versi 16 atau terbaru)
- Akun dan Project **Firebase** (Firestore Database aktif)
- Nomor WhatsApp terdedikasi untuk bot (Bisa pakai akun sekunder/bisnis).

### 2. Kloning & Install Dependensi
Buka terminal dan arahkan ke dalam folder direktori bot:
```bash
npm install
```

### 3. Konfigurasi Sistem (Credentials)
1. Ubah nama file `.env.example` menjadi `.env`.
2. Buka `.env` dan isi dengan nomor WhatsApp pribadi/admin Anda (menggunakan kode negara, tanpa `+`). Contoh:
   ```env
   ADMIN_NUMBERS=6281234567890
   BOT_NAME=Bot PKL
   ```
3. Unduh **Private Key** dari pengaturan project Firebase Anda (`Project Settings > Service Accounts > Generate new private key`).
4. Ubah nama file JSON yang diunduh menjadi `serviceAccountKey.json` dan letakkan di dalam root folder bot.

### 4. Menjalankan Bot
```bash
npm start
```
Atau secara manual:
```bash
node index.js
```
Akan muncul sebuah **QR Code** di layar terminal Anda. Buka aplikasi WhatsApp di HP bot, masuk ke menu *Tautkan Perangkat*, dan pindai QR Code tersebut. Setelah status tertulis `Terhubung`, bot siap melayani Anda!

---

## 🔒 Keamanan Sistem

Bot ini mengadopsi sistem keamanan **Strict Whitelisting** (Eksklusif / Privat).
- Bot **TIDAK AKAN** merespons pesan, panggilan, atau perintah apapun dari nomor asing yang tidak terdaftar di variabel `ADMIN_NUMBERS` pada file `.env`.
- Fitur ini menghemat *resource* memori server dan memastikan data database Portfolio Anda bebas dari spam/tangan jahil.

---
<div align="center">
  <p><i>Full Stack Developer | Creating Internship Management with Taufiq Ikhsan muzaky (mzkyzak) ❤️</i></p>
</div>
