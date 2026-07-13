// Firebase Admin SDK — Koneksi ke Firebase dari Server
const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config();

let db, bucket;

function initFirebase() {
  if (admin.apps.length > 0) return; // Sudah diinisialisasi

  // Cek apakah pakai Service Account Key JSON (file lokal)
  // atau Environment Variable (untuk Railway/Render)
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Mode Railway/Render: paste JSON sebagai env variable
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON tidak valid JSON:", e.message);
      process.exit(1);
    }
  } else {
    // Mode lokal: baca dari file serviceAccountKey.json
    const keyPath = path.join(__dirname, "serviceAccountKey.json");
    try {
      serviceAccount = require(keyPath);
    } catch (e) {
      console.error("❌ File serviceAccountKey.json tidak ditemukan di:", keyPath);
      console.error("   Download dari: Firebase Console → Project Settings → Service Accounts → Generate new private key");
      process.exit(1);
    }
  }

  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || "device-streaming-d7bccff2.firebasestorage.app";

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: storageBucket,
  });

  db = admin.firestore();
  bucket = admin.storage().bucket();

  console.log("✅ Firebase Admin SDK terhubung!");
}
async function uploadPhotoToFirestore(imageBuffer, absenId) {
  if (!imageBuffer || imageBuffer.length === 0) return "";
  try {
    const sharp = require("sharp");

    const originalSize = imageBuffer.length;
    console.log(`📷 Foto asli: ${(originalSize / 1024).toFixed(0)} KB`);

    // Target: max ~730KB binary (karena base64 akan membesar 33% menjadi ~980KB)
    // Batas absolut Firestore adalah 1MB per dokumen.
    let compressed;
    let quality = 90; // Kualitas tinggi (HD)
    let width = 1600; // Resolusi HD

    compressed = await sharp(imageBuffer)
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true }) // mozjpeg for better compression
      .toBuffer();

    // Jika ukuran base64 akan melebihi batas aman (binary > 730KB), turunkan perlahan
    if (compressed.length > 730 * 1024) {
      compressed = await sharp(imageBuffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    }

    if (compressed.length > 730 * 1024) {
      compressed = await sharp(imageBuffer)
        .resize({ width: 1000, withoutEnlargement: true })
        .jpeg({ quality: 75, mozjpeg: true })
        .toBuffer();
    }

    // Fallback darurat jika foto masih sangat besar
    if (compressed.length > 730 * 1024) {
      compressed = await sharp(imageBuffer)
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 65, mozjpeg: true })
        .toBuffer();
    }

    console.log(`✅ Foto terkompresi: ${(compressed.length / 1024).toFixed(0)} KB`);

    const base64 = "data:image/jpeg;base64," + compressed.toString("base64");

    // Simpan ke koleksi dashboard — satu dokumen per foto
    await db.collection("dashboard").doc("photo_" + String(absenId)).set({
      photoData: base64,
      uploadedAt: Date.now(),
      originalSizeKB: Math.round(originalSize / 1024),
      compressedSizeKB: Math.round(compressed.length / 1024),
    });
    return "photo_" + String(absenId); // return ID sebagai referensi
  } catch (e) {
    console.warn("⚠️  Gagal simpan foto absen:", e.message);
    return "";
  }
}

// Tambahkan record absen ke Firestore
async function tambahAbsen({ photoBuffer, photoUrl, pengirim, jam, tanggal, hari, lokasi, koordinat, gmapsUrl, status, skipDuplikat, keterangan }) {
  const docRef = db.collection("dashboard").doc("absenHistory");
  const snap = await docRef.get();
  const absenId = Date.now();

  // Upload foto ke koleksi terpisah jika ada buffer foto
  let photoRef = "";
  if (photoBuffer && photoBuffer.length > 0) {
    photoRef = await uploadPhotoToFirestore(photoBuffer, absenId);
  } else if (photoUrl) {
    photoRef = photoUrl; // fallback jika sudah ada URL
  }

  const newEntry = {
    id: absenId,
    date: tanggal,
    day: hari,
    status: status || "Hadir",
    timeIn: jam,
    checkOut: "-",
    locationName: lokasi || "Via WhatsApp Bot",
    ...(koordinat ? { koordinat } : {}),
    ...(gmapsUrl ? { gmapsUrl } : {}),
    photo: photoRef, // ID referensi ke absenPhotos, atau kosong
    reason: keterangan || `Absen via WhatsApp (${pengirim})`,
    pengirim: pengirim,
  };

  if (snap.exists) {
    const currentData = snap.data().data || [];
    if (!skipDuplikat) {
      const baseTanggal = tanggal.replace(/^🧪 TEST /, "");
      const sudahAbsen = currentData.find(
        (item) => item.date === baseTanggal &&
          !item.date.startsWith("🧪") &&
          ((item.pengirim && item.pengirim === pengirim) || (item.reason && item.reason.includes(pengirim)))
      );
      if (sudahAbsen) return { success: false, alreadyAbsent: true, existingStatus: sudahAbsen.status || "Hadir" };
    }
    await docRef.update({ data: [newEntry, ...currentData] });
  } else {
    await docRef.set({ data: [newEntry] });
  }

  return { success: true, entry: newEntry };
}

// =====================================================
// Tambah Dokumentasi ke Firestore (base64 — gratis!)
// =====================================================
async function tambahDokumentasi({ imageBuffer, judul, tanggal }) {
  // Compress & convert ke base64 (sama seperti yang dilakukan React app)
  const base64 = "data:image/jpeg;base64," + imageBuffer.toString("base64");

  const newPhoto = {
    id: Date.now(),
    url: base64,
    title: judul || "Dokumentasi PKL",
    date: tanggal,
  };

  // Simpan ke koleksi dokumentasi_pkl (sama persis dengan React app)
  await db.collection("dokumentasi_pkl").add(newPhoto);
  return { success: true };
}

// =====================================================
// Tambah Jurnal ke Firestore
// =====================================================
async function tambahJurnal({ aktivitas, priority, tanggal }) {
  const docRef = db.collection("dashboard").doc("jurnalHistory");
  const snap = await docRef.get();

  const newEntry = {
    id: Date.now(),
    title: aktivitas,
    status: "Menunggu",
    date: tanggal,
    priority: priority || "Sedang",
  };

  if (snap.exists) {
    const currentData = snap.data().data || [];
    // Cek apakah sudah ada jurnal hari ini
    const sudahJurnal = currentData.find((item) => item.date === tanggal);
    if (sudahJurnal) {
      return { success: false, alreadyExists: true, existingTitle: sudahJurnal.title };
    }
    await docRef.update({ data: [newEntry, ...currentData] });
  } else {
    await docRef.set({ data: [newEntry] });
  }

  return { success: true, entry: newEntry };
}

// =====================================================
// Tambah Tugas PKL ke Firestore
// =====================================================
async function tambahTugas({ judul, priority, tanggal }) {
  const docRef = db.collection("dashboard").doc("tugasHistory");
  const snap = await docRef.get();

  const newTask = {
    id: Date.now(),
    title: judul,
    status: "Menunggu",
    date: tanggal,
    priority: priority || "Sedang",
  };

  if (snap.exists) {
    const currentData = snap.data().data || [];
    await docRef.update({ data: [newTask, ...currentData] });
  } else {
    await docRef.set({ data: [newTask] });
  }

  return { success: true, entry: newTask };
}

module.exports = { initFirebase, uploadPhoto: uploadPhotoToFirestore, tambahAbsen, tambahDokumentasi, tambahJurnal, tambahTugas };

