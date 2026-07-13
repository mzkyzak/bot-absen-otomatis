// =====================================================
// 🤖 Bot WA Absen Otomatis — PKL Dashboard
// =====================================================
// Cara pakai:
//   1. npm install
//   2. Isi .env (copy dari .env.example)
//   3. node index.js → scan QR code dari HP
//   4. Kirim foto ke nomor bot dengan caption "absen"
// =====================================================

require("dotenv").config();
const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default || baileys.makeWASocket || baileys;
const {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  Browsers,
  fetchLatestWaWebVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const {
  initFirebase,
  uploadPhoto,
  tambahAbsen,
  tambahDokumentasi,
  tambahJurnal,
  tambahTugas,
} = require("./firebase-admin");

const unauthorizedWarnCount = new Map();

// ─── Branding ─────────────────────────────────────────
const BOT_NAME = "Bot PKL by mzkyzak";
const BOT_VERSION = "v2.0";
const BOT_AUTHOR = "mzkyzak";

// ─── Konstanta ───────────────────────────────────────
const KEYWORD_ABSEN = (process.env.KEYWORD_ABSEN || "absen").toLowerCase();

// Whitelist: HANYA nomor di ALLOWED_NUMBERS yang bisa pakai bot
// Format di .env: 628xxx (tanpa +), pisah koma jika banyak
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || "")
  .split(",")
  .map((n) => n.trim().replace(/[^0-9]/g, ""))
  .filter(Boolean); // kosong = semua ditolak (whitelist ketat)

// LID Whitelist: mapping LID → nomor telepon untuk WA multi-device
// Format di .env: ALLOWED_LIDS=62427634892913:6285810192529,LID2:NOMOR2
// LID bisa dilihat dari log: "62427634892913@lid"
const STATIC_LID_MAP = new Map();
(process.env.ALLOWED_LIDS || "").split(",").forEach((pair) => {
  const [lid, nomor] = pair.trim().split(":");
  if (lid && nomor) {
    STATIC_LID_MAP.set(
      lid.trim().replace(/[^0-9]/g, ""),
      nomor.trim().replace(/[^0-9]/g, ""),
    );
  }
});
if (STATIC_LID_MAP.size > 0) {
  console.log(
    `🗂️  LID map dari .env: ${[...STATIC_LID_MAP.entries()].map(([l, n]) => `${l}→${n}`).join(", ")}`,
  );
}

// ─── Helper: Format tanggal & waktu Indonesia ────────
function getTanggalHari() {
  const now = new Date();
  const hariList = [
    "Minggu",
    "Senin",
    "Selasa",
    "Rabu",
    "Kamis",
    "Jumat",
    "Sabtu",
  ];
  const bulanList = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  const hari = hariList[now.getDay()];
  const tanggal = `${String(now.getDate()).padStart(2, "0")} ${bulanList[now.getMonth()]} ${now.getFullYear()}`;
  const jam = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return { hari, tanggal, jam };
}

function getComputedStatus(jamStr) {
  const parts = jamStr.includes(".") ? jamStr.split(".") : jamStr.split(":");
  if (parts.length < 2) return "Hadir";
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const totalMins = h * 60 + m;

  if (totalMins >= 720) return "Alpa"; // >= 12:00
  if (totalMins >= 510) return "Telat"; // >= 08:30
  return "Hadir";
}

