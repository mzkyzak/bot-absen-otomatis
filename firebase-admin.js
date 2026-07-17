// Firebase Admin SDK — Koneksi ke Firebase dari Server
const admin = require("firebase-admin");
const path = require("path");
const { spawn } = require("child_process");
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

// Helper: Kompresi gambar dengan FFmpeg (anti error di Termux)
async function compressImage(imageBuffer, maxWidth = 1200, qscale = 2) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-vf", `scale='min(${maxWidth},iw)':-2`, // -2 penting agar tinggi gambar genap (mencegah error codec mjpeg)
      "-qscale:v", `${qscale}`,                 
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1"
    ]);

    const chunks = [];
    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error("FFmpeg gagal kompres foto, kode: " + code));
    });
    ffmpeg.on("error", (err) => reject(new Error("FFmpeg error: " + err.message)));

    ffmpeg.stdin.write(imageBuffer);
    ffmpeg.stdin.end();
  });
}

async function uploadPhotoToFirestore(imageBuffer, absenId) {
  if (!imageBuffer || imageBuffer.length === 0) return "";
  try {
    const originalSize = imageBuffer.length;
    console.log(`📷 Foto asli: ${(originalSize / 1024).toFixed(0)} KB`);

    // Menggunakan FFmpeg untuk kompresi awal (Kualitas Max)
    let compressed = await compressImage(imageBuffer, 1200, 2);

    // Fallback darurat jika ukuran melebihi batas aman Firestore (1MB limit -> max ~730KB binary)
    if (compressed.length > 730 * 1024) {
      console.log(`⚠️ Ukuran terlalu besar (${(compressed.length/1024).toFixed(0)} KB), mencoba kompresi level 2...`);
      compressed = await compressImage(imageBuffer, 1000, 5);
    }
    if (compressed.length > 730 * 1024) {
      console.log(`⚠️ Ukuran masih besar (${(compressed.length/1024).toFixed(0)} KB), mencoba kompresi level 3...`);
      compressed = await compressImage(imageBuffer, 800, 10);
    }

    console.log(`✅ Foto terkompresi (FFmpeg): ${(compressed.length / 1024).toFixed(0)} KB`);

    const base64 = "data:image/jpeg;base64," + compressed.toString("base64");

    // Kembalikan base64 secara langsung ke array absenHistory 
    // agar dashboard web bisa langsung menampilkan foto.
    return base64;
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
async function tambahDokumentasi({ imageBuffers, judul, tanggal, pengirim }) {
  // Cek apakah sudah ada dokumentasi hari ini dari pengirim yang sama
  const docRef = db.collection("dokumentasi_pkl");
  const snap = await docRef.where("date", "==", tanggal).where("pengirim", "==", pengirim).get();
  if (!snap.empty) {
    const existingData = snap.docs[0].data();
    return { success: false, alreadyExists: true, existingTitle: existingData.title };
  }

  // Handle single buffer (backward compatibility) or array of buffers
  const buffers = Array.isArray(imageBuffers) ? imageBuffers : [imageBuffers];
  const total = buffers.length;

  for (let i = 0; i < total; i++) {
    const buffer = buffers[i];
    
    // Gunakan kompresi FFmpeg agar dokumentasi tidak membuat DB penuh atau error
    let compressedBuffer = buffer;
    try {
      compressedBuffer = await compressImage(buffer, 1200, 2);
      if (compressedBuffer.length > 730 * 1024) {
        compressedBuffer = await compressImage(buffer, 1000, 5);
      }
      if (compressedBuffer.length > 730 * 1024) {
        compressedBuffer = await compressImage(buffer, 800, 10);
      }
      console.log(`✅ Dokumentasi ${i+1}/${total} dikompresi: ${(compressedBuffer.length / 1024).toFixed(0)} KB`);
    } catch(e) {
      console.warn("⚠️ Gagal kompresi dokumentasi, memakai ukuran asli.");
    }

    const base64 = "data:image/jpeg;base64," + compressedBuffer.toString("base64");
    const photoTitle = total > 1 ? `${judul || "Dokumentasi PKL"} (${i + 1}/${total})` : (judul || "Dokumentasi PKL");

    const newPhoto = {
      id: Date.now() + i, // ensure unique ID
      url: base64,
      title: photoTitle,
      date: tanggal,
      pengirim: pengirim || "Unknown",
    };

    await docRef.add(newPhoto);
  }

  return { success: true };
}

// =====================================================
// Tambah Jurnal ke Firestore
// =====================================================
async function tambahJurnal({ aktivitas, priority, tanggal, pengirim }) {
  const docRef = db.collection("dashboard").doc("jurnalHistory");
  const snap = await docRef.get();

  const newEntry = {
    id: Date.now(),
    title: aktivitas,
    status: "Menunggu",
    date: tanggal,
    priority: priority || "Sedang",
    pengirim: pengirim || "Unknown",
  };

  if (snap.exists) {
    const currentData = snap.data().data || [];
    // Cek apakah sudah ada jurnal hari ini dari pengirim yang sama
    const sudahJurnal = currentData.find((item) => item.date === tanggal && item.pengirim === pengirim);
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
async function tambahTugas({ judul, priority, tanggal, pengirim }) {
  const docRef = db.collection("dashboard").doc("tugasHistory");
  const snap = await docRef.get();

  const newTask = {
    id: Date.now(),
    title: judul,
    status: "Menunggu",
    date: tanggal,
    priority: priority || "Sedang",
    pengirim: pengirim || "Unknown",
  };

  if (snap.exists) {
    const currentData = snap.data().data || [];
    // Cek apakah sudah ada tugas hari ini dari pengirim yang sama
    const sudahTugas = currentData.find((item) => item.date === tanggal && item.pengirim === pengirim);
    if (sudahTugas) {
      return { success: false, alreadyExists: true, existingTitle: sudahTugas.title };
    }
    await docRef.update({ data: [newTask, ...currentData] });
  } else {
    await docRef.set({ data: [newTask] });
  }

  return { success: true, entry: newTask };
}

module.exports = { initFirebase, uploadPhoto: uploadPhotoToFirestore, tambahAbsen, tambahDokumentasi, tambahJurnal, tambahTugas };