// ─── Helper: Cek apakah JID adalah personal chat ─────
// Allow: @s.whatsapp.net (normal) dan @lid (WhatsApp multi-device LID format)
// Skip: @g.us (grup), @newsletter (channel), @broadcast, dll.
function isPersonalChat(jid) {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

// ─── Helper: Resolve JID → nomor telepon ────────────────
// Untuk @s.whatsapp.net: ambil langsung dari JID
// Untuk @lid: cari di contactsMap (diisi dari contacts.upsert event)
function resolveNomor(jid, contactsMap) {
  if (jid.endsWith("@s.whatsapp.net")) {
    return jid.replace("@s.whatsapp.net", "").replace(/:\d+/, "").trim();
  }
  if (jid.endsWith("@lid")) {
    const lid = jid.replace("@lid", "").replace(/:\d+/, "").trim();
    return contactsMap.get(lid) || null; // null = belum terpeta, tolak
  }
  return null;
}

// ─── Helper: Cek whitelist ───────────────────────────
function isPengirimDiizinkan(nomor) {
  return nomor != null && ALLOWED_NUMBERS.includes(nomor);
}

// ─── Helper: Format nomor jadi tampil friendly ───────
function formatNomor(jid) {
  return jid
    .replace("@s.whatsapp.net", "")
    .replace("@g.us", "")
    .replace(/:\d+$/, "");
}
function formatNomorTampil(nomor) {
  // 6285810192529 → 085810192529
  return nomor.startsWith("62") ? "0" + nomor.slice(2) : nomor;
}

// ─── Main Bot
async function startBot() {
  // Init Firebase
  initFirebase();

  // Simpan sesi WA agar tidak perlu scan QR tiap restart
  const { state, saveCreds } = await useMultiFileAuthState("./wa-session");

  // Ambil versi WA Web terbaru agar tidak ditolak WA server (fix error 405)
  const { version, isLatest } = await fetchLatestWaWebVersion();
  console.log(
    `📦 WA Web version: ${version.join(".")} — ${isLatest ? "✅ latest" : "⚠️ bukan latest"}`,
  );

  // Buat socket WA
  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  });

  // ─── Event: Koneksi WA ────────────────────────────
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    // Tampilkan QR code manual
    if (qr) {
      console.log("\n📱 Scan QR code di bawah ini dengan WhatsApp kamu:");
      console.log("   WA → 3 titik → Perangkat Tertaut → Tautkan Perangkat\n");
      qrcode.generate(qr, { small: true });
      console.log("\n⏳ Menunggu scan...\n");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : null;

      const reason =
        Object.keys(DisconnectReason).find(
          (key) => DisconnectReason[key] === statusCode,
        ) ||
        statusCode ||
        "unknown";

      console.log(
        `\n🔌 Koneksi terputus — reason: ${reason} (code: ${statusCode})`,
      );

      // Logout permanen — jangan reconnect
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(
          "🚺 Bot logout. Hapus folder wa-session/ lalu jalankan ulang.",
        );
        return;
      }

      // connectionReplaced — sesi direbut WA Web browser!
      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log(
          "⚠️  [connectionReplaced] Sesi WA direbut oleh WhatsApp Web browser!",
        );
        console.log(
          "⚠️  Tutup semua tab WhatsApp Web di browser, lalu bot akan reconnect.",
        );
        console.log("🔄 Reconnect dalam 10 detik...");
        setTimeout(startBot, 10_000);
        return;
      }

      // Error lainnya — reconnect cepat
      console.log("🔄 Mencoba reconnect dalam 3 detik...");
      setTimeout(startBot, 3000);
    }

    if (connection === "open") {
      console.log("✅ Bot WA berhasil terhubung!");
      console.log(`📞 Nomor bot: ${sock.user?.id?.split(":")[0]}`);
      console.log(`🔑 Keyword absen: "${KEYWORD_ABSEN}"`);
      if (ALLOWED_NUMBERS.length > 0) {
        console.log(
          `👥 Hanya nomor berikut yang bisa absen: ${ALLOWED_NUMBERS.map(formatNomor).join(", ")}`,
        );
      } else {
        console.log(
          "👥 Semua nomor bisa absen (atur ALLOWED_NUMBERS di .env untuk membatasi)",
        );
      }
      console.log(
        "\n🎉 Bot siap menerima absen! Kirim foto dengan caption 'absen'\n",
      );
    }
  });

  // ─── Simpan kredensial WA ─────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ─── Contacts Map: LID → nomor telepon ───────────────────────
  // WhatsApp multi-device mengirim pesan dengan format @lid (Linked ID)
  // yang berbeda dari nomor telepon. Kita perlu mapping LID → nomor.
  // Di-seed dari ALLOWED_LIDS di .env agar langsung tersedia tanpa tunggu sync.
  const contactsMap = new Map(STATIC_LID_MAP); // clone dari static map
  if (contactsMap.size > 0) {
    console.log(
      `🗂️  contactsMap ready: ${contactsMap.size} LID(s) pre-loaded dari .env`,
    );
  }

  function upsertContact(contact) {
    // contact.id   = "6285810192529@s.whatsapp.net"
    // contact.lid  = "62427634892913@lid" (atau tanpa suffix)
    if (!contact.id || !contact.lid) return;
    const nomor = contact.id
      .replace("@s.whatsapp.net", "")
      .replace(/:\d+/, "")
      .trim();
    const lid = String(contact.lid)
      .replace("@lid", "")
      .replace(/:\d+/, "")
      .trim();
    if (nomor && lid) {
      contactsMap.set(lid, nomor);
      console.log(`📇 Contact mapped: ${nomor} ↔️ ${lid}@lid`);
    }
  }

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) upsertContact(c);
  });
  sock.ev.on("contacts.update", (updates) => {
    for (const c of updates) upsertContact(c);
  });
  sock.ev.on("contacts.set", ({ contacts }) => {
    for (const c of contacts) upsertContact(c);
  });

  // ─── Simpan lokasi sementara per pengirim ──────────
  // Jika user kirim lokasi WA sebelum foto, disimpan di sini (berlaku 30 menit)
  const pendingLocation = new Map();

  // Simpan foto absen sementara sambil tunggu link Google Maps
  // { imageBuffer, jam, tanggal, hari, timer }
  const pendingAbsen = new Map();

  // ─── Helper: Extract info dari Google Maps link ───
  async function parseGMapsLink(text) {
    // Deteksi link Google Maps
    const gmapsRegex =
      /(https?:\/\/(maps\.google\.com|www\.google\.com\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)[^\s]*)/i;
    const match = text.match(gmapsRegex);
    if (!match) return null;
    let url = match[1];

    // Expand shortlink to get coordinates
    if (url.includes("maps.app.goo.gl") || url.includes("goo.gl/maps")) {
      try {
        const axios = require("axios");
        const res = await axios.get(url, { maxRedirects: 0, validateStatus: null });
        if (res.headers.location) {
          url = res.headers.location;
        }
      } catch (e) { }
    }

    // Coba ekstrak koordinat dari URL (@lat,lon atau ?q=lat,lon atau !3dlat!4dlon)
    const coordMatch =
      url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
      url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/) ||
      url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
    const lon = coordMatch ? parseFloat(coordMatch[2]) : null;

    return { url: match[1], lat, lon };
  }

  // ─── Helper: Reverse Geocode ───────────────────────
  async function getAlamat(lat, lon) {
    try {
      const axios = require("axios");
      const res = await axios.get(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=id`,
        { timeout: 5000 },
      );
      const d = res.data;
      const parts = [d.locality, d.city, d.principalSubdivision].filter(
        Boolean,
      );
      return (
        [...new Set(parts)].join(", ") || `${lat.toFixed(5)}, ${lon.toFixed(5)}`
      );
    } catch {
      return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }
  }

  // ─── Helper: Hitung Jarak (Haversine Formula) ────────
  function getDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
    const R = 6371e3; // Radius bumi dalam meter
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Jarak dalam meter
  }

  // ─── Event: Pesan Masuk ───────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // DEBUG: log semua event masuk (hapus setelah debug selesai)
    console.log(
      `\n🔍 [DEBUG] messages.upsert — type: "${type}" — ${messages.length} pesan`,
    );

    for (const msg of messages) {
      const rawJid = msg.key.remoteJid;
      const fromMe = msg.key.fromMe;

      // DEBUG: log setiap pesan mentah
      console.log(
        `   📨 [RAW] JID: ${rawJid} | fromMe: ${fromMe} | type: ${type}`,
      );

      // Skip pesan yang dikirim oleh bot sendiri
      if (fromMe) {
        console.log(`   ⏩ Skip fromMe`);
        continue;
      }

      // Skip status broadcast
      if (rawJid === "status@broadcast") {
        console.log(`   ⏩ Skip status@broadcast`);
        continue;
      }

      // Skip type bukan notify & bukan append (kadang WA kirim type lain)
      if (type !== "notify" && type !== "append") {
        console.log(`   ⏩ Skip type: ${type}`);
        continue;
      }

      const senderJid = rawJid;

      // ─── Skip non-personal chat (newsletter, grup, dll) ─
      // @newsletter = channel WA, @g.us = grup
      // @lid dan @s.whatsapp.net = personal chat (diizinkan lanjut)
      if (!isPersonalChat(senderJid)) {
        console.log(`⏭️  Skip non-personal JID: ${senderJid}`);
        continue;
      }

      // ─── Resolve nomor telepon dari JID ─────────────────
      // Priority 1: msg.key.senderPn  → nomor langsung ada di key! (pesan @lid)
      // Priority 2: contactsMap       → dari contacts.upsert atau ALLOWED_LIDS .env
      // Priority 3: JID @s.whatsapp.net → ekstrak dari JID langsung
      let senderNomor = null;

      // Priority 1: senderPn (tersedia di semua pesan @lid — paling andal)
      if (msg.key.senderPn) {
        senderNomor = msg.key.senderPn
          .replace("@s.whatsapp.net", "")
          .replace(/:\d+/, "")
          .trim();
        // Update contactsMap agar future lookups lebih cepat
        if (senderJid.endsWith("@lid")) {
          const lid = senderJid.replace("@lid", "").replace(/:\d+/, "").trim();
          if (!contactsMap.has(lid)) contactsMap.set(lid, senderNomor);
        }
        console.log(`   📱 senderPn → ${senderNomor}`);
      }

      // Priority 2: contactsMap (pre-loaded dari .env ALLOWED_LIDS atau contacts.upsert)
      if (!senderNomor) {
        senderNomor = resolveNomor(senderJid, contactsMap);
        if (senderNomor) console.log(`   📇 contactsMap → ${senderNomor}`);
      }

      // Priority 3: @s.whatsapp.net langsung
      if (!senderNomor && senderJid.endsWith("@s.whatsapp.net")) {
        senderNomor = senderJid
          .replace("@s.whatsapp.net", "")
          .replace(/:\d+/, "")
          .trim();
        console.log(`   📞 JID direct → ${senderNomor}`);
      }

      console.log(
        `   📲 Resolved: ${senderJid} → ${senderNomor ?? "(unknown)"}`,
      );

      // ─── Cek whitelist ─────────────────────────────
      // Hanya nomor di ALLOWED_NUMBERS yang bisa pakai semua fitur bot
      if (!isPengirimDiizinkan(senderNomor)) {
        // Jika LID belum terpeta ke nomor, skip diam-diam (bukan reject)
        if (senderNomor === null && senderJid.endsWith("@lid")) {
          console.log(`⏭️  Skip @lid belum terpeta: ${senderJid}`);
          continue;
        }
        const displayNomor = senderNomor ?? senderJid;
        const textMessage =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          "";
        const textLower = textMessage.toLowerCase().trim();

        if (
          textLower === "bantuan" ||
          textLower === "help" ||
          textLower === "menu" ||
          textLower === "info"
        ) {
          const warnCount = unauthorizedWarnCount.get(senderJid) || 0;
          if (warnCount < 2) {
            unauthorizedWarnCount.set(senderJid, warnCount + 1);
            const { hari, tanggal, jam } = getTanggalHari();
            await sock.sendMessage(senderJid, {
              text:
                `⚠️ *AKSES DITOLAK (PRIVATE BOT)*\n\n` +
                `╔══════════════════════╗\n` +
                `  🤖 *${process.env.BOT_NAME || "Bot Absen PKL"}*\n` +
                `  v2.0 — PKL BPS Pusat\n` +
                `╚══════════════════════╝\n\n` +
                `📅 *Hari ini:* ${hari}, ${tanggal}\n` +
                `🕐 *Jam:* ${jam} WIB\n` +
                `👤 *Nomor Anda:* ${formatNomorTampil(displayNomor)}\n\n` +
                `⛔ *PERINGATAN YAHH INI NOMORNYA BEDA:*\n` +
                `Bot ini bersifat **SANGAT RAHASIA** dan hanya melayani nomor admin yang terdaftar di dalam sistem.\n\n` +
                `Nomor Anda **TIDAK TERDAFTAR**.\n` +
                `Jika Anda mencoba mengirim pesan lebih dari 2 kali, nomor Anda akan diblokir otomatis oleh sistem keamanan bot.\n\n` +
                `_Sistem Keamanan Aktif 🛡️_`,
            });
            console.log(
              `⚠️ Peringatan terkirim ke unregistered (${warnCount + 1}/2): ${displayNomor}`,
            );
          } else {
            console.log(
              `⛔ Limit peringatan bantuan (silent): ${displayNomor}`,
            );
          }
        } else {
          console.log(`⛔ Akses ditolak (silent): ${displayNomor}`);
        }
        continue;
      }

      // ─── Cek apakah pesan berisi LOKASI WA 📍 ──────
      const locationMessage =
        msg.message?.locationMessage || msg.message?.liveLocationMessage;
      if (locationMessage) {
        const lat = locationMessage.degreesLatitude;
        const lon = locationMessage.degreesLongitude;
        if (lat && lon) {
          console.log(`📍 Lokasi dari ${senderNomor}: ${lat}, ${lon}`);
          const address = await getAlamat(lat, lon);
          pendingLocation.set(senderJid, { lat, lon, address });
          setTimeout(() => pendingLocation.delete(senderJid), 30 * 60 * 1000);
          await sock.sendMessage(senderJid, {
            text: `📍 *Lokasi diterima!*\n\n📌 ${address}\n\nSekarang kirim *foto* dengan caption *"absen"* untuk menyelesaikan absen. 📸`,
          });
        }
        continue;
      }

      // ─── Definisikan imageMessage lebih awal ────────
      const isImageMessage = msg.message?.imageMessage;
      const isViewOnceImage =
        msg.message?.viewOnceMessageV2?.message?.imageMessage;
      const imageMessage = isImageMessage || isViewOnceImage;

      // ─── Cek pesan TEKS (untuk jurnal tanpa foto) ──
      const textMessage =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";
      const textLower = textMessage.toLowerCase().trim();
      if (textMessage && !imageMessage) {
        // ─── Helper: parse priority dari awal teks ─────
        const parsePriority = (kata, teks) => {
          const setelahKata = teks.slice(kata.length).trim();
          const setelahLower = setelahKata.toLowerCase();
          if (
            setelahLower.startsWith("tinggi ") ||
            setelahLower.startsWith("tinggi\n") ||
            setelahLower === "tinggi"
          ) {
            return { priority: "Tinggi", isi: setelahKata.slice(7).trim() };
          } else if (
            setelahLower.startsWith("rendah ") ||
            setelahLower.startsWith("rendah\n") ||
            setelahLower === "rendah"
          ) {
            return { priority: "Rendah", isi: setelahKata.slice(7).trim() };
          } else if (
            setelahLower.startsWith("sedang ") ||
            setelahLower.startsWith("sedang\n") ||
            setelahLower === "sedang"
          ) {
            return { priority: "Sedang", isi: setelahKata.slice(7).trim() };
          }
          return { priority: "Sedang", isi: setelahKata };
        };

        // ─── CEK LINK GOOGLE MAPS (untuk selesaikan absen) ─
        const gmapsInfo = await parseGMapsLink(textMessage);
        if (gmapsInfo && pendingAbsen.has(senderJid)) {
          if (
            process.env.WAJIB_MAPS_LINK &&
            !process.env.WAJIB_MAPS_LINK.includes("kosongkan")
          ) {
            const wajibLink = process.env.WAJIB_MAPS_LINK.trim();
            const targetInfo = await parseGMapsLink(wajibLink);

            if (targetInfo && targetInfo.lat && targetInfo.lon) {
              const distance = getDistance(gmapsInfo.lat, gmapsInfo.lon, targetInfo.lat, targetInfo.lon);
              console.log(`📏 Jarak ke target (Pesan Teks): ${distance.toFixed(2)} meter`);

              if (distance > 50) { // Toleransi 50 meter
                await sock.sendMessage(senderJid, {
                  text: `❌ *Lokasi Terlalu Jauh!*\n\nJarak kamu saat ini *${distance.toFixed(0)} meter* dari lokasi kerja.\nKamu wajib berada di dalam area kantor untuk melakukan absen.`,
                });
                return;
              }
            }
          }
          const pending = pendingAbsen.get(senderJid);
          clearTimeout(pending.timer);
          pendingAbsen.delete(senderJid);

          // Ambil nama lokasi dari koordinat (jika ada di URL)
          let lokasiText = gmapsInfo.url;
          let koordinat = null;
          if (gmapsInfo.lat && gmapsInfo.lon) {
            lokasiText = await getAlamat(gmapsInfo.lat, gmapsInfo.lon);
            koordinat = `${gmapsInfo.lat.toFixed(5)}, ${gmapsInfo.lon.toFixed(5)}`;
          }

          console.log(
            `📍 Link GMaps diterima, selesaikan absen ${senderNomor}`,
          );

          try {
            const computedStatus = getComputedStatus(pending.jam);
            const result = await tambahAbsen({
              photoBuffer: pending.imageBuffer || null,
              pengirim: senderNomor,
              jam: pending.jam,
              tanggal: pending.isTest
                ? `🧪 TEST ${pending.tanggal}`
                : pending.tanggal,
              hari: pending.isTest ? "Test" : pending.hari,
              lokasi: lokasiText,
              koordinat,
              gmapsUrl: gmapsInfo.url,
              status: pending.isTest ? "Test" : computedStatus,
              skipDuplikat: pending.isTest,
            });

            if (result.alreadyAbsent) {
              const prevStat = result.existingStatus;
              const msgStatus =
                prevStat === "Hadir" ||
                  prevStat === "Terlambat" ||
                  prevStat === "Alpa"
                  ? "Absen (Hadir)"
                  : prevStat;
              await sock.sendMessage(senderJid, {
                text: `⚠️ *Sudah Terdata Hari Ini*\n\nKamu sudah melaporkan *${msgStatus}* pada hari ini (${pending.tanggal}). Kamu tidak bisa melakukan pengajuan lagi.`,
              });
            } else if (result.success) {
              const isTest = pending.isTest;
              const statusEmoji =
                computedStatus === "Alpa"
                  ? "❌"
                  : computedStatus === "Terlambat"
                    ? "⚠️"
                    : "✅";
              await sock.sendMessage(senderJid, {
                text:
                  `${isTest ? "🧪 *[TEST]*" : statusEmoji} *Absen Dashboard Berhasil (${computedStatus})!*\n\n` +
                  `👤 *Nomor:* ${senderNomor}\n` +
                  `📅 *Hari:* ${pending.hari}, ${pending.tanggal}\n` +
                  `🕐 *Jam Masuk:* ${pending.jam} WIB\n` +
                  `📍 *Lokasi:* ${lokasiText}\n` +
                  `🗺️ *Maps:* ${gmapsInfo.url}\n` +
                  (isTest ? `\n🧪 _Data test — bisa dihapus_\n` : "")
              });
              console.log(
                `✅ Absen Dashboard: ${senderNomor} — ${pending.tanggal} ${pending.jam} — ${lokasiText}`,
              );
            }

          } catch (error) {
            console.error("❌ Gagal tambah absen ke Firebase:", error);
            await sock.sendMessage(senderJid, {
              text: `❌ *Gagal memproses absen!*\n\nTerjadi kesalahan saat menyimpan ke Firebase (Database).\n_Cek terminal bot untuk detail error._`,
            });
            // Kembalikan ke state pending karena gagal absen
            pendingAbsen.set(senderJid, pending);
          }
          continue;
        }
        // ─── SAKIT / IZIN (TEKS SAJA = DITOLAK) ──────────
        if (textLower.startsWith("sakit") || textLower.startsWith("izin")) {
          const type = textLower.startsWith("sakit") ? "Sakit" : "Izin";
          await sock.sendMessage(senderJid, {
            text: `⚠️ *Bukti Diperlukan!*\n\nUntuk pengajuan ${type}, kamu wajib melampirkan *FOTO* (misal: surat dokter / bukti lainnya) dengan caption '${type.toLowerCase()} [keterangan]'.\n\nContoh: _${type.toLowerCase()} demam tinggi_`,
          });
          continue;
        }

        // ─── ABSEN (TEKS SAJA = DITOLAK) ───────────────
        if (textLower === "absen" || textLower === "absen test") {
          await sock.sendMessage(senderJid, {
            text: `⚠️ *Gagal absen!*\n\nKamu harus mengirimkan *FOTO* dengan caption 'absen'.`,
          });
          continue;
        }

        // ─── JURNAL ────────────────────────────────────
        if (textLower.startsWith("jurnal")) {
          const { priority, isi: aktivitas } = parsePriority(
            "jurnal",
            textMessage,
          );
          if (!aktivitas) {
            await sock.sendMessage(senderJid, {
              text: `📝 *Format Jurnal:*\n\n• jurnal [aktivitas]\n• jurnal tinggi [aktivitas]\n• jurnal sedang [aktivitas]\n• jurnal rendah [aktivitas]\n\n*Contoh:*\n_jurnal tinggi Belajar membuat REST API_\n_jurnal Rapat evaluasi dengan pembimbing_`,
            });
            continue;
          }
          const { tanggal } = getTanggalHari();
          const pEmoji = { Tinggi: "🔴", Sedang: "🟡", Rendah: "🟢" }[priority];

          try {
            const jurnalResult = await tambahJurnal({ aktivitas, priority, tanggal });
            if (!jurnalResult.success && jurnalResult.alreadyExists) {
              await sock.sendMessage(senderJid, {
                text: `⚠️ *Jurnal Sudah Diisi!*\n\nKamu sudah mengisi jurnal hari ini:\n📌 *"${jurnalResult.existingTitle}"*\n\nJurnal hanya bisa diisi *1 kali per hari*.`,
              });
              console.log(`⏩ Jurnal sudah ada hari ini untuk ${senderNomor}`);
            } else {
              await sock.sendMessage(senderJid, {
                text: `📝 *Jurnal Ditambahkan!*\n\n📌 *Aktivitas:* ${aktivitas}\n📅 *Tanggal:* ${tanggal}\n${pEmoji} *Prioritas:* ${priority}\n⏳ *Status:* Menunggu\n\n_Jurnal sudah masuk ke dashboard! ✅_`,
              });
              console.log(`📝 Jurnal: "${aktivitas}" [${priority}]`);
            }
          } catch (error) {
            console.error("❌ Gagal tambah jurnal ke Firebase:", error);
            await sock.sendMessage(senderJid, {
              text: `❌ *Gagal menyimpan jurnal!*\n\nTerjadi kesalahan koneksi ke Firebase (Database).\n_Cek terminal bot untuk detail error (misal: service account invalid/expired)._`,
            });
          }
        } else if (textLower.startsWith("tugas")) {
          const { priority, isi: judulTugas } = parsePriority(
            "tugas",
            textMessage,
          );
          if (!judulTugas) {
            await sock.sendMessage(senderJid, {
              text: `📋 *Format Tugas PKL:*\n\n• tugas [keterangan]\n• tugas tinggi [keterangan]\n• tugas sedang [keterangan]\n• tugas rendah [keterangan]\n\n*Contoh:*\n_tugas tinggi Fix bug halaman login_\n_tugas sedang Membuat laporan mingguan_\n_tugas rendah Rapikan folder project_`,
            });
            continue;
          }
          const { tanggal } = getTanggalHari();
          const pEmoji = { Tinggi: "🔴", Sedang: "🟡", Rendah: "🟢" }[priority];

          try {
            await tambahTugas({ judul: judulTugas, priority, tanggal });
            await sock.sendMessage(senderJid, {
              text: `📋 *Tugas PKL Ditambahkan!*\n\n📌 *Tugas:* ${judulTugas}\n📅 *Tanggal:* ${tanggal}\n${pEmoji} *Prioritas:* ${priority}\n⏳ *Status:* Menunggu\n\n_Tugas sudah muncul di dashboard! ✅_`,
            });
            console.log(`📋 Tugas: "${judulTugas}" [${priority}]`);
          } catch (error) {
            console.error("❌ Gagal tambah tugas ke Firebase:", error);
            await sock.sendMessage(senderJid, {
              text: `❌ *Gagal menyimpan tugas!*\n\nTerjadi kesalahan koneksi ke Firebase (Database).\n_Cek terminal bot untuk detail error._`,
            });
          }

          // ─── ABSEN E-PRAKERIN SEKOLAH 🏫 ─────────────────
        } else if (
          textLower === "eprakerin" ||
          textLower === "e-prakerin" ||
          textLower === "absen sekolah" ||
          textLower === "absen eprakerin" ||
          textLower.startsWith("jurnal eprakerin") ||
          textLower.startsWith("jurnal sekolah")
        ) {
          await sock.sendMessage(senderJid, {
            text: `❌ *DITOLAK!* Wajib pakai lampiran 📷 FOTO buat absen atau jurnal E-Prakerin.`,
          });
          // ─── END ─────────────────────────────────────────

          // ─── PING / STATUS BOT 🤖 ─────────────────────────
        } else if (
          textLower === "ping" ||
          textLower === "status" ||
          textLower === "server"
        ) {
          const uptime = process.uptime();
          const jam = Math.floor(uptime / 3600);
          const menit = Math.floor((uptime % 3600) / 60);
          const detik = Math.floor(uptime % 60);
          await sock.sendMessage(senderJid, {
            text: `🤖 *BOT ONLINE! (v2.0)*\n\n🟢 *Sistem:* Berjalan Normal\n⏱️ *Uptime:* ${jam} jam, ${menit} menit, ${detik} detik\n🛡️ *Proteksi:* Private Whitelist (Aktif)`,
          });

          // ─── Info bot gue jangan sebar bacalah berikut ini??
        } else if (
          textLower === "bantuan" ||
          textLower === "help" ||
          textLower === "menu" ||
          textLower === "info"
        ) {
          const { hari, tanggal, jam } = getTanggalHari();
          await sock.sendMessage(senderJid, {
            text:
              `🤖 *${BOT_NAME} — v2.0*\n` +
              `_PKL BPS Jakarta Pusat_\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n` +
              `📅 ${hari}, ${tanggal}  |  🕐 ${jam} WIB\n` +
              `👤 ${formatNomorTampil(senderNomor)}  ✅ _Terverifikasi_\n` +
              `📝 _Ket: Nomor terverifikasi untuk absen (Juli - Desember)_\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
              `Halo! gua adalah sistem bot asisten PKL otomatis. Berikut panduan lengkap fitur yang bisa kamu gunakan:\n\n` +
              `📸 *ABSEN HADIR*\n` +
              `_Sistem pencatatan kehadiran berbasis lokasi (Geotagging)._\n` +
              `• Kirim foto kegiatanmu dengan caption: *absen*\n` +
              `• Bot akan meminta link Google Maps lokasimu saat ini.\n` +
              `• Data absen, foto HD, dan lokasi langsung sinkron ke Dashboard Portfolio secara realtime.\n\n` +
              `💊 *PENGAJUAN SAKIT / IZIN*\n` +
              `_Fitur perizinan otomatis jika kamu berhalangan hadir._\n` +
              `• Kirim foto bukti (surat dokter / keterangan lain).\n` +
              `• Gunakan caption: *sakit [alasan]* atau *izin [alasan]*\n` +
              `• Contoh: _sakit demam tinggi dan butuh istirahat_\n` +
              `• Bukti foto akan aman tersimpan di server database.\n\n` +
              `🖼️ *GALERI DOKUMENTASI*\n` +
              `_Arsip foto kegiatan harian untuk keperluan laporan PKL._\n` +
              `• Kirim foto kegiatan dengan caption: *dokumentasi [judul kegiatan]*\n` +
              `• Contoh: _dokumentasi rapat evaluasi mingguan_\n` +
              `• Foto akan dioptimasi kualitasnya (Smart HD) dan tampil rapi di Galeri Web.\n\n` +
              `📝 *JURNAL HARIAN*\n` +
              `_Catat log aktivitas kerja harian tanpa ribet._\n` +
              `• Cukup kirim pesan teks (tanpa foto):\n` +
              `  › *jurnal [aktivitas]* (Default: Sedang 🟡)\n` +
              `  › *jurnal tinggi [aktivitas]* 🔴 (Prioritas Tinggi)\n` +
              `  › *jurnal sedang [aktivitas]* 🟡 (Prioritas Sedang)\n` +
              `  › *jurnal rendah [aktivitas]* 🟢 (Prioritas Rendah)\n\n` +
              `✅ *TUGAS PKL*\n` +
              `_Manajemen to-do list / tugas dari pembimbing._\n` +
              `• Cukup kirim pesan teks (tanpa foto):\n` +
              `  › *tugas [keterangan]*\n` +
              `  › *tugas tinggi / sedang / rendah [keterangan]*\n\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n` +
              `⚙️ _Sistem Kompresi Gambar: Smart HD (max ~900KB)_\n` +
              `🔒 _Bot ini privat dan terenkripsi — hanya melayani nomor admin terdaftar._\n` +
              `_Engineered with ❤️ by ${BOT_AUTHOR}_`,
          });
        }
        continue;
      }

      if (!imageMessage) continue;

      const caption = (imageMessage.caption || "").toLowerCase().trim();
      const captionAsli = (imageMessage.caption || "").trim();

      // ─── Routing berdasarkan keyword ───────────────
      const isAbsen = caption.startsWith("absen");
      const isDokumentasi =
        caption.startsWith("dokumentasi") || caption.startsWith("dokum");
      const isJurnal = caption.startsWith("jurnal");
      const isSakit = caption.startsWith("sakit");
      const isIzin = caption.startsWith("izin");

      // ─── Tidak ada keyword yang dikenal ────────────
      if (!isAbsen && !isDokumentasi && !isJurnal && !isSakit && !isIzin) {
        if (
          caption.includes("cek") ||
          caption.includes("menu") ||
          caption.includes("help")
        ) {
          await sock.sendMessage(senderJid, {
            text: `🤖 *Bot PKL — Menu Bantuan (v2.0)*\n\n*📋 Absen Portfolio Dashboard:*\n• Foto + caption *absen*\n\n*💊 Sakit / Izin:*\n• Foto + caption *sakit [alasan]*\n\n*🖼️ Dokumentasi:*\n• Foto + caption *dokumentasi [judul]*\n\n*📝 Jurnal Dashboard Firebase:*\n• Teks saja: *jurnal [aktivitas]*\n\nKetik *bantuan* untuk info lengkap.`,
          });
          continue;
        }
        await sock.sendMessage(senderJid, {
          text: `📸 *Foto diterima!*\n\nGunakan caption:\n• *absen* — absen ke portfolio dashboard\n• *sakit [keterangan]* — ajukan sakit\n• *izin [keterangan]* — ajukan izin\n• *dokumentasi [judul]* — simpan ke galeri\n\nKetik *bantuan* untuk info lengkap 📋`,
        });
        continue;
      }

      // ─── Whitelist sudah dicek di awal handler ─────

      console.log(`\n📥 Pesan dari: ${senderNomor} | caption: "${caption}"`);

      // ─── Download foto (dipakai absen & dokumentasi) ─
      await sock.sendMessage(senderJid, { text: "⏳ _Memproses..._" });

      let imageBuffer = null;
      try {
        imageBuffer = await downloadMediaMessage(
          { message: msg.message, key: msg.key },
          "buffer",
          {},
          {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage,
          },
        );
      } catch (e) {
        console.error("❌ Gagal download foto:", e.message);
        await sock.sendMessage(senderJid, {
          text: "❌ Gagal mengunduh foto. Coba kirim ulang.",
        });
        continue;
      }

      const { hari, tanggal, jam } = getTanggalHari();

      try {
        // ═══════════════════════════════════
        // 🖼️ DOKUMENTASI
        // ═══════════════════════════════════
        if (isDokumentasi) {
          // Ambil judul dari caption (setelah kata "dokumentasi")
          const judulMatch =
            captionAsli.match(/dokumentasi\s*(.*)/i) ||
            captionAsli.match(/dokum\s*(.*)/i);
          const judul = judulMatch?.[1]?.trim() || `Dokumentasi ${tanggal} `;

          console.log(`🖼️ Menyimpan dokumentasi: "${judul}"`);
          await tambahDokumentasi({ imageBuffer, judul, tanggal });

          await sock.sendMessage(senderJid, {
            text: `🖼️ * Dokumentasi Tersimpan! *\n\n📌 * Judul:* ${judul} \n📅 * Tanggal:* ${tanggal} \n\n_Foto sudah masuk ke galeri dashboard! ✅_`,
          });
          console.log(`✅ Dokumentasi disimpan: "${judul}"`);
        }

        // ═══════════════════════════════════
        // 📝 JURNAL (via foto juga bisa)
        // ═══════════════════════════════════
        else if (isJurnal && !isAbsen) {
          const aktivitasMatch = captionAsli.match(/jurnal\s*(.*)/i);
          const aktivitas = aktivitasMatch?.[1]?.trim() || `Jurnal ${tanggal} `;
          const priorityMap = {
            tinggi: "Tinggi",
            sedang: "Sedang",
            rendah: "Rendah",
          };
          const priority = Object.keys(priorityMap).find((k) =>
            caption.includes(k),
          )
            ? priorityMap[
            Object.keys(priorityMap).find((k) => caption.includes(k))
            ]
            : "Sedang";

          const jurnalResult = await tambahJurnal({ aktivitas, priority, tanggal });
          if (!jurnalResult.success && jurnalResult.alreadyExists) {
            await sock.sendMessage(senderJid, {
              text: `⚠️ *Jurnal Sudah Diisi!*\n\nKamu sudah mengisi jurnal hari ini:\n📌 *"${jurnalResult.existingTitle}"*\n\nJurnal hanya bisa diisi *1 kali per hari*.`,
            });
            console.log(`⏩ Jurnal sudah ada hari ini untuk ${senderNomor}`);
          } else {
            await sock.sendMessage(senderJid, {
              text: `📝 * Jurnal Ditambahkan! *\n\n📌 * Aktivitas:* ${aktivitas} \n📅 * Tanggal:* ${tanggal} \n🔔 * Prioritas:* ${priority} \n\n_Jurnal sudah masuk ke dashboard! ✅_`,
            });
            console.log(`✅ Jurnal: "${aktivitas}"`);
          }
        }

        // ═══════════════════════════════════
        // 💊 SAKIT / IZIN
        // ═══════════════════════════════════
        else if (isSakit || isIzin) {
          const type = isSakit ? "Sakit" : "Izin";
          const match = captionAsli.match(/^(?:sakit|izin)\s*(.*)/i);
          const keterangan = match?.[1]?.trim();

          if (!keterangan) {
            await sock.sendMessage(senderJid, {
              text: `⚠️ * Keterangan Kosong *\n\nMohon sertakan alasan / keterangan setelah kata ${type.toLowerCase()}.\nContoh: * ${type.toLowerCase()} demam tinggi * `,
            });
            continue;
          }

          console.log(`📍 Pengajuan ${type} diterima dari ${senderNomor}`);
          const result = await tambahAbsen({
            photoBuffer: imageBuffer || null, // ✅ Simpan foto bukti sakit/izin
            pengirim: senderNomor,
            jam: jam,
            tanggal: tanggal,
            hari: hari,
            lokasi: `Via WhatsApp Bot`,
            koordinat: null,
            gmapsUrl: "",
            status: type,
            skipDuplikat: false,
            keterangan: keterangan,
          });

          if (result.alreadyAbsent) {
            const prevStat = result.existingStatus;
            const msgStatus =
              prevStat === "Hadir" ||
                prevStat === "Terlambat" ||
                prevStat === "Alpa"
                ? "Absen (Hadir)"
                : prevStat;
            await sock.sendMessage(senderJid, {
              text: `⚠️ * Sudah Terdata Hari Ini *\n\nKamu sudah melaporkan * ${msgStatus}* pada hari ini(${tanggal}).Kamu tidak bisa melakukan pengajuan lagi.`,
            });
          } else if (result.success) {
            let balasan = "";
            if (type === "Sakit") {
              balasan =
                `💊 * Laporan Kehadiran(Sakit) *\n\n` +
                `Pemberitahuan bahwa pada hari ini saya tidak dapat hadir untuk melaksanakan kegiatan PKL dikarenakan * sakit *.\n\n` +
                `👤 * Nomor:* ${senderNomor} \n` +
                `📅 * Tanggal:* ${hari}, ${tanggal} \n` +
                `🩺 * Keterangan:* ${keterangan} \n\n` +
                `_Terima kasih atas perhatian dan pengertiannya.Semoga lekas sembuh!_ 🤲`;
            } else {
              balasan =
                `📝 * Laporan Kehadiran(Izin) *\n\n` +
                `Pemberitahuan permohonan izin untuk tidak hadir dalam kegiatan PKL pada hari ini dikarenakan ada keperluan tertentu.\n\n` +
                `👤 * Nomor:* ${senderNomor} \n` +
                `📅 * Tanggal:* ${hari}, ${tanggal} \n` +
                `📋 * Keterangan:* ${keterangan} \n\n` +
                `_Terima kasih atas perhatian dan kebijakan yang diberikan._ 🙏`;
            }
            await sock.sendMessage(senderJid, { text: balasan });
            console.log(
              `✅ ${type}: ${senderNomor} — ${tanggal} — ${keterangan} `,
            );
          }
        }

        // ═══════════════════════════════════
        // ✅ ABSEN (PORTFOLIO DASHBOARD)
        // ═══════════════════════════════════
        else if (isAbsen) {
          const isTestMode = caption.includes("test");
          const gmapsInfo = await parseGMapsLink(captionAsli);

          if (gmapsInfo) {
            if (
              process.env.WAJIB_MAPS_LINK &&
              !process.env.WAJIB_MAPS_LINK.includes("kosongkan")
            ) {
              const wajibLink = process.env.WAJIB_MAPS_LINK.trim();
              const targetInfo = await parseGMapsLink(wajibLink);

              if (targetInfo && targetInfo.lat && targetInfo.lon) {
                const distance = getDistance(gmapsInfo.lat, gmapsInfo.lon, targetInfo.lat, targetInfo.lon);
                console.log(`📏 Jarak ke target (Caption): ${distance.toFixed(2)} meter`);

                if (distance > 50) {
                  await sock.sendMessage(senderJid, {
                    text: `❌ *Lokasi Terlalu Jauh!*\n\nJarak kamu saat ini *${distance.toFixed(0)} meter* dari lokasi kerja.\nKamu wajib berada di dalam area kantor untuk melakukan absen.`,
                  });
                  return;
                }
              }
            }
            let lokasiText = gmapsInfo.url;
            let koordinat = null;
            if (gmapsInfo.lat && gmapsInfo.lon) {
              lokasiText = await getAlamat(gmapsInfo.lat, gmapsInfo.lon);
              koordinat = `${gmapsInfo.lat.toFixed(5)}, ${gmapsInfo.lon.toFixed(5)} `;
            }

            console.log(
              `📍 Link GMaps diterima bersama foto, selesaikan absen ${senderNomor} `,
            );
            const computedStatus = getComputedStatus(jam);
            const result = await tambahAbsen({
              photoBuffer: imageBuffer || null,
              pengirim: senderNomor,
              jam: jam,
              tanggal: isTestMode ? `🧪 TEST ${tanggal} ` : tanggal,
              hari: isTestMode ? "Test" : hari,
              lokasi: lokasiText,
              koordinat,
              gmapsUrl: gmapsInfo.url,
              status: isTestMode ? "Test" : computedStatus,
              skipDuplikat: isTestMode,
            });

            if (result.alreadyAbsent) {
              const prevStat = result.existingStatus;
              const msgStatus =
                prevStat === "Hadir" ||
                  prevStat === "Terlambat" ||
                  prevStat === "Alpa"
                  ? "Absen (Hadir)"
                  : prevStat;
              await sock.sendMessage(senderJid, {
                text: `⚠️ * Sudah Terdata Hari Ini *\n\nKamu sudah melaporkan * ${msgStatus}* pada hari ini(${tanggal}).Kamu tidak bisa melakukan pengajuan lagi.`,
              });
            } else if (result.success) {
              const statusEmoji =
                computedStatus === "Alpa"
                  ? "❌"
                  : computedStatus === "Terlambat"
                    ? "⚠️"
                    : "✅";
              await sock.sendMessage(senderJid, {
                text:
                  `${isTestMode ? "🧪 *[TEST]*" : statusEmoji} * Absen Dashboard Berhasil(${computedStatus})! *\n\n` +
                  `👤 * Nomor:* ${senderNomor} \n` +
                  `📅 * Hari:* ${hari}, ${tanggal} \n` +
                  `🕐 * Jam Masuk:* ${jam} WIB\n` +
                  `📍 * Lokasi:* ${lokasiText} \n` +
                  `🗺️ * Maps:* ${gmapsInfo.url} \n` +
                  (isTestMode ? `\n🧪 _Data test — bisa dihapus_\n` : "")
              });
              console.log(
                `✅ Absen Dashboard(sekaligus): ${senderNomor} — ${tanggal} ${jam} — ${lokasiText} `,
              );
            }
          } else {
            // Simpan foto sementara, tunggu link Google Maps
            const timer = setTimeout(
              async () => {
                if (pendingAbsen.has(senderJid)) {
                  pendingAbsen.delete(senderJid);
                  await sock
                    .sendMessage(senderJid, {
                      text: `⏰ * Waktu Habis *\n\nLink Google Maps tidak dikirim dalam 5 menit.\nAbsen dibatalkan.Coba kirim foto lagi ya!`,
                    })
                    .catch(() => { });
                }
              },
              5 * 60 * 1000,
            );

            pendingAbsen.set(senderJid, {
              jam,
              tanggal,
              hari,
              isTest: isTestMode,
              timer,
              imageBuffer: imageBuffer || null, // Simpan buffer foto untuk dikirim saat link Maps diterima
            });

            await sock.sendMessage(senderJid, {
              text:
                `📸 * Foto absen diterima! *\n\n` +
                `Sekarang kirim * link Google Maps * lokasi kamu: \n\n` +
                `* Cara dapat link:*\n` +
                `1. Buka Google Maps di HP\n` +
                `2. Tap titik lokasi kamu\n` +
                `3. Tap * Share * → * Copy link *\n` +
                `4. Paste dan kirim di sini\n\n` +
                `⏰ _Link harus dikirim dalam 5 menit_`,
            });
            console.log(
              `📸 Foto absen diterima dari ${senderNomor}, menunggu link Maps...`,
            );
          }
        }
      } catch (err) {
        console.error("❌ Error:", err.message);
        await sock.sendMessage(senderJid, {
          text: `❌ * Terjadi Kesalahan *\n\n${err.message.slice(0, 100)}\n\nCoba lagi ya!`,
        });
      }
    }
  });
}

// Start
console.log("🤖 Bot WA Absen PKL — Starting...\n");
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  if (
    msg.includes("Connection Closed") ||
    msg.includes("Connection Lost") ||
    msg.includes("Stream Errored") ||
    msg.includes("Timed Out")
  ) {
    console.warn(`⚠️[Baileys internal] ${msg} — diabaikan, reconnect otomatis`);
    return;
  }
  console.error("❌ [unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  const msg = err?.message || String(err);
  if (
    msg.includes("Connection Closed") ||
    msg.includes("Connection Lost") ||
    msg.includes("Stream Errored")
  ) {
    console.warn(`⚠️[Baileys uncaught] ${msg} — diabaikan`);
    return;
  }
  console.error("❌ [uncaughtException]", err);
  // Untuk error lain yg tidak dikenal, jangan exit — biarkan reconnect logic berjalan
});

startBot().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
