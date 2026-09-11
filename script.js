"use strict";

/* =========================================================================
   XODIMLAR TARTIBI — ish maydoni, xodim/loyiha kartalari, ulanishlar
   Vanilla JS, hech qanday tashqi kutubxonasiz.
   ========================================================================= */

/* ---------------------------- Konstantalar ---------------------------- */

const STORAGE_KEY = "xodimlarTartibi_v1";

/* ------------------------------ Firebase (bulutli sinxronizatsiya) ------------------------------ */

const firebaseConfig = {
  apiKey: "AIzaSyAUBndyehu9mbIEhbXO8HWzDxdQW8f88VQ",
  authDomain: "xodimlar-tartibi.firebaseapp.com",
  databaseURL: "https://xodimlar-tartibi-default-rtdb.firebaseio.com",
  projectId: "xodimlar-tartibi",
  storageBucket: "xodimlar-tartibi.firebasestorage.app",
  messagingSenderId: "517024555563",
  appId: "1:517024555563:web:167b4933aafb2f89a2806e",
  measurementId: "G-TETC4R9764",
};

firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
const fbDb = firebase.database();
const FB_STATE_PATH = "appState";

let fbLastSyncedJSON = null; // oxirgi marta yuborgan/qabul qilgan holatning JSON ko'rinishi (o'z-o'ziga qayta ishlov berishning oldini olish uchun)
let fbPushTimeout = null;
let fbListenerAttached = false;
let fbTickStarted = false;

// Karta o'lchamlarining bazaviy (100%) qiymatlari — Sozlamalar panelidagi
// "karta o'lchami" surgichlari shu bazaviy qiymatlarga nisbatan % qo'llaydi.
// EMP_W/EMP_H/PROJ_W har doim shu bazaviy qiymat * tanlangan foiz bo'ladi va
// applySizeSettings() orqali qayta hisoblanadi — shuning uchun ular `let`.
const EMP_W_BASE = 190;
const EMP_H_BASE = 92;
const PROJ_W_BASE = 360;

let EMP_W = EMP_W_BASE;
let EMP_H = EMP_H_BASE;

// Loyiha kartasi xodim kartasidan sezilarli darajada (~4 barobar maydon bo'yicha) katta:
// rasm ham ancha kattaroq ko'rinadi.
let PROJ_W = PROJ_W_BASE;
const PROJ_ROW_H = 26;
const PROJ_TOP_PAD = 20;
const PROJ_PHOTO_H = 220;
// Kartaning kontent (rasm + matn + paddinglar) uchun kerak bo'ladigan minimal balandlik —
// bu qiymat CSS'dagi haqiqiy chiqindilar (padding, margin, shrift balandligi) bo'yicha
// hisoblab, xavfsizlik uchun zaxira bilan olingan. Balandlik hech qachon bundan kichik
// bo'lmasligi kerak, aks holda kontent karta ichiga sig'may, ulanish nuqtalari
// haqiqiy chekkadan ichkariga siljib qoladi.
const PROJ_CONTENT_MIN_H = 400;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.15;

const PHOTO_MAX_DIM = 400;
const PHOTO_QUALITY = 0.85;

// Ish jadvali: dushanba—shanba 9:00–18:00, tushlik 13:00–14:00, yakshanba dam olish.
const WORK_SEGMENTS = [
  [9, 13],
  [14, 18],
];
// Tungi smena (loyiha bo'yicha ixtiyoriy yoqiladi): har kuni 18:00–02:00 (8 soat),
// jumladan yakshanba kechasi ham — kunduzgi jadvaldan farqli o'laroq, yakshanba
// bundan mustasno emas. [0,2] va [18,24] jufti kalendar kun chegarasidan
// (yarim tundan) o'tuvchi 18:00–02:00 oralig'ini ikki bo'lakka bo'lib ifodalaydi.
const NIGHT_SEGMENTS = [
  [0, 2],
  [18, 24],
];
const WORK_TICK_MS = 30 * 1000; // loyiha vaqt ko'rsatkichlari har 30 soniyada yangilanadi

// Oylik maoshni soatlik stavkaga aylantirish uchun: 6 kunlik ish haftasi (dushanba-shanba),
// kuniga 8 soat (9:00-18:00, tushliksiz) — oyiga taxminan 26 ish kuni * 8 soat = 208 soat.
const MONTHLY_WORK_HOURS = 26 * 8;

/* ------------------------------- Holat --------------------------------- */

// Sozlamalar panelidagi qiymatlarning standart (birinchi marta ochilgandagi) holati.
const DEFAULT_SETTINGS = {
  empScale: 100, // xodim kartasi o'lchami, % (bazaviyga nisbatan)
  projScale: 100, // loyiha kartasi o'lchami, %
  connColor: "#4f8cff", // ulanish chizig'i rangi
  connWidth: 2.2, // ulanish chizig'i qalinligi, px
};

/** @type {{employees: object[], projects: object[], connections: object[], view: {panX:number, panY:number, zoom:number}, settings: object}} */
let state = {
  employees: [],
  projects: [],
  connections: [],
  view: { panX: 0, panY: 0, zoom: 1 },
  settings: { ...DEFAULT_SETTINGS },
};

// DOM elementlarga tezkor murojaat uchun xaritalar
const employeeEls = new Map(); // id -> HTMLElement (faqat ish maydoniga joylashtirilganlar)
const projectEls = new Map(); // id -> HTMLElement (faqat ish maydoniga joylashtirilganlar)
const connectionEls = new Map(); // id -> SVGPathElement
const rosterEls = new Map(); // id -> HTMLElement (chap paneldagi xodim qatori)
const projRosterEls = new Map(); // id -> HTMLElement (o'ng paneldagi loyiha qatori)

/* ------------------------------ DOM refs -------------------------------- */

const workspace = document.getElementById("workspace");
const world = document.getElementById("world");
const svg = document.getElementById("connectionsLayer");
const cardsLayer = document.getElementById("cardsLayer");
const emptyHint = document.getElementById("emptyHint");
const zoomLevelEl = document.getElementById("zoomLevel");
const sidebarList = document.getElementById("sidebarList");
const sidebarEmpty = document.getElementById("sidebarEmpty");
const projectSidebarList = document.getElementById("projectSidebarList");
const projectSidebarEmpty = document.getElementById("projectSidebarEmpty");

const employeeModal = document.getElementById("employeeModal");
const projectModal = document.getElementById("projectModal");
const employeeForm = document.getElementById("employeeForm");
const projectForm = document.getElementById("projectForm");

/* ------------------------------- Yordamchilar ---------------------------- */

function genId() {
  return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function formatMoney(n) {
  const num = Math.round(Number(n) || 0);
  return num.toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
}

function formatHours(n) {
  const num = Number(n) || 0;
  const str = Number.isInteger(num) ? String(num) : String(num);
  return str + " soat";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

/* Standart (rasm tanlanmagan) avatarlar — inline SVG data URI */

function defaultAvatarDataUri() {
  const svgStr = `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <rect width="120" height="120" fill="#262c3a"/>
      <circle cx="60" cy="46" r="22" fill="#3a4356"/>
      <path d="M20 108c4-26 26-38 40-38s36 12 40 38" fill="#3a4356"/>
    </svg>`;
  return "data:image/svg+xml;base64," + btoa(svgStr);
}

function defaultProjectImgDataUri() {
  const svgStr = `
    <svg xmlns="http://www.w3.org/2000/svg" width="220" height="90" viewBox="0 0 220 90">
      <rect width="220" height="90" fill="#262c3a"/>
      <rect x="26" y="30" width="30" height="30" fill="#3a4356"/>
      <rect x="64" y="18" width="30" height="42" fill="#3a4356"/>
      <rect x="102" y="26" width="30" height="34" fill="#3a4356"/>
      <rect x="140" y="14" width="30" height="46" fill="#3a4356"/>
    </svg>`;
  return "data:image/svg+xml;base64," + btoa(svgStr);
}

const DEFAULT_EMP_AVATAR = defaultAvatarDataUri();
const DEFAULT_PROJ_IMG = defaultProjectImgDataUri();

/**
 * Faylni o'qib, kichraytirib (maksimal o'lcham PHOTO_MAX_DIM), JPEG data URI qaytaradi.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readAndCompressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Rasmni o'qib bo'lmadi"));
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#20242f";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL("image/jpeg", PHOTO_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* Ekran <-> dunyo (world) koordinatalari o'zgartirish */

function clientToWorld(clientX, clientY) {
  const rect = workspace.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.view.panX) / state.view.zoom,
    y: (clientY - rect.top - state.view.panY) / state.view.zoom,
  };
}

/* ---------------------- Ish jadvaliga asoslangan real vaqt hisobi ---------------------- */

/**
 * Berilgan kalendar kun uchun (mahalliy 00:00'dan boshlab) qo'llaniladigan ish
 * segmentlari ro'yxatini [soatBoshi, soatOxiri] juftliklari holida, vaqt bo'yicha
 * tartiblangan holda qaytaradi. Kunduzgi segmentlar (9-13, 14-18) yakshanba kuni
 * qo'llanilmaydi; tungi smena segmentlari (0-2, 18-24) — `nightShift` yoqilgan
 * bo'lsa — HAR kuni, yakshanba ham bundan mustasno emas.
 */
function daySegments(dayMidnight, nightShift) {
  const segs = [];
  if (dayMidnight.getDay() !== 0) segs.push(...WORK_SEGMENTS);
  if (nightShift) segs.push(...NIGHT_SEGMENTS);
  return segs.slice().sort((a, b) => a[0] - b[0]);
}

/**
 * [startMs, endMs) oralig'idagi berilgan kalendar kunning ish soatlari bilan
 * kesishgan qismini (soatlarda) hisoblaydi. `dayMidnight` — shu kunning mahalliy
 * 00:00 vaqti (Date obyekti). `nightShift` yoqilgan bo'lsa, tungi (18:00–02:00)
 * segmentlar ham hisobga olinadi.
 */
function workHoursOnDay(dayMidnight, startMs, endMs, nightShift) {
  let hours = 0;
  for (const [sH, eH] of daySegments(dayMidnight, nightShift)) {
    const segStart = new Date(dayMidnight);
    segStart.setHours(sH, 0, 0, 0);
    const segEnd = new Date(dayMidnight);
    segEnd.setHours(eH, 0, 0, 0);
    const from = Math.max(segStart.getTime(), startMs);
    const to = Math.min(segEnd.getTime(), endMs);
    if (to > from) hours += (to - from) / 3600000;
  }
  return hours;
}

/**
 * startMs va endMs orasidagi haqiqiy ISH soatlari sonini qaytaradi (tushlik/yakshanba
 * hisobga olinmagan holda; `nightShift` yoqilgan bo'lsa — tungi 18:00–02:00 smenasi ham
 * qo'shib hisoblanadi, jumladan yakshanba kechasi ham).
 */
function effectiveWorkHoursBetween(startMs, endMs, nightShift) {
  if (!startMs || !endMs || endMs <= startMs) return 0;
  let cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  let total = 0;
  let guard = 0;
  while (cursor.getTime() < endMs && guard < 5000) {
    guard++;
    total += workHoursOnDay(cursor, startMs, endMs, nightShift);
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

/**
 * `fromMs` dan boshlab `hoursNeeded` ta effektiv ish-soati o'tgandan keyingi real
 * vaqtni (ms) qaytaradi. `nightShift` yoqilgan bo'lsa, tungi segmentlar ham hisobga
 * olinadi (shu jumladan hisoblash davomida kunlar orasida).
 */
function advanceEffectiveHours(fromMs, hoursNeeded, nightShift) {
  if (hoursNeeded <= 0) return fromMs;
  let cursor = new Date(fromMs);
  let remaining = hoursNeeded;
  let guard = 0;
  while (remaining > 1 / 3600 && guard < 5000) {
    guard++;
    const dayMidnight = new Date(cursor);
    dayMidnight.setHours(0, 0, 0, 0);
    for (const [sH, eH] of daySegments(dayMidnight, nightShift)) {
      const segStart = new Date(dayMidnight);
      segStart.setHours(sH, 0, 0, 0);
      const segEnd = new Date(dayMidnight);
      segEnd.setHours(eH, 0, 0, 0);
      if (segEnd.getTime() <= cursor.getTime()) continue;
      const from = Math.max(segStart.getTime(), cursor.getTime());
      const availHours = (segEnd.getTime() - from) / 3600000;
      if (availHours <= 0) continue;
      if (availHours >= remaining) {
        return from + remaining * 3600000;
      }
      remaining -= availHours;
      cursor = segEnd;
    }
    const nextDay = new Date(dayMidnight);
    nextDay.setDate(nextDay.getDate() + 1);
    if (cursor.getTime() < nextDay.getTime()) cursor = nextDay;
  }
  return cursor.getTime();
}

function formatDurationHours(hoursFloat) {
  const totalMinutes = Math.max(0, Math.round(hoursFloat * 60));
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  if (hh === 0) return mm + " daqiqa";
  if (mm === 0) return hh + " soat";
  return hh + " soat " + mm + " daqiqa";
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/** Faqat soat:daqiqa (masalan "21:00") — loyiha kartasidagi "Tugash vaqti" uchun. */
function formatTimeOnly(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/**
 * `diffMs` (millisekund) ni eng yaqin 0,5 kunga yaxlitlab, " (X kun)" ko'rinishida
 * qaytaradi — masalan 0,5 yoki 1 yoki 2,5. Agar 0 ga yaxlitlansa — bo'sh satr
 * qaytariladi (qavs umuman ko'rsatilmaydi).
 */
function formatDaysSuffix(diffMs) {
  const days = diffMs / (24 * 60 * 60 * 1000);
  const rounded = Math.round(days * 2) / 2;
  if (rounded <= 0) return "";
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
  return " (" + text + " kun)";
}

/**
 * `diffMs` (millisekund, real taqvim vaqti) ni jonli sanoq (taymer) matniga aylantiradi:
 * "X kun Y soat", "Y soat Z daqiqa" yoki "Z daqiqa" ko'rinishida. "Tugash vaqti" (bashorat)
 * dan farqli o'laroq, bu qiymat har tikda (WORK_TICK_MS) muqarrar kamayib boradi — chunki
 * u shunchaki "hozir"dan "tugash vaqti"gacha bo'lgan taqvim farqi, ish tezligi o'zgarmasa
 * ham vaqt o'tishi bilan pasayadi.
 */
function formatCountdown(diffMs) {
  if (diffMs <= 0) return "0 daqiqa";
  let totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  totalMinutes -= days * 24 * 60;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(days + " kun");
  if (hours > 0) parts.push(hours + " soat");
  if (days === 0 && minutes > 0) parts.push(minutes + " daqiqa");
  if (parts.length === 0) parts.push("0 daqiqa");
  return parts.join(" ");
}

/* ---------------------- Loyiha nuqtalari joylashuvi ---------------------- */

/**
 * Loyiha kartasining balandligi — chap va o'ng tomonlardagi (haqiqiy) ulanishlar
 * soniga qarab dinamik hisoblanadi. Nuqtalar soni endi qo'lda belgilanmaydi —
 * har bir yangi ulanish avtomatik ravishda mos tomonga qo'shiladi.
 */
function projectHeight(leftCount, rightCount) {
  const maxSide = Math.max(leftCount, rightCount);
  // Ikkita mustaqil talab bor: (1) kontent (rasm+matn) sig'ishi uchun minimal balandlik,
  // (2) nuqtalar bir-biriga yopishib qolmasligi uchun kerakli balandlik.
  // Ular bir xil vertikal maydonni egallaydi (ustma-ust qo'shilmaydi) — shuning uchun MAX.
  const pointsSpacingNeeded = PROJ_TOP_PAD * 2 + maxSide * PROJ_ROW_H;
  return Math.max(PROJ_CONTENT_MIN_H, pointsSpacingNeeded);
}

/**
 * Loyiha kartasining HOZIRGI (haqiqiy, DOM'da o'rnatilgan) balandligini qaytaradi.
 * Karta hali render qilinmagan bo'lsa — formulaga asoslangan minimal qiymatga qaytadi.
 * Nuqta belgilari va ulanish chiziqlari doim shu HAQIQIY balandlikka qarab joylashishi
 * kerak — aks holda matn ko'p joy egallab, karta kattalashib ketganda (masalan uzun sana
 * yoki katta summa tufayli) nuqtalar eski (kichikroq) balandlikka qarab hisoblanib, chiziq
 * bilan mos kelmay qoladi.
 */
function getProjectCardHeight(proj) {
  const el = projectEls.get(proj.id);
  if (el) {
    const h = parseFloat(el.style.height);
    if (!isNaN(h) && h > 0) return h;
  }
  const counts = projectConnCounts(proj.id);
  return projectHeight(counts.left, counts.right);
}

/**
 * Loyiha kartasining balandligini HAQIQIY kontentga (rasm+matn+vaqt bloki) moslab
 * o'rnatadi — qattiq belgilangan (statik) qiymat emas. Karta matni uzunligiga qarab
 * (masalan uzun sana, katta summa, ko'p qatorli holat) tabiiy ravishda cho'zilib,
 * hech qachon tashqariga "toshib" chiqmasligi kafolatlanadi. Shu bilan birga,
 * ulanish nuqtalari bir-biriga yopishib qolmasligi uchun kerakli minimal balandlikdan
 * (`projectHeight`) kichik bo'lmaydi.
 *
 * Texnika: `el.style.height`ni vaqtincha "auto"ga o'rnatib, brauzerning haqiqiy
 * (tabiiy) kontent balandligini `scrollHeight` orqali o'lchaymiz — aniq balandlik
 * berilgan holatda `scrollHeight` chegara chizig'ini noto'g'ri qaytarishi mumkin,
 * lekin "auto" bilan bu ishonchli ishlaydi.
 */
function fitProjectCardHeight(proj) {
  const el = projectEls.get(proj.id);
  if (!el) return PROJ_CONTENT_MIN_H;
  const counts = projectConnCounts(proj.id);
  const floor = projectHeight(counts.left, counts.right);
  el.style.height = "auto";
  const natural = el.scrollHeight;
  const finalHeight = Math.max(natural, floor);
  el.style.height = finalHeight + "px";
  return finalHeight;
}

/**
 * Ulanishning HOZIRGI (dinamik) chap/o'ng tomonini hisoblaydi — bu qat'iy saqlangan
 * qiymat emas, balki xodim va loyihaning JORIY nisbiy joylashuviga qarab har safar
 * qayta hisoblanadi: xodim loyihadan chapda tursa — xodimning o'ng nuqtasi loyihaning
 * chap tomoniga ulanadi (bir-biriga "qarab" turadi), aksincha bo'lsa — teskarisi.
 * Shunday qilib, kartalarni sudrab ko'chirganda ip doim silliq (to'g'ridan-to'g'ri,
 * qiyshaymasdan) ulanib turadi.
 */
function connSides(conn) {
  const emp = state.employees.find((e) => e.id === conn.employeeId);
  const proj = state.projects.find((p) => p.id === conn.projectId);
  if (!emp || !proj) return { empSide: conn.empSide || "right", projSide: conn.projSide || "left" };
  const empCenterX = emp.x + EMP_W / 2;
  const projCenterX = proj.x + PROJ_W / 2;
  return empCenterX <= projCenterX ? { empSide: "right", projSide: "left" } : { empSide: "left", projSide: "right" };
}

function projectSideConnections(projectId, side) {
  return state.connections.filter((c) => c.projectId === projectId && connSides(c).projSide === side);
}

function projectConnCounts(projectId) {
  return {
    left: projectSideConnections(projectId, "left").length,
    right: projectSideConnections(projectId, "right").length,
  };
}

/** Berilgan ulanishning loyiha tomonidagi (dunyo koordinatasidagi) nuqtasini hisoblaydi. */
function projConnPointWorldPos(conn) {
  const proj = state.projects.find((p) => p.id === conn.projectId);
  if (!proj) return { x: 0, y: 0 };
  const side = connSides(conn).projSide;
  const sideConns = projectSideConnections(proj.id, side);
  const idx = sideConns.findIndex((c) => c.id === conn.id);
  const h = getProjectCardHeight(proj);
  const count = sideConns.length || 1;
  const y = ((idx + 1) / (count + 1)) * h;
  const x = side === "left" ? -7 : PROJ_W + 7;
  return { x: proj.x + x, y: proj.y + y };
}

function employeePointOffset(side) {
  return side === "left" ? { offsetX: -7, offsetY: EMP_H / 2 } : { offsetX: EMP_W + 7, offsetY: EMP_H / 2 };
}

/* ---------------------- Loyiha ish jarayoni (real vaqt asosida) ---------------------- */

/** Loyihaning jami kerakli ish-soati: soni × 1 donaga ketadigan vaqt (1 ta xodim ishlaganda). */
function projectTotalManHours(proj) {
  return (Number(proj.qty) || 0) * (Number(proj.hoursPerUnit) || 0);
}

/** Berilgan xodimning hozir jami nechta loyihaga ulanganini qaytaradi. */
function employeeConnectionCount(employeeId) {
  return state.connections.filter((c) => c.employeeId === employeeId).length;
}

/**
 * Xodimning BITTA loyihaga qo'shadigan "ulushi": oddiy xodim uchun har doim 1.
 * "Ko'p tarmoqli" xodim bir vaqtning o'zida N ta loyihaga ulangan bo'lsa, uning
 * vaqti/soati ular orasida teng bo'linadi — har biriga 1/N ulush tegadi
 * (masalan 2 ta loyihaga ulangan bo'lsa, har biriga yarim soat hisoblanadi).
 */
function employeeWeightOnProject(employeeId) {
  const n = employeeConnectionCount(employeeId);
  return n > 0 ? 1 / n : 0;
}

/** Loyihaga hozir ulangan xodimlarning (ulush bilan hisoblangan) "jonli kuchi" yig'indisi. */
function projectEmployeeCount(projectId) {
  return state.connections
    .filter((c) => c.projectId === projectId)
    .reduce((sum, c) => sum + employeeWeightOnProject(c.employeeId), 0);
}

/** Loyihaga hozir ulangan xodimlar ro'yxati. */
function projectConnectedEmployees(projectId) {
  const ids = new Set(state.connections.filter((c) => c.projectId === projectId).map((c) => c.employeeId));
  return state.employees.filter((e) => ids.has(e.id));
}

/** Xodimning oylik maoshidan soatlik stavkasi. */
function employeeHourlyRate(emp) {
  return (Number(emp && emp.salary) || 0) / MONTHLY_WORK_HOURS;
}

/**
 * Loyihaga hozir ulangan barcha xodimlarning soatlik stavkalari yig'indisi — har bir
 * xodimning stavkasi ham (ko'p tarmoqli bo'lsa) uning shu loyihadagi ulushiga
 * (`employeeWeightOnProject`) ko'ra bo'linib qo'shiladi.
 */
function projectHourlyRateSum(projectId) {
  return state.connections
    .filter((c) => c.projectId === projectId)
    .reduce((sum, c) => {
      const emp = state.employees.find((e) => e.id === c.employeeId);
      if (!emp) return sum;
      return sum + employeeHourlyRate(emp) * employeeWeightOnProject(c.employeeId);
    }, 0);
}

/**
 * `checkpointAt` dan `atMs` gacha to'plangan ish-soatlarni (joriy xodimlar soniga ko'paytirib)
 * `workedManHours`ga, xuddi shu davrdagi ish haqini (soatlik stavkalar yig'indisiga ko'paytirib)
 * `workedCost`ga qo'shib, checkpointAt'ni yangilaydi. Xodim ulanishi/uzilishi kabi tezlikni
 * o'zgartiradigan har bir hodisadan OLDIN chaqirilishi kerak — shunda eski tarkib (va uning
 * narxi) to'g'ri hisoblanadi.
 */
function commitProjectProgress(proj, atMs) {
  if (!proj || !proj.placed || !proj.checkpointAt) return;
  const now = atMs || Date.now();
  if (now <= proj.checkpointAt) return;
  const count = projectEmployeeCount(proj.id);
  const rateSum = projectHourlyRateSum(proj.id);
  const hours = effectiveWorkHoursBetween(proj.checkpointAt, now, proj.nightShift);
  proj.workedManHours = (Number(proj.workedManHours) || 0) + hours * count;
  proj.workedCost = (Number(proj.workedCost) || 0) + hours * rateSum;
  // Haqiqiy (real) o'tgan ish vaqti — xodimlar soniga KO'PAYTIRILMAYDI (man-soatdan farqli
  // o'laroq). Loyihaga necha xodim ulangan bo'lishidan qat'iy nazar, bu maydon "jarayon
  // qancha real vaqt davomida faol bo'lgani"ni ko'rsatadi (0 xodimda — pauza, hisoblanmaydi).
  if (count > 0) {
    proj.workedRealHours = (Number(proj.workedRealHours) || 0) + hours;
  }

  // Har bir ULANGAN xodimning shu loyihadagi shaxsiy hissasini ham alohida
  // ("employeeLedger") qayd etamiz — bu loyiha tugagach "kim qancha ishlagani"ni
  // bilish uchun kerak. Xodim keyinchalik uzilib qolsa ham, bu yozuv saqlanib
  // qoladi (faqat o'sishi to'xtaydi) — shu orqali tarixiy hissa yo'qolmaydi.
  // "Ko'p tarmoqli" xodim uchun `employeeWeightOnProject` uning vaqtini shu payt
  // ulangan barcha loyihalari orasida teng bo'lib beradi (masalan 2 ta bo'lsa — yarmi).
  if (!proj.employeeLedger) proj.employeeLedger = {};
  state.connections
    .filter((c) => c.projectId === proj.id)
    .forEach((c) => {
      const emp = state.employees.find((e) => e.id === c.employeeId);
      const weight = employeeWeightOnProject(c.employeeId);
      const rate = employeeHourlyRate(emp);
      const entry = proj.employeeLedger[c.employeeId] || { realHours: 0, cost: 0, name: "" };
      entry.realHours += hours * weight;
      entry.cost += hours * weight * rate;
      if (emp) entry.name = emp.name;
      proj.employeeLedger[c.employeeId] = entry;
    });

  proj.checkpointAt = now;
}

/**
 * Loyihaning "tungi smena" holatini (yoqiq/o'chiq) almashtiradi. Almashtirishdan OLDIN
 * hozirgacha to'plangan progress ESKI rejim (jadval) bo'yicha qayd etib qo'yiladi —
 * shunda allaqachon ishlangan qism qayta hisoblanib ketmaydi, va yangi rejim faqat
 * shu daqiqadan boshlab kuchga kiradi. Tungi smena vaqtida xodimlarni almashtirish
 * ham xuddi shu checkpoint mexanizmi orqali (createConnection/deleteConnection
 * ichidagi commitProjectProgress chaqiruvlari bilan) avtomatik to'g'ri hisoblanadi.
 */
function toggleProjectNightShift(id) {
  const proj = state.projects.find((p) => p.id === id);
  if (!proj || !proj.placed) return;
  const now = Date.now();
  commitProjectProgress(proj, now);
  proj.checkpointAt = now;
  proj.nightShift = !proj.nightShift;

  const el = projectEls.get(proj.id);
  if (el) {
    const btn = el.querySelector('[data-role="night-toggle"]');
    if (btn) btn.classList.toggle("active", !!proj.nightShift);
    el.classList.toggle("night-active", !!proj.nightShift);
  }
  updateProjectTimeInfo(proj);
  renderProjectEmployeeTables();
  saveState();
}

/** Hozirgi vaqtga qadar (state'ga yozmasdan, faqat ko'rsatish uchun) to'plangan jami ish-soat. */
function liveWorkedManHours(proj, atMs) {
  if (!proj.placed || !proj.checkpointAt) return 0;
  const now = atMs || Date.now();
  const count = projectEmployeeCount(proj.id);
  const hours = effectiveWorkHoursBetween(proj.checkpointAt, now, proj.nightShift);
  return (Number(proj.workedManHours) || 0) + hours * count;
}

/** Hozirgi vaqtga qadar (state'ga yozmasdan) to'plangan jami ish haqi (so'm). */
function liveWorkedCost(proj, atMs) {
  if (!proj.placed || !proj.checkpointAt) return 0;
  const now = atMs || Date.now();
  const rateSum = projectHourlyRateSum(proj.id);
  const hours = effectiveWorkHoursBetween(proj.checkpointAt, now, proj.nightShift);
  return (Number(proj.workedCost) || 0) + hours * rateSum;
}

/**
 * Hozirgi vaqtga qadar (state'ga yozmasdan) to'plangan HAQIQIY (real) ish vaqti — soat.
 * Man-soatdan farqli o'laroq, ulangan xodimlar soniga KO'PAYTIRILMAYDI: loyihaga 1 ta
 * xodim ulangan bo'lsa ham, 5 ta ulangan bo'lsa ham, bu son bir xil — "jarayon real
 * vaqtda qancha davom etgani"ni ko'rsatadi (0 xodimda — pauza, o'smaydi).
 */
function liveWorkedRealHours(proj, atMs) {
  if (!proj.placed || !proj.checkpointAt) return 0;
  const now = atMs || Date.now();
  const count = projectEmployeeCount(proj.id);
  const hours = count > 0 ? effectiveWorkHoursBetween(proj.checkpointAt, now, proj.nightShift) : 0;
  return (Number(proj.workedRealHours) || 0) + hours;
}

/**
 * Berilgan xodimning shu loyihadagi (saqlangan + hozirgacha "jonli" to'plangan)
 * shaxsiy hissasini qaytaradi: {realHours, cost, name}. Xodim hozir bu loyihaga
 * ulanmagan bo'lsa (masalan avval ulangan, keyin uzilgan), faqat saqlangan
 * (muzlatilgan) qiymat qaytariladi — endi o'smaydi.
 */
function liveEmployeeLedgerEntry(proj, employeeId, atMs) {
  const stored = (proj.employeeLedger && proj.employeeLedger[employeeId]) || { realHours: 0, cost: 0, name: "" };
  const isConnected = state.connections.some((c) => c.projectId === proj.id && c.employeeId === employeeId);
  if (!proj.placed || !proj.checkpointAt || !isConnected) return stored;
  const now = atMs || Date.now();
  const hours = effectiveWorkHoursBetween(proj.checkpointAt, now, proj.nightShift);
  const weight = employeeWeightOnProject(employeeId);
  const emp = state.employees.find((e) => e.id === employeeId);
  const rate = employeeHourlyRate(emp);
  return {
    realHours: stored.realHours + hours * weight,
    cost: stored.cost + hours * weight * rate,
    name: (emp && emp.name) || stored.name,
  };
}

/**
 * Loyihaga hozir ulangan VA avval ulanib, keyin uzilib qolgan (lekin hissasi
 * saqlanib qolgan) barcha xodimlarning jadval qatorlarini tayyorlaydi.
 * Har bir qator: {employeeId, name, connected, realHours, cost}.
 * Ulangan xodimlar tepada, so'ng eng ko'p ishlaganidan boshlab tartiblanadi.
 */
function projectLedgerRows(proj, atMs) {
  const now = atMs || Date.now();
  const connectedIds = new Set(state.connections.filter((c) => c.projectId === proj.id).map((c) => c.employeeId));
  const historyIds = new Set(Object.keys(proj.employeeLedger || {}));
  const allIds = new Set([...connectedIds, ...historyIds]);
  const rows = [];
  allIds.forEach((employeeId) => {
    const entry = liveEmployeeLedgerEntry(proj, employeeId, now);
    const emp = state.employees.find((e) => e.id === employeeId);
    const name = (emp && emp.name) || entry.name || "(o'chirilgan xodim)";
    rows.push({
      employeeId,
      name,
      connected: connectedIds.has(employeeId),
      realHours: entry.realHours,
      cost: entry.cost,
    });
  });
  rows.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return b.realHours - a.realHours;
  });
  return rows;
}

/**
 * Loyihaning joriy vaqt va xarajat holatini hisoblaydi:
 * {total, worked, done, remainingManHours, etaMs, paused, workedCost, projectedTotalCost}.
 * `projectedTotalCost` — hozirgacha sarflangan + joriy jamoa shu tezlikda davom etsa
 * ketadigan taxminiy qo'shimcha xarajat (loyiha tugagach — aniq yakuniy xarajat).
 */
function projectProgressInfo(proj, atMs) {
  const now = atMs || Date.now();
  const total = projectTotalManHours(proj);
  const worked = liveWorkedManHours(proj, now);
  const workedCost = liveWorkedCost(proj, now);
  const realHours = liveWorkedRealHours(proj, now);
  const count = projectEmployeeCount(proj.id);
  const rateSum = projectHourlyRateSum(proj.id);
  // Loyiha "tugadi" deb belgilanishi ISH-SOAT (worked, xodimlar soniga ko'paytirilgan)
  // maqsadga (total) yetganda sodir bo'ladi: `total` "1 ta xodim ishlaganda" kerak
  // bo'ladigan vaqtni bildiradi (projectTotalManHours izohiga qarang) — shuning uchun
  // ko'proq xodim ulansa, loyiha REAL vaqtda tezroq tugaydi (masalan 2 baravar xodim —
  // 2 baravar tez). Xodimlar soni HAM tugash tezligiga, HAM xarajatga ta'sir qiladi.
  const done = total > 0 && worked >= total;
  const remainingManHours = Math.max(0, total - worked);
  let etaMs = null;
  let projectedTotalCost = workedCost;
  if (!done && count > 0) {
    // Qolgan ish-soat joriy jamoa tezligiga (count) bo'linib, qolgan REAL soatga
    // aylantiriladi — ko'proq xodim bo'lsa, qolgan real vaqt shunchalik qisqaradi.
    const remainingRealHours = remainingManHours / count;
    etaMs = advanceEffectiveHours(now, remainingRealHours, proj.nightShift);
    projectedTotalCost = workedCost + remainingRealHours * rateSum;
  }
  return {
    total,
    worked: Math.min(worked, total),
    realHours: Math.min(realHours, total),
    done,
    remainingManHours,
    etaMs,
    paused: !done && count === 0,
    workedCost,
    projectedTotalCost,
  };
}

/* ------------------------------ Modal boshqaruvi ------------------------------ */

function openModal(modalEl) {
  modalEl.classList.remove("hidden");
}
function closeModal(modalEl) {
  modalEl.classList.add("hidden");
}

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const modal = document.getElementById(btn.dataset.close);
    if (modal === employeeModal) editingEmployeeId = null;
    if (modal === projectModal) editingProjectId = null;
    closeModal(modal);
  });
});

[employeeModal, projectModal].forEach((modal) => {
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) {
      if (modal === employeeModal) editingEmployeeId = null;
      if (modal === projectModal) editingProjectId = null;
      closeModal(modal);
    }
  });
});

/** null bo'lsa — yangi xodim qo'shish rejimi; aks holda shu id'li xodim tahrirlanmoqda. */
let editingEmployeeId = null;

const employeeModalTitle = employeeModal.querySelector("h2");
const employeeModalSubmitBtn = employeeForm.querySelector('button[type="submit"]');

function resetEmployeeModalForCreate() {
  editingEmployeeId = null;
  employeeModalTitle.textContent = "Yangi xodim";
  employeeModalSubmitBtn.textContent = "OK";
  employeeForm.reset();
  const preview = document.getElementById("empPhotoPreview");
  preview.classList.remove("has-photo");
  preview.dataset.photo = "";
}

document.getElementById("btnAddEmployee").addEventListener("click", () => {
  resetEmployeeModalForCreate();
  openModal(employeeModal);
});

function openEditEmployeeModal(id) {
  const emp = state.employees.find((e) => e.id === id);
  if (!emp) return;

  editingEmployeeId = id;
  employeeModalTitle.textContent = "Xodimni tahrirlash";
  employeeModalSubmitBtn.textContent = "Saqlash";

  document.getElementById("empName").value = emp.name;
  document.getElementById("empPosition").value = emp.position;
  document.getElementById("empSalary").value = emp.salary;
  document.getElementById("empMultiBranch").checked = !!emp.multiBranch;
  document.getElementById("empPhoto").value = "";

  const preview = document.getElementById("empPhotoPreview");
  const img = document.getElementById("empPhotoImg");
  if (emp.photo) {
    img.src = emp.photo;
    preview.dataset.photo = emp.photo;
    preview.classList.add("has-photo");
  } else {
    preview.dataset.photo = "";
    preview.classList.remove("has-photo");
  }

  openModal(employeeModal);
}

/** null bo'lsa — yangi loyiha qo'shish rejimi; aks holda shu id'li loyiha tahrirlanmoqda. */
let editingProjectId = null;

const projectModalTitle = projectModal.querySelector("h2");
const projectModalSubmitBtn = projectForm.querySelector('button[type="submit"]');

function resetProjectModalForCreate() {
  editingProjectId = null;
  projectModalTitle.textContent = "Yangi loyiha";
  projectModalSubmitBtn.textContent = "OK";
  projectForm.reset();
  const preview = document.getElementById("projPhotoPreview");
  preview.classList.remove("has-photo");
  preview.dataset.photo = "";
}

document.getElementById("btnAddProject").addEventListener("click", () => {
  resetProjectModalForCreate();
  openModal(projectModal);
});

function openEditProjectModal(id) {
  const proj = state.projects.find((p) => p.id === id);
  if (!proj) return;

  editingProjectId = id;
  projectModalTitle.textContent = "Loyihani tahrirlash";
  projectModalSubmitBtn.textContent = "Saqlash";

  document.getElementById("projName").value = proj.name;
  document.getElementById("projQty").value = proj.qty;
  document.getElementById("projHoursPerUnit").value = proj.hoursPerUnit;
  document.getElementById("projPhoto").value = "";

  const preview = document.getElementById("projPhotoPreview");
  const img = document.getElementById("projPhotoImg");
  if (proj.photo) {
    img.src = proj.photo;
    preview.dataset.photo = proj.photo;
    preview.classList.add("has-photo");
  } else {
    preview.dataset.photo = "";
    preview.classList.remove("has-photo");
  }

  openModal(projectModal);
}

/* ------------------------------ Ro'yxat qatori uchun kontekst menyu ------------------------------ */

const rosterContextMenu = document.createElement("div");
rosterContextMenu.className = "context-menu hidden";
rosterContextMenu.innerHTML = `
  <button type="button" data-action="edit">Tahrirlash</button>
  <button type="button" data-action="delete">O'chirish</button>
`;
document.body.appendChild(rosterContextMenu);

let contextMenuTargetId = null;
let contextMenuTargetType = null; // "employee" | "project"

function openRosterContextMenu(clientX, clientY, id, type) {
  contextMenuTargetId = id;
  contextMenuTargetType = type;
  rosterContextMenu.style.left = clientX + "px";
  rosterContextMenu.style.top = clientY + "px";
  rosterContextMenu.classList.remove("hidden");

  // Ekrandan tashqariga chiqib ketmasligi uchun moslashtirish
  const rect = rosterContextMenu.getBoundingClientRect();
  const overflowX = rect.right - window.innerWidth;
  const overflowY = rect.bottom - window.innerHeight;
  if (overflowX > 0) rosterContextMenu.style.left = clientX - overflowX + "px";
  if (overflowY > 0) rosterContextMenu.style.top = clientY - overflowY + "px";
}

function closeRosterContextMenu() {
  rosterContextMenu.classList.add("hidden");
  contextMenuTargetId = null;
  contextMenuTargetType = null;
}

rosterContextMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || !contextMenuTargetId || !contextMenuTargetType) return;
  const action = btn.dataset.action;
  const id = contextMenuTargetId;
  const type = contextMenuTargetType;
  closeRosterContextMenu();

  if (type === "employee") {
    if (action === "edit") openEditEmployeeModal(id);
    if (action === "delete") deleteEmployee(id);
  } else if (type === "project") {
    if (action === "edit") openEditProjectModal(id);
    if (action === "delete") deleteProject(id);
  }
});

document.addEventListener("mousedown", (e) => {
  if (!rosterContextMenu.classList.contains("hidden") && !rosterContextMenu.contains(e.target)) {
    closeRosterContextMenu();
  }
});

document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".roster-item")) closeRosterContextMenu();
});

window.addEventListener("blur", closeRosterContextMenu);

document.getElementById("empPhoto").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUri = await readAndCompressImage(file);
  const preview = document.getElementById("empPhotoPreview");
  const img = document.getElementById("empPhotoImg");
  img.src = dataUri;
  preview.dataset.photo = dataUri;
  preview.classList.add("has-photo");
});

document.getElementById("projPhoto").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUri = await readAndCompressImage(file);
  const preview = document.getElementById("projPhotoPreview");
  const img = document.getElementById("projPhotoImg");
  img.src = dataUri;
  preview.dataset.photo = dataUri;
  preview.classList.add("has-photo");
});

employeeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("empName").value.trim();
  const position = document.getElementById("empPosition").value.trim();
  const salary = Number(document.getElementById("empSalary").value);
  const photo = document.getElementById("empPhotoPreview").dataset.photo || "";
  const multiBranch = document.getElementById("empMultiBranch").checked;
  if (!name || !position) return;

  if (editingEmployeeId) {
    // Tahrirlash rejimi: mavjud xodim ma'lumotlari yangilanadi.
    const emp = state.employees.find((x) => x.id === editingEmployeeId);
    if (emp) {
      const wasMultiBranch = !!emp.multiBranch;
      emp.name = name;
      emp.position = position;
      emp.salary = salary;
      emp.photo = photo;
      emp.multiBranch = multiBranch;
      updateRosterItemContent(emp);
      if (emp.placed) updateEmployeeCardContent(emp);

      // "Ko'p tarmoqli" o'chirilganda, xodim hozircha bir nechta loyihaga ulangan bo'lishi
      // mumkin — bunday holda faqat birinchi ulanish qoldirilib, qolganlari (avvalgi ulush
      // bilan progressni to'g'ri qayd etgan holda) deleteConnection orqali uziladi.
      if (wasMultiBranch && !multiBranch) {
        const conns = state.connections.filter((c) => c.employeeId === emp.id);
        conns.slice(1).forEach((c) => deleteConnection(c.id));
      }

      saveState();
    }
    editingEmployeeId = null;
    closeModal(employeeModal);
    return;
  }

  // Yangi xodim avval faqat chap paneldagi ro'yxatga qo'shiladi.
  // Ish maydonida karta faqat foydalanuvchi uni sudrab tashlagach paydo bo'ladi.
  const employee = {
    id: genId(),
    name,
    position,
    salary,
    photo,
    multiBranch,
    x: 0,
    y: 0,
    placed: false,
  };
  state.employees.push(employee);
  renderRosterItem(employee);
  updateSidebarEmptyState();
  saveState();
  closeModal(employeeModal);
});

projectForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("projName").value.trim();
  const qty = Math.max(1, Math.round(Number(document.getElementById("projQty").value)));
  const hoursPerUnit = Math.max(0, Number(document.getElementById("projHoursPerUnit").value));
  const photo = document.getElementById("projPhotoPreview").dataset.photo || "";
  if (!name) return;

  if (editingProjectId) {
    // Tahrirlash rejimi: mavjud loyiha ma'lumotlari yangilanadi.
    // Diqqat: soni/vaqt me'yori o'zgartirilsa ham, ish jarayoni (boshlangan vaqt, to'plangan
    // ish-soat) qayta boshlanmaydi — faqat "kerakli jami vaqt" yangi qiymatga moslanadi.
    const proj = state.projects.find((x) => x.id === editingProjectId);
    if (proj) {
      proj.name = name;
      proj.qty = qty;
      proj.hoursPerUnit = hoursPerUnit;
      proj.photo = photo;

      updateProjectRosterItemContent(proj);
      if (proj.placed) updateProjectCardContent(proj);

      saveState();
    }
    editingProjectId = null;
    closeModal(projectModal);
    return;
  }

  // Yangi loyiha avval faqat o'ng paneldagi ro'yxatga qo'shiladi.
  // Ish maydonida to'rtburchak faqat foydalanuvchi uni sudrab tashlagach paydo bo'ladi.
  // Ulanish nuqtalari soni endi qo'lda belgilanmaydi — xodimlar ulangan sari
  // avtomatik ravishda mos tomonga (chap/o'ng) qo'shilib boradi.
  const project = {
    id: genId(),
    name,
    qty,
    hoursPerUnit,
    photo,
    x: 0,
    y: 0,
    placed: false,
    startedAt: null,
    checkpointAt: null,
    workedManHours: 0,
    workedCost: 0,
    workedRealHours: 0,
    nightShift: false,
  };
  state.projects.push(project);
  renderProjectRosterItem(project);
  updateProjectSidebarEmptyState();
  saveState();
  closeModal(projectModal);
});

function getViewportCenterWorld() {
  const rect = workspace.getBoundingClientRect();
  return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function updateEmptyHint() {
  const hasAny = employeeEls.size > 0 || projectEls.size > 0;
  emptyHint.style.display = hasAny ? "none" : "block";
}

function updateSidebarEmptyState() {
  sidebarEmpty.style.display = state.employees.length > 0 ? "none" : "block";
  updateEmployeeStats();
}

function updateProjectSidebarEmptyState() {
  projectSidebarEmpty.style.display = state.projects.length > 0 ? "none" : "block";
  updateProjectStats();
}

/** Chap paneldagi "Xodimlar soni" / "Ishlayotgan xodimlar" hisoblagichlarini yangilaydi. */
function updateEmployeeStats() {
  const totalEl = document.getElementById("statEmployeeTotal");
  const workingEl = document.getElementById("statEmployeeWorking");
  if (!totalEl || !workingEl) return;
  totalEl.textContent = state.employees.length;
  workingEl.textContent = state.employees.filter((e) => e.placed).length;
}

/** O'ng paneldagi "Loyihalar soni" / "Jarayon boshlangan loyihalar" hisoblagichlarini yangilaydi. */
function updateProjectStats() {
  const totalEl = document.getElementById("statProjectTotal");
  const startedEl = document.getElementById("statProjectStarted");
  if (!totalEl || !startedEl) return;
  totalEl.textContent = state.projects.length;
  startedEl.textContent = state.projects.filter((p) => p.placed).length;
}

/* ------------------------------ Render: Xodim ------------------------------ */

function renderEmployee(emp) {
  const el = document.createElement("div");
  el.className = "card employee-card" + (emp.multiBranch ? " multi-branch" : "");
  el.dataset.id = emp.id;
  el.style.left = emp.x + "px";
  el.style.top = emp.y + "px";
  el.style.width = EMP_W + "px";
  el.style.height = EMP_H + "px";

  el.innerHTML = `
    <button class="card-delete" title="O'chirish" data-role="delete">×</button>
    <div class="conn-point conn-left" data-side="left" data-owner="employee" data-id="${emp.id}"></div>
    <img class="emp-photo" src="${emp.photo || DEFAULT_EMP_AVATAR}" alt="">
    <div class="emp-body">
      <div class="emp-name">${escapeHtml(emp.name)}</div>
      <div class="emp-position">${escapeHtml(emp.position)}</div>
      <div class="emp-salary">${formatMoney(emp.salary)}</div>
    </div>
    <div class="conn-point conn-right" data-side="right" data-owner="employee" data-id="${emp.id}"></div>
  `;

  cardsLayer.appendChild(el);
  employeeEls.set(emp.id, el);

  attachCardDrag(el, emp, "employee");
  el.querySelector('[data-role="delete"]').addEventListener("mousedown", (e) => e.stopPropagation());
  el.querySelector('[data-role="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    // Ish maydonidagi × faqat kartani ish maydonidan olib tashlaydi —
    // xodim ro'yxatda ("joylashtirilmagan" holatda) saqlanib qoladi.
    unplaceEmployee(emp.id);
  });

  el.querySelectorAll(".conn-point").forEach((pointEl) => {
    attachConnectionPointHandlers(pointEl);
  });

  updateEmployeeConnPointVisual(emp.id);
}

function updateEmployeeCardContent(emp) {
  const el = employeeEls.get(emp.id);
  if (!el) return;
  el.querySelector(".emp-photo").src = emp.photo || DEFAULT_EMP_AVATAR;
  el.querySelector(".emp-name").textContent = emp.name;
  el.querySelector(".emp-position").textContent = emp.position;
  el.querySelector(".emp-salary").textContent = formatMoney(emp.salary);
  el.classList.toggle("multi-branch", !!emp.multiBranch);
}

/**
 * Xodim kartasini ish maydonidan olib tashlaydi (ulanishlari bilan birga),
 * lekin xodimning o'zini va uning ro'yxatdagi qatorini SAQLAB QOLADI —
 * u qayta ro'yxatdan sudrab tashlanishi mumkin bo'lib qoladi.
 */
function unplaceEmployee(id) {
  const emp = state.employees.find((e) => e.id === id);
  const el = employeeEls.get(id);
  if (el) el.remove();
  employeeEls.delete(id);

  const removed = state.connections.filter((c) => c.employeeId === id);
  const unplaceNow = Date.now();
  removed.forEach((c) => {
    const p = state.projects.find((x) => x.id === c.projectId);
    if (p) commitProjectProgress(p, unplaceNow);
  });
  state.connections = state.connections.filter((c) => c.employeeId !== id);
  removed.forEach((c) => removeConnectionEl(c.id));
  removed.forEach((c) => refreshProjectLayout(c.projectId));

  if (emp) {
    emp.placed = false;
    emp.x = 0;
    emp.y = 0;
  }

  updateRosterItemPlacedState(id);
  updateEmptyHint();
  saveState();
}

function updateEmployeeConnPointVisual(empId) {
  const el = employeeEls.get(empId);
  if (!el) return;
  const conns = state.connections.filter((c) => c.employeeId === empId);
  el.querySelectorAll(".conn-point").forEach((p) => p.classList.remove("occupied"));
  conns.forEach((conn) => {
    const activeSide = connSides(conn).empSide;
    const pointEl = el.querySelector(`.conn-point[data-side="${activeSide}"]`);
    if (pointEl) pointEl.classList.add("occupied");
  });
}

/* ------------------------------ Xodimlar ro'yxati (sidebar) ------------------------------ */

function renderRosterItem(emp) {
  const row = document.createElement("div");
  row.className = "roster-item" + (emp.placed ? " placed" : "");
  row.dataset.id = emp.id;

  row.innerHTML = `
    <img class="roster-photo" src="${emp.photo || DEFAULT_EMP_AVATAR}" alt="">
    <div class="roster-info">
      <div class="roster-name">${escapeHtml(emp.name)}</div>
      <div class="roster-position">${escapeHtml(emp.position)}</div>
      <div class="roster-salary">${formatMoney(emp.salary)}</div>
      <div class="roster-badge">✓ Joylashtirilgan</div>
    </div>
    <button class="roster-delete" title="O'chirish">×</button>
  `;

  sidebarList.appendChild(row);
  rosterEls.set(emp.id, row);

  const delBtn = row.querySelector(".roster-delete");
  delBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Ro'yxatdagi × — xodimni hammasidan (ro'yxat + ish maydoni) butunlay o'chiradi.
    deleteEmployee(emp.id);
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openRosterContextMenu(e.clientX, e.clientY, emp.id, "employee");
  });

  attachRosterDrag(row, emp);
}

function updateRosterItemPlacedState(id) {
  const row = rosterEls.get(id);
  if (row) {
    const emp = state.employees.find((e) => e.id === id);
    row.classList.toggle("placed", !!(emp && emp.placed));
  }
  updateEmployeeStats();
}

function updateRosterItemContent(emp) {
  const row = rosterEls.get(emp.id);
  if (!row) return;
  row.querySelector(".roster-photo").src = emp.photo || DEFAULT_EMP_AVATAR;
  row.querySelector(".roster-name").textContent = emp.name;
  row.querySelector(".roster-position").textContent = emp.position;
  row.querySelector(".roster-salary").textContent = formatMoney(emp.salary);
}

function isPointInsideWorkspace(clientX, clientY) {
  const rect = workspace.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function attachRosterDrag(rowEl, emp) {
  rowEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".roster-delete")) return;
    const current = state.employees.find((x) => x.id === emp.id);
    if (!current || current.placed) return; // allaqachon joylashtirilgan — panel orqali qayta ko'chirilmaydi
    e.preventDefault();
    startRosterDrag(current, rowEl, e);
  });
}

function startRosterDrag(emp, rowEl, startEvent) {
  const ghost = document.createElement("div");
  ghost.className = "roster-ghost";
  ghost.innerHTML = `<img src="${emp.photo || DEFAULT_EMP_AVATAR}" alt=""><span>${escapeHtml(emp.name)}</span>`;
  document.body.appendChild(ghost);

  function positionGhost(clientX, clientY) {
    ghost.style.left = clientX + 14 + "px";
    ghost.style.top = clientY + 10 + "px";
  }
  positionGhost(startEvent.clientX, startEvent.clientY);

  rowEl.classList.add("dragging-source");

  function onMove(ev) {
    positionGhost(ev.clientX, ev.clientY);
    workspace.classList.toggle("drop-target", isPointInsideWorkspace(ev.clientX, ev.clientY));
  }

  function onUp(ev) {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    ghost.remove();
    rowEl.classList.remove("dragging-source");
    workspace.classList.remove("drop-target");

    if (isPointInsideWorkspace(ev.clientX, ev.clientY)) {
      placeEmployeeOnCanvas(emp, ev.clientX, ev.clientY);
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function placeEmployeeOnCanvas(emp, clientX, clientY) {
  const worldPos = clientToWorld(clientX, clientY);
  emp.x = Math.round(worldPos.x - EMP_W / 2);
  emp.y = Math.round(worldPos.y - EMP_H / 2);
  emp.placed = true;

  renderEmployee(emp);
  updateRosterItemPlacedState(emp.id);
  updateEmptyHint();
  saveState();
}

/* ------------------------------ Loyihalar ro'yxati (o'ng panel) ------------------------------ */

function renderProjectRosterItem(proj) {
  const row = document.createElement("div");
  row.className = "roster-item" + (proj.placed ? " placed" : "");
  row.dataset.id = proj.id;

  row.innerHTML = `
    <img class="roster-photo" src="${proj.photo || DEFAULT_PROJ_IMG}" alt="">
    <div class="roster-info">
      <div class="roster-name">${escapeHtml(proj.name)}</div>
      <div class="roster-position">${projectQtyLabel(proj)}</div>
      <div class="roster-salary">${projectConnectedLabel(proj.id)}</div>
      <div class="roster-badge">✓ Joylashtirilgan</div>
    </div>
    <button class="roster-delete" title="O'chirish">×</button>
  `;

  projectSidebarList.appendChild(row);
  projRosterEls.set(proj.id, row);

  const delBtn = row.querySelector(".roster-delete");
  delBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Ro'yxatdagi × — loyihani hammasidan (ro'yxat + ish maydoni) butunlay o'chiradi.
    deleteProject(proj.id);
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openRosterContextMenu(e.clientX, e.clientY, proj.id, "project");
  });

  attachProjectRosterDrag(row, proj);
}

function updateProjectRosterItemPlacedState(id) {
  const row = projRosterEls.get(id);
  if (row) {
    const proj = state.projects.find((p) => p.id === id);
    row.classList.toggle("placed", !!(proj && proj.placed));
  }
  updateProjectStats();
}

function projectConnectedLabel(projectId) {
  const n = state.connections.filter((c) => c.projectId === projectId).length;
  return n + " ta xodim ulangan";
}

function projectQtyLabel(proj) {
  return proj.qty + " dona × " + formatHours(proj.hoursPerUnit) + " = " + formatHours(projectTotalManHours(proj));
}

function updateProjectRosterItemContent(proj) {
  const row = projRosterEls.get(proj.id);
  if (!row) return;
  row.querySelector(".roster-photo").src = proj.photo || DEFAULT_PROJ_IMG;
  row.querySelector(".roster-name").textContent = proj.name;
  row.querySelector(".roster-position").textContent = projectQtyLabel(proj);
  row.querySelector(".roster-salary").textContent = projectConnectedLabel(proj.id);
}

function attachProjectRosterDrag(rowEl, proj) {
  rowEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".roster-delete")) return;
    const current = state.projects.find((x) => x.id === proj.id);
    if (!current || current.placed) return; // allaqachon joylashtirilgan — panel orqali qayta ko'chirilmaydi
    e.preventDefault();
    startProjectRosterDrag(current, rowEl, e);
  });
}

function startProjectRosterDrag(proj, rowEl, startEvent) {
  const ghost = document.createElement("div");
  ghost.className = "roster-ghost";
  ghost.innerHTML = `<img src="${proj.photo || DEFAULT_PROJ_IMG}" alt=""><span>${escapeHtml(proj.name)}</span>`;
  document.body.appendChild(ghost);

  function positionGhost(clientX, clientY) {
    ghost.style.left = clientX + 14 + "px";
    ghost.style.top = clientY + 10 + "px";
  }
  positionGhost(startEvent.clientX, startEvent.clientY);

  rowEl.classList.add("dragging-source");

  function onMove(ev) {
    positionGhost(ev.clientX, ev.clientY);
    workspace.classList.toggle("drop-target", isPointInsideWorkspace(ev.clientX, ev.clientY));
  }

  function onUp(ev) {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    ghost.remove();
    rowEl.classList.remove("dragging-source");
    workspace.classList.remove("drop-target");

    if (isPointInsideWorkspace(ev.clientX, ev.clientY)) {
      placeProjectOnCanvas(proj, ev.clientX, ev.clientY);
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function placeProjectOnCanvas(proj, clientX, clientY) {
  const worldPos = clientToWorld(clientX, clientY);
  const h = projectHeight(0, 0); // yangi joylashtirilgan loyihada ulanishlar hali yo'q
  proj.x = Math.round(worldPos.x - PROJ_W / 2);
  proj.y = Math.round(worldPos.y - h / 2);
  proj.placed = true;

  // Ish maydoniga har safar (qayta) tortib tashlanganda, vaqt hisoblagichi
  // shu daqiqadan boshlab yangidan ishga tushadi.
  const now = Date.now();
  proj.startedAt = now;
  proj.checkpointAt = now;
  proj.workedManHours = 0;
  proj.workedCost = 0;
  proj.workedRealHours = 0;
  proj.employeeLedger = {};
  if (proj.tableCollapsed === undefined) proj.tableCollapsed = false;

  renderProject(proj);
  updateProjectRosterItemPlacedState(proj.id);
  updateEmptyHint();
  renderProjectEmployeeTables();
  saveState();
}

/* ------------------------------ Render: Loyiha ------------------------------ */

function renderProject(proj) {
  const el = document.createElement("div");
  el.className = "card project-card";
  el.dataset.id = proj.id;
  el.style.left = proj.x + "px";
  el.style.top = proj.y + "px";
  el.style.width = PROJ_W + "px";

  el.innerHTML = `
    <button class="card-delete" title="O'chirish" data-role="delete">×</button>
    <button type="button" class="night-toggle" data-role="night-toggle" title="Tungi smena (18:00–02:00)">
      <span class="night-toggle-icon">🌙</span>
      <span class="night-toggle-text">Tungi smena</span>
      <span class="night-toggle-switch"><span class="night-toggle-knob"></span></span>
    </button>
    <button type="button" class="finish-btn hidden" data-role="finish-btn" title="Loyihani hozir (muddatidan oldin ham) tugatish">
      <span>✔ Tugatish</span>
    </button>
    <img class="proj-photo" src="${proj.photo || DEFAULT_PROJ_IMG}" alt="">
    <div class="proj-name">${escapeHtml(proj.name)}</div>
    <div class="proj-hours">${escapeHtml(projectQtyLabel(proj))}</div>
    <div class="proj-time"></div>
  `;

  cardsLayer.appendChild(el);
  projectEls.set(proj.id, el);

  attachCardDrag(el, proj, "project");
  const nightBtn = el.querySelector('[data-role="night-toggle"]');
  nightBtn.classList.toggle("active", !!proj.nightShift);
  el.classList.toggle("night-active", !!proj.nightShift);
  nightBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  nightBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleProjectNightShift(proj.id);
  });
  const finishBtn = el.querySelector('[data-role="finish-btn"]');
  finishBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  finishBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = state.projects.find((p) => p.id === proj.id);
    if (!current) return;
    if (confirm(`"${current.name}" loyihasini hozir tugatishni tasdiqlaysizmi?\nBu amalni orqaga qaytarib bo'lmaydi.`)) {
      finishProjectNow(current.id);
    }
  });
  el.querySelector('[data-role="delete"]').addEventListener("mousedown", (e) => e.stopPropagation());
  el.querySelector('[data-role="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    // Ish maydonidagi × faqat to'rtburchakni ish maydonidan olib tashlaydi —
    // loyiha ro'yxatda ("joylashtirilmagan" holatda) saqlanib qoladi.
    unplaceProject(proj.id);
  });

  updateProjectTimeInfo(proj);
}

/**
 * Loyihani hozir (muddatidan oldin ham) qo'lda tugatadi: hozirgacha to'plangan
 * progress qayd etiladi (commitProjectProgress), so'ng kerakli jami ish-soatiga
 * yetganini majburlab belgilaydi — shu orqali loyiha xuddi tabiiy ravishda
 * o'z vaqtida tugagandek "✓ Tugadi" holatiga o'tadi. Bu payt allaqachon
 * to'plangan haqiqiy ish soatlari/xarajat/xodimlar hissasi (employeeLedger)
 * o'zgarishsiz qoladi — faqat "qolgan vaqt" hisoblanishi to'xtaydi. Natijada
 * 15 daqiqalik avtomatik Telegram xabarnomasi (check-completed-projects.js)
 * keyingi ishga tushishida buni tabiiy tugagan loyiha kabi aniqlab, yakuniy
 * xodim jadvali bilan birga xabar yuboradi.
 */
function finishProjectNow(id) {
  const proj = state.projects.find((p) => p.id === id);
  if (!proj || !proj.placed) return;
  const now = Date.now();
  commitProjectProgress(proj, now);
  const total = projectTotalManHours(proj);
  if (total > 0) {
    // "Tugadi" holati ish-soatga (workedManHours) qarab aniqlanadi — qo'lda
    // tugatishda buni majburan maqsadga yetkazamiz.
    proj.workedManHours = Math.max(Number(proj.workedManHours) || 0, total);
    proj.workedRealHours = Math.max(Number(proj.workedRealHours) || 0, total);
  }
  proj.checkpointAt = now;
  updateProjectTimeInfo(proj);
  renderProjectEmployeeTables();
  saveState();
  // Server tekshiruvini (15 daqiqa) kutmasdan, "Qilingan ishlar" ro'yxatiga darhol
  // qo'shamiz — botga xabar yuborish esa (kechikishi mumkin bo'lgani uchun) avvalgidek
  // faqat serverdagi 15 daqiqalik tekshiruvga qoldiriladi.
  pushCompletedWorkEntry(proj, now);
}

/**
 * Loyihani "Qilingan ishlar" ro'yxatiga (Firebase "completedWorks") darhol yozadi —
 * "Tugatish" tugmasi bosilganda chaqiriladi, server tekshiruvini kutmaydi.
 * "completedWorksLogged/<id>" bayrog'i orqali, keyinroq server tekshiruvi (15 daqiqada
 * bir) xuddi shu loyiha uchun ikkinchi marta (dublikat) yozuv qo'shib qo'ymasligi
 * ta'minlanadi. Loyiha keyinchalik qayta ish maydoniga tashlab, qaytadan tugatilsa,
 * server tekshiruvi bu bayroqni o'zi tozalab, keyingi tugashda qayta yozadi.
 */
function pushCompletedWorkEntry(proj, finishedAt) {
  if (!fbAuth.currentUser) return;
  const loggedRef = fbDb.ref("completedWorksLogged/" + proj.id);
  loggedRef
    .once("value")
    .then((snap) => {
      if (snap.val()) return;
      const info = projectProgressInfo(proj, finishedAt);
      const rows = projectLedgerRows(proj, finishedAt).map((r) => ({
        name: r.name,
        connected: !!r.connected,
        hoursText: formatDurationHours(r.realHours),
        costText: formatMoney(r.cost),
      }));
      return fbDb
        .ref("completedWorks")
        .push({
          id: proj.id,
          name: proj.name,
          startedAt: proj.startedAt || null,
          finishedAt,
          allocatedText: formatHours(projectTotalManHours(proj)),
          realHoursText: formatDurationHours(info.realHours),
          totalCostText: formatMoney(info.workedCost),
          rows,
        })
        .then(() => loggedRef.set(true));
    })
    .catch((err) => console.warn("Qilingan ishlar ro'yxatiga yozishda xatolik:", err));
}

/**
 * Loyiha kartasidagi vaqt blokini (boshlangan sana, o'tgan/qolgan vaqt yoki
 * "tugadi" belgisi) joriy holatga moslab qayta chizadi. Bu real vaqt bilan
 * bog'liq bo'lgani uchun davriy taymer orqali ham chaqiriladi.
 *
 * Matn qancha joy egallashidan qat'iy nazar (uzun sana, katta summa va h.k.),
 * funksiya oxirida karta balandligi HAQIQIY kontentga moslab qayta o'lchanadi
 * (fitProjectCardHeight) va nuqta belgilari/ulanish chiziqlari shu yangi
 * balandlikka moslab qayta chiziladi — shu sababli matn hech qachon karta
 * tashqarisiga "toshib" chiqmaydi.
 */
function updateProjectTimeInfo(proj) {
  const el = projectEls.get(proj.id);
  if (!el) return;
  const timeEl = el.querySelector(".proj-time");
  if (!timeEl) return;
  const finishBtn = el.querySelector('[data-role="finish-btn"]');

  if (!proj.startedAt) {
    timeEl.innerHTML = "";
    if (finishBtn) finishBtn.classList.add("hidden");
  } else {
    const info = projectProgressInfo(proj);
    // "Tugatish" tugmasi faqat hali tugamagan va kerakli jami vaqti belgilangan
    // (total > 0) loyihalarda ko'rinadi — allaqachon tugagan loyihani qayta
    // "tugatish"ning ma'nosi yo'q.
    if (finishBtn) finishBtn.classList.toggle("hidden", info.done || info.total <= 0);
    const startLabel = `<div class="proj-time-line proj-time-label">Boshlandi</div>`;
    const startBig = `<div class="proj-time-line proj-time-startbig">${formatDateTime(proj.startedAt)}</div>`;
    const empCount = state.connections.filter((c) => c.projectId === proj.id).length;
    const empCountLine = `<div class="proj-time-line proj-time-empcount">Ulangan xodimlar soni: ${empCount}</div>`;

    if (info.total <= 0) {
      timeEl.innerHTML = startLabel + startBig;
      el.classList.remove("proj-done", "proj-paused");
    } else if (info.done) {
      // Loyiha tugagan haqiqiy (taxminiy) vaqt — oxirgi checkpoint (15s/30s aniqlikda).
      const finishLabel = `<div class="proj-time-line proj-time-label">Tugash vaqti</div>`;
      const finishBig = `<div class="proj-time-line proj-time-finishbig">${formatDateTime(proj.checkpointAt)}</div>`;
      const costLine = `<div class="proj-time-line proj-time-cost">Mehnat narxi: ${formatMoney(info.workedCost)}</div>`;
      timeEl.innerHTML =
        startLabel +
        startBig +
        finishLabel +
        finishBig +
        `<div class="proj-time-line proj-time-done">✓ Tugadi</div>` +
        empCountLine +
        costLine;
      el.classList.add("proj-done");
      el.classList.remove("proj-paused");
    } else {
      el.classList.remove("proj-done");
      const finishLabel = `<div class="proj-time-line proj-time-label">Tugash vaqti</div>`;
      let finishBig, costLine, remainingLine = "";
      if (info.paused) {
        // Xodim ulanmagan — jarayon to'xtab turibdi, tugash vaqtini hisoblab bo'lmaydi.
        finishBig = `<div class="proj-time-line proj-time-finishbig">— <span class="proj-time-finish-note">(xodim ulanmagan)</span></div>`;
        costLine = `<div class="proj-time-line proj-time-cost">Mehnat narxi (hozircha): ${formatMoney(info.workedCost)}</div>`;
        el.classList.add("proj-paused");
      } else {
        // Tugash vaqti — joriy xodimlar soniga qarab taxmin qilingan BASHORAT (soat:daqiqa,
        // yonidagi qavsda qancha kun qolgani, eng yaqin 0,5 kunga yaxlitlangan). Bu qiymat
        // ish tezligi (xodimlar soni) o'zgarmasa, taxminan o'sha-o'sha turadi.
        const daysSuffix = formatDaysSuffix(info.etaMs - Date.now());
        finishBig = `<div class="proj-time-line proj-time-finishbig">${formatTimeOnly(info.etaMs)}<span class="proj-time-finish-days">${daysSuffix}</span></div>`;
        // Qoldi — jonli TAYMER: "Tugash vaqti"gacha real vaqtda qancha qolganini
        // ko'rsatadi va har tikda muqarrar kamayib boradi.
        const countdownText = formatCountdown(info.etaMs - Date.now());
        remainingLine = `<div class="proj-time-line proj-time-remaining">Qoldi: ${countdownText}</div>`;
        costLine = `<div class="proj-time-line proj-time-cost">Mehnat narxi: ~${formatMoney(info.projectedTotalCost)}</div>`;
        el.classList.remove("proj-paused");
      }
      timeEl.innerHTML = startLabel + startBig + finishLabel + finishBig + remainingLine + empCountLine + costLine;
    }
  }

  fitProjectCardHeight(proj);
  renderProjectMarkers(proj);
  updateConnectionsForCard(proj.id, "project");
}

/** Ish maydonidagi barcha joylashtirilgan loyihalarning vaqt ko'rsatkichlarini yangilaydi. */
function updateAllProjectTimeInfo() {
  state.projects.forEach((proj) => {
    if (proj.placed) updateProjectTimeInfo(proj);
  });
  renderProjectEmployeeTables();
}

/**
 * Loyiha kartasidagi ulanish nuqtasi belgilarini (vizual doiralarni) qayta chizadi.
 * Har bir mavjud ulanish uchun bitta belgi — chap yoki o'ng tomonda, teng taqsimlangan holda.
 */
function renderProjectMarkers(proj) {
  const el = projectEls.get(proj.id);
  if (!el) return;
  el.querySelectorAll(".proj-marker").forEach((m) => m.remove());

  const leftConns = projectSideConnections(proj.id, "left");
  const rightConns = projectSideConnections(proj.id, "right");
  const h = getProjectCardHeight(proj);

  leftConns.forEach((c, i) => {
    const y = ((i + 1) / (leftConns.length + 1)) * h;
    const m = document.createElement("div");
    m.className = "proj-marker";
    m.style.left = "-7px";
    m.style.top = y + "px";
    el.appendChild(m);
  });
  rightConns.forEach((c, i) => {
    const y = ((i + 1) / (rightConns.length + 1)) * h;
    const m = document.createElement("div");
    m.className = "proj-marker";
    m.style.left = PROJ_W + 7 + "px";
    m.style.top = y + "px";
    el.appendChild(m);
  });
}

/**
 * Loyiha kartasining balandligi va nuqta belgilarini joriy ulanishlar soniga moslab
 * qayta hisoblaydi, so'ng shu loyihaga ulangan chiziqlarni yangilaydi. Bu har safar
 * bir ulanish qo'shilganda/o'chirilganda chaqiriladi.
 */
/**
 * Faqat balandlik/nuqta belgilari/chiziqlarni yangilaydi — sudrash (drag) paytida
 * har bir sichqoncha harakatida chaqirish uchun yengil versiya (ro'yxat/vaqt matnini
 * qayta hisoblamaydi, shuning uchun tez).
 */
function refreshProjectConnectionsLayout(projectId) {
  const proj = state.projects.find((p) => p.id === projectId);
  if (!proj || !proj.placed) return;
  const el = projectEls.get(projectId);
  if (!el) return;
  fitProjectCardHeight(proj);
  renderProjectMarkers(proj);
  updateConnectionsForCard(projectId, "project");
  // Loyiha ko'chganda ulangan xodimlarning "band" nuqtasi (chap/o'ng) ham
  // yangi nisbiy joylashuvga qarab yangilanishi kerak.
  state.connections
    .filter((c) => c.projectId === projectId)
    .forEach((c) => updateEmployeeConnPointVisual(c.employeeId));
}

function refreshProjectLayout(projectId) {
  const proj = state.projects.find((p) => p.id === projectId);
  if (!proj) return;
  updateProjectRosterItemContent(proj);
  refreshProjectConnectionsLayout(projectId);
  if (proj.placed) updateProjectTimeInfo(proj);
}

function updateProjectCardContent(proj) {
  const el = projectEls.get(proj.id);
  if (!el) return;
  el.querySelector(".proj-photo").src = proj.photo || DEFAULT_PROJ_IMG;
  el.querySelector(".proj-name").textContent = proj.name;
  el.querySelector(".proj-hours").textContent = projectQtyLabel(proj);
  updateProjectTimeInfo(proj);
  renderProjectEmployeeTables();
}

/* ------------------------- Loyiha-xodim hisobot jadvallari (o'ng panel) ------------------------- */

const projectTablesPanelEl = document.getElementById("projectTablesPanel");

/**
 * Ish maydonidagi HAR BIR joylashtirilgan loyiha uchun avtomatik ravishda bitta
 * (yig'iladigan/yoyiladigan) jadval chizadi: loyiha nomi, ajratilgan vaqt va unga
 * ulangan (hamda avval ulanib, keyin uzilgan) xodimlarning shaxsiy hissasi
 * (vaqt + summasi). "Ko'p tarmoqli" xodimning vaqti bir nechta loyiha orasida
 * avtomatik bo'linib hisoblanadi (masalan 2 loyihaga ulangan bo'lsa — har biriga
 * yarmi). Bu panel #workspace ichida joylashgani uchun Export (JPG/PDF) qilinganda
 * ham to'liq rasmga tushadi.
 */
function renderProjectEmployeeTables() {
  if (!projectTablesPanelEl) return;
  const placedProjects = state.projects.filter((p) => p.placed);
  if (placedProjects.length === 0) {
    projectTablesPanelEl.innerHTML = "";
    projectTablesPanelEl.classList.add("hidden");
    return;
  }
  projectTablesPanelEl.classList.remove("hidden");

  const now = Date.now();
  projectTablesPanelEl.innerHTML = placedProjects
    .map((proj) => {
      const collapsed = !!proj.tableCollapsed;
      const rows = projectLedgerRows(proj, now);
      const rowsHtml = rows.length
        ? rows
            .map(
              (r) => `
          <tr class="${r.connected ? "" : "ptbl-row-disconnected"}">
            <td class="ptbl-td-name">${escapeHtml(r.name)}${r.connected ? "" : ' <span class="ptbl-tag">uzilgan</span>'}</td>
            <td class="ptbl-td-time">${formatDurationHours(r.realHours)}</td>
            <td class="ptbl-td-cost">${formatMoney(r.cost)}</td>
          </tr>`
            )
            .join("")
        : `<tr><td colspan="3" class="ptbl-empty-row">Hali xodim ulanmagan</td></tr>`;

      return `
        <div class="ptbl" data-project-id="${proj.id}">
          <div class="ptbl-header" data-role="ptbl-toggle">
            <span class="ptbl-name">${escapeHtml(proj.name)}</span>
            <button type="button" class="ptbl-collapse-btn" data-role="ptbl-toggle" title="Yig'ish/Yoyish">${collapsed ? "+" : "−"}</button>
          </div>
          <div class="ptbl-body"${collapsed ? " hidden" : ""}>
            <div class="ptbl-allocated">Ajratilgan vaqt: ${escapeHtml(formatHours(projectTotalManHours(proj)))}</div>
            <table class="ptbl-table">
              <thead><tr><th>Xodim</th><th>Vaqt</th><th>Summasi</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>`;
    })
    .join("");
}

if (projectTablesPanelEl) {
  projectTablesPanelEl.addEventListener("click", (e) => {
    const toggleEl = e.target.closest('[data-role="ptbl-toggle"]');
    if (!toggleEl) return;
    const cardEl = e.target.closest(".ptbl");
    if (!cardEl) return;
    const proj = state.projects.find((p) => p.id === cardEl.dataset.projectId);
    if (!proj) return;
    proj.tableCollapsed = !proj.tableCollapsed;
    const bodyEl = cardEl.querySelector(".ptbl-body");
    const btnEl = cardEl.querySelector(".ptbl-collapse-btn");
    if (bodyEl) bodyEl.hidden = !!proj.tableCollapsed;
    if (btnEl) btnEl.textContent = proj.tableCollapsed ? "+" : "−";
    saveState();
  });
}

/**
 * Loyiha to'rtburchagini ish maydonidan olib tashlaydi (ulanishlari bilan birga),
 * lekin loyihaning o'zini va uning ro'yxatdagi qatorini SAQLAB QOLADI —
 * u qayta ro'yxatdan sudrab tashlanishi mumkin bo'lib qoladi.
 */
function unplaceProject(id) {
  const proj = state.projects.find((p) => p.id === id);
  const el = projectEls.get(id);
  if (el) el.remove();
  projectEls.delete(id);

  const removed = state.connections.filter((c) => c.projectId === id);

  // Bu loyihaga ulangan xodimlar orasida "ko'p tarmoqli" bo'lganlari bo'lsa, ularning
  // BOSHQA loyihalaridagi ulushi ham o'zgaradi (ulanishlar soni kamayadi) — shuning
  // uchun o'sha boshqa loyihalarni eski ulush bilan oldindan qayd etib qo'yamiz.
  const otherAffectedProjectIds = new Set();
  removed.forEach((c) => {
    state.connections
      .filter((x) => x.employeeId === c.employeeId && x.projectId !== id)
      .forEach((x) => otherAffectedProjectIds.add(x.projectId));
  });
  const commitNow = Date.now();
  otherAffectedProjectIds.forEach((pid) => {
    const p = state.projects.find((x) => x.id === pid);
    if (p) commitProjectProgress(p, commitNow);
  });

  state.connections = state.connections.filter((c) => c.projectId !== id);
  removed.forEach((c) => removeConnectionEl(c.id));
  removed.forEach((c) => updateEmployeeConnPointVisual(c.employeeId));
  otherAffectedProjectIds.forEach((pid) => refreshProjectLayout(pid));

  if (proj) {
    proj.placed = false;
    proj.x = 0;
    proj.y = 0;
  }

  updateProjectRosterItemPlacedState(id);
  updateEmptyHint();
  renderProjectEmployeeTables();
  saveState();
}

/* ------------------------------ O'chirish ------------------------------ */

function deleteEmployee(id) {
  state.employees = state.employees.filter((e) => e.id !== id);
  const el = employeeEls.get(id);
  if (el) el.remove();
  employeeEls.delete(id);

  const rosterEl = rosterEls.get(id);
  if (rosterEl) rosterEl.remove();
  rosterEls.delete(id);

  const removed = state.connections.filter((c) => c.employeeId === id);
  const deleteNow = Date.now();
  removed.forEach((c) => {
    const p = state.projects.find((x) => x.id === c.projectId);
    if (p) commitProjectProgress(p, deleteNow);
  });
  state.connections = state.connections.filter((c) => c.employeeId !== id);
  removed.forEach((c) => removeConnectionEl(c.id));
  removed.forEach((c) => refreshProjectLayout(c.projectId));

  updateEmptyHint();
  updateSidebarEmptyState();
  renderProjectEmployeeTables();
  saveState();
}

function deleteProject(id) {
  state.projects = state.projects.filter((p) => p.id !== id);
  const el = projectEls.get(id);
  if (el) el.remove();
  projectEls.delete(id);

  const rosterEl = projRosterEls.get(id);
  if (rosterEl) rosterEl.remove();
  projRosterEls.delete(id);

  const removed = state.connections.filter((c) => c.projectId === id);

  // Bu loyihaga ulangan "ko'p tarmoqli" xodimlarning boshqa loyihalardagi ulushi ham
  // o'zgaradi — o'sha loyihalarni eski ulush bilan oldindan qayd etib qo'yamiz.
  const otherAffectedProjectIds = new Set();
  removed.forEach((c) => {
    state.connections
      .filter((x) => x.employeeId === c.employeeId && x.projectId !== id)
      .forEach((x) => otherAffectedProjectIds.add(x.projectId));
  });
  const commitNow = Date.now();
  otherAffectedProjectIds.forEach((pid) => {
    const p = state.projects.find((x) => x.id === pid);
    if (p) commitProjectProgress(p, commitNow);
  });

  state.connections = state.connections.filter((c) => c.projectId !== id);
  removed.forEach((c) => removeConnectionEl(c.id));
  removed.forEach((c) => updateEmployeeConnPointVisual(c.employeeId));
  otherAffectedProjectIds.forEach((pid) => refreshProjectLayout(pid));

  updateEmptyHint();
  updateProjectSidebarEmptyState();
  renderProjectEmployeeTables();
  saveState();
}

/* ------------------------------ Kartani sudrash (drag) ------------------------------ */

function attachCardDrag(el, dataObj, kind) {
  let dragging = false;
  let startWorld = null;
  let startX = 0;
  let startY = 0;

  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".conn-point") || e.target.closest(".card-delete")) return;
    e.stopPropagation();
    e.preventDefault();

    dragging = true;
    el.classList.add("dragging");
    startWorld = clientToWorld(e.clientX, e.clientY);
    startX = dataObj.x;
    startY = dataObj.y;

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  function onMove(ev) {
    if (!dragging) return;
    const w = clientToWorld(ev.clientX, ev.clientY);
    dataObj.x = Math.round(startX + (w.x - startWorld.x));
    dataObj.y = Math.round(startY + (w.y - startWorld.y));
    el.style.left = dataObj.x + "px";
    el.style.top = dataObj.y + "px";

    if (kind === "employee") {
      // Xodim qaysi tomonga (loyihaning chapiga yoki o'ngiga) ko'chsa, ulanish shu
      // tomonga "silliq" o'tib turishi uchun tomonlarni har harakatda qayta hisoblaymiz.
      // "Ko'p tarmoqli" xodim bir nechta loyihaga ulangan bo'lishi mumkin — barchasi
      // yangilanadi (faqat birinchisi emas).
      updateEmployeeConnPointVisual(dataObj.id);
      const touchedProjectIds = new Set(state.connections.filter((c) => c.employeeId === dataObj.id).map((c) => c.projectId));
      touchedProjectIds.forEach((pid) => refreshProjectConnectionsLayout(pid));
    } else {
      refreshProjectConnectionsLayout(dataObj.id);
    }
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    saveState();
  }
}

/* ------------------------------ Ulanish chizig'ini tortish ------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Hozir foydalanuvchi yangi ulanish chizig'ini sudrab tortayotgan bo'lsa, shu holatni saqlaydi. */
let connectingState = null;

function attachConnectionPointHandlers(pointEl) {
  // Faqat xodim nuqtalarida ishlaydi — ulanish har doim xodimdan boshlanadi
  // va loyihaning butun kartasiga tekizilganda avtomatik yakunlanadi
  // (qaysi tomondan tortilsa, loyihaning o'sha tomoniga ulanadi).
  pointEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    startConnecting(pointEl);
  });
}

/**
 * Ikki nuqta orasida silliq bezier chiziq quradi. Har bir nuqtaning "tashqi"
 * tomoni (chap/o'ng) alohida beriladi, shunda boshqaruv nuqtasi HAR DOIM shu
 * nuqtaning o'zidan tashqariga (kartadan uzoqlashadigan tomonga) yo'naladi —
 * bu ikkala nuqta bir-biriga nisbatan qanday joylashganidan qat'iy nazar,
 * chiziqning karta ichidan "aylanib o'tishi"ning oldini oladi.
 */
function bezierPath(x1, y1, side1, x2, y2, side2) {
  const dx = Math.max(45, Math.abs(x2 - x1) * 0.5);
  const c1x = side1 === "left" ? x1 - dx : x1 + dx;
  const c2x = side2 === "left" ? x2 - dx : x2 + dx;
  return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
}

function startConnecting(sourcePointEl) {
  const emp = state.employees.find((x) => x.id === sourcePointEl.dataset.id);
  if (!emp) return;
  const off = employeePointOffset(sourcePointEl.dataset.side);
  const startPos = { x: emp.x + off.offsetX, y: emp.y + off.offsetY };

  connectingState = {
    sourceId: sourcePointEl.dataset.id,
    sourceSide: sourcePointEl.dataset.side,
    startPos,
    tempPath: null,
  };

  workspace.classList.add("connecting");

  const tempPath = document.createElementNS(SVG_NS, "path");
  tempPath.setAttribute("class", "conn-line-temp");
  svg.appendChild(tempPath);
  connectingState.tempPath = tempPath;
  tempPath.setAttribute("d", bezierPath(startPos.x, startPos.y, connectingState.sourceSide, startPos.x, startPos.y, connectingState.sourceSide === "left" ? "right" : "left"));

  window.addEventListener("mousemove", onConnectMove);
  window.addEventListener("mouseup", onConnectUp);
}

function hoveredProjectCard(clientX, clientY) {
  const targetEl = document.elementFromPoint(clientX, clientY);
  return targetEl ? targetEl.closest(".project-card") : null;
}

function onConnectMove(ev) {
  if (!connectingState) return;
  const worldPos = clientToWorld(ev.clientX, ev.clientY);
  // Kursor hali biror kartaga "biriktirilmagan" — shuning uchun uning "tashqi"
  // tomonini manba nuqtasiga nisbatan qaysi tarafda turganiga qarab aniqlaymiz,
  // shunda tortilayotgan chiziq ham silliq (aylanib ketmaydigan) bo'lib ko'rinadi.
  const cursorSide = worldPos.x >= connectingState.startPos.x ? "left" : "right";
  connectingState.tempPath.setAttribute(
    "d",
    bezierPath(connectingState.startPos.x, connectingState.startPos.y, connectingState.sourceSide, worldPos.x, worldPos.y, cursorSide)
  );

  // Kursor ostidagi loyiha kartasini ajratib ko'rsatamiz — shu yerga tashlansa ulanadi.
  const hovered = hoveredProjectCard(ev.clientX, ev.clientY);
  document.querySelectorAll(".project-card.drop-hover").forEach((el) => {
    if (el !== hovered) el.classList.remove("drop-hover");
  });
  if (hovered) hovered.classList.add("drop-hover");
}

function onConnectUp(ev) {
  window.removeEventListener("mousemove", onConnectMove);
  window.removeEventListener("mouseup", onConnectUp);
  if (!connectingState) return;

  workspace.classList.remove("connecting");

  const projCard = hoveredProjectCard(ev.clientX, ev.clientY);
  if (projCard) {
    // Qaysi tomondan (chap/o'ng) tortilgan bo'lsa, loyihaning o'sha tomoniga ulanadi.
    createConnection(connectingState.sourceId, connectingState.sourceSide, projCard.dataset.id, connectingState.sourceSide);
  }

  if (connectingState.tempPath) connectingState.tempPath.remove();
  document.querySelectorAll(".project-card.drop-hover").forEach((el) => el.classList.remove("drop-hover"));
  connectingState = null;
}

/* ------------------------------ Ulanishlarni boshqarish ------------------------------ */

/** Xodimning (odatda yagona) birinchi ulanishini qaytaradi — ko'p tarmoqli xodimlar
 * uchun barcha ulanishlarni olish kerak bo'lsa, `state.connections.filter(...)` ishlatiladi. */
function getEmployeeConnection(employeeId) {
  return state.connections.find((c) => c.employeeId === employeeId) || null;
}

function createConnection(employeeId, empSide, projectId, projSide) {
  const emp = state.employees.find((e) => e.id === employeeId);
  const existing = state.connections.filter((c) => c.employeeId === employeeId);

  // Oddiy xodim faqat 1 ta ulanishga ega bo'lishi mumkin — eski ulanishi bo'lsa, avval u
  // olib tashlanadi. "Ko'p tarmoqli" xodim uchun esa faqat SHU loyihaga bo'lgan eski
  // ulanish almashtiriladi (masalan tomonini o'zgartirsa) — boshqa loyihalardagi
  // ulanishlari saqlanib qoladi, chunki u bir vaqtda bir nechtasiga ulangan bo'lishi mumkin.
  const toRemove = emp && emp.multiBranch ? existing.filter((c) => c.projectId === projectId) : existing;

  // Xodimning ulanishlar soni (demak — har bir loyihaga tegadigan ulush) o'zgarishidan
  // OLDIN, xodimning HOZIRGI barcha loyihalarini (yangisi bilan birga) ESKI ulush bilan
  // qayd etib qo'yamiz — shunda avvalgi progress to'g'ri hisoblanadi.
  const affectedProjectIds = new Set(existing.map((c) => c.projectId));
  affectedProjectIds.add(projectId);

  const commitNow = Date.now();
  affectedProjectIds.forEach((pid) => {
    const p = state.projects.find((x) => x.id === pid);
    if (p) commitProjectProgress(p, commitNow);
  });

  toRemove.forEach((c) => {
    state.connections = state.connections.filter((x) => x.id !== c.id);
    removeConnectionEl(c.id);
  });

  const conn = { id: genId(), employeeId, empSide, projectId, projSide };
  state.connections.push(conn);
  renderConnection(conn);

  updateEmployeeConnPointVisual(employeeId);
  affectedProjectIds.forEach((pid) => refreshProjectLayout(pid));
  renderProjectEmployeeTables();

  saveState();
}

function deleteConnection(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) return;

  // Shu xodimning BOSHQA ulanishlariga ham ta'sir qiladi ("ko'p tarmoqli" bo'lsa,
  // ulanishlar soni kamayishi bilan qolganlarning ulushi oshadi) — shuning uchun
  // xodimning barcha joriy loyihalarini eski ulush bilan oldindan qayd etamiz.
  const affectedProjectIds = new Set(
    state.connections.filter((c) => c.employeeId === conn.employeeId).map((c) => c.projectId)
  );
  const commitNow = Date.now();
  affectedProjectIds.forEach((pid) => {
    const p = state.projects.find((x) => x.id === pid);
    if (p) commitProjectProgress(p, commitNow);
  });

  state.connections = state.connections.filter((c) => c.id !== id);
  removeConnectionEl(id);
  updateEmployeeConnPointVisual(conn.employeeId);
  affectedProjectIds.forEach((pid) => refreshProjectLayout(pid));
  renderProjectEmployeeTables();
  saveState();
}

function renderConnection(conn) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "conn-line");
  path.dataset.id = conn.id;
  path.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteConnection(conn.id);
  });
  svg.appendChild(path);
  connectionEls.set(conn.id, path);
  updateConnectionPath(conn);
}

function updateConnectionPath(conn) {
  const path = connectionEls.get(conn.id);
  if (!path) return;
  const emp = state.employees.find((e) => e.id === conn.employeeId);
  const proj = state.projects.find((p) => p.id === conn.projectId);
  if (!emp || !proj) return;

  const sides = connSides(conn);
  const empOff = employeePointOffset(sides.empSide);
  const projPos = projConnPointWorldPos(conn);

  const x1 = emp.x + empOff.offsetX;
  const y1 = emp.y + empOff.offsetY;
  path.setAttribute("d", bezierPath(x1, y1, sides.empSide, projPos.x, projPos.y, sides.projSide));
}

function updateConnectionsForCard(id, kind) {
  const relevant = state.connections.filter((c) => (kind === "employee" ? c.employeeId === id : c.projectId === id));
  relevant.forEach(updateConnectionPath);
}

function removeConnectionEl(id) {
  const el = connectionEls.get(id);
  if (el) el.remove();
  connectionEls.delete(id);
}

/* ------------------------------ Pan (surish) ------------------------------ */

let isPanning = false;
let panStart = { x: 0, y: 0 };
let panOrigin = { x: 0, y: 0 };

workspace.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".card") || e.target.closest(".conn-point")) return;
  isPanning = true;
  workspace.classList.add("panning");
  panStart = { x: e.clientX, y: e.clientY };
  panOrigin = { x: state.view.panX, y: state.view.panY };
});

window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  state.view.panX = panOrigin.x + (e.clientX - panStart.x);
  state.view.panY = panOrigin.y + (e.clientY - panStart.y);
  applyView();
});

window.addEventListener("mouseup", () => {
  if (!isPanning) return;
  isPanning = false;
  workspace.classList.remove("panning");
  saveState();
});

/* ------------------------------ Zoom (kattalashtirish) ------------------------------ */

workspace.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomAt(e.clientX, e.clientY, factor);
  },
  { passive: false }
);

function zoomAt(clientX, clientY, factor) {
  const rect = workspace.getBoundingClientRect();
  const worldPos = clientToWorld(clientX, clientY);
  const newZoom = clamp(state.view.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  state.view.panX = clientX - rect.left - worldPos.x * newZoom;
  state.view.panY = clientY - rect.top - worldPos.y * newZoom;
  state.view.zoom = newZoom;
  applyView();
  saveState();
}

function applyView() {
  world.style.transform = `translate(${state.view.panX}px, ${state.view.panY}px) scale(${state.view.zoom})`;
  zoomLevelEl.textContent = Math.round(state.view.zoom * 100) + "%";
}

document.getElementById("btnZoomIn").addEventListener("click", () => {
  const rect = workspace.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, ZOOM_STEP);
});

document.getElementById("btnZoomOut").addEventListener("click", () => {
  const rect = workspace.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / ZOOM_STEP);
});

document.getElementById("btnZoomReset").addEventListener("click", () => {
  state.view = { panX: 0, panY: 0, zoom: 1 };
  applyView();
  saveState();
});

/* ------------------------------ Yon panellarni ixchamlash (faqat rasm) ------------------------------ */

/**
 * Chap (xodimlar) va o'ng (loyihalar) panellarni "faqat rasm" ko'rinishiga
 * o'tkazadi — panel torayadi, matnlar yashiriladi, faqat rasmlar qatori qoladi.
 * Bu ish maydoniga ko'proq joy bo'shatadi. Tanlov shu brauzerda (localStorage'da)
 * eslab qolinadi.
 */
const COMPACT_KEY_EMP = "xodimlarTartibi_compactEmp";
const COMPACT_KEY_PROJ = "xodimlarTartibi_compactProj";

const employeeSidebarEl = document.getElementById("employeeSidebar");
const projectSidebarEl = document.getElementById("projectSidebar");
const btnCompactEmpEl = document.getElementById("btnCompactEmp");
const btnCompactProjEl = document.getElementById("btnCompactProj");

function applyCompactSidebar(sidebarEl, btnEl, on, expandIcon, collapseIcon) {
  sidebarEl.classList.toggle("compact", on);
  btnEl.classList.toggle("active", on);
  btnEl.textContent = on ? expandIcon : collapseIcon;
  btnEl.title = on ? "To'liq ko'rinish" : "Faqat rasm (ixcham)";
}

function toggleCompactSidebar(sidebarEl, btnEl, storageKey, expandIcon, collapseIcon) {
  const on = !sidebarEl.classList.contains("compact");
  applyCompactSidebar(sidebarEl, btnEl, on, expandIcon, collapseIcon);
  try {
    localStorage.setItem(storageKey, on ? "1" : "0");
  } catch (err) {
    /* localStorage mavjud bo'lmasa — e'tiborsiz qoldiramiz */
  }
}

btnCompactEmpEl.addEventListener("click", () =>
  toggleCompactSidebar(employeeSidebarEl, btnCompactEmpEl, COMPACT_KEY_EMP, "⇥", "⇤")
);
btnCompactProjEl.addEventListener("click", () =>
  toggleCompactSidebar(projectSidebarEl, btnCompactProjEl, COMPACT_KEY_PROJ, "⇤", "⇥")
);

(function initCompactSidebars() {
  let empOn = false;
  let projOn = false;
  try {
    empOn = localStorage.getItem(COMPACT_KEY_EMP) === "1";
    projOn = localStorage.getItem(COMPACT_KEY_PROJ) === "1";
  } catch (err) {
    /* e'tiborsiz */
  }
  applyCompactSidebar(employeeSidebarEl, btnCompactEmpEl, empOn, "⇥", "⇤");
  applyCompactSidebar(projectSidebarEl, btnCompactProjEl, projOn, "⇤", "⇥");
})();

/* ------------------------------ Sozlamalar (karta o'lchami, chiziq ko'rinishi) ------------------------------ */

/**
 * `state.settings.empScale`/`projScale` (foizda, masalan 100 = bazaviy o'lcham)
 * asosida haqiqiy EMP_W/EMP_H/PROJ_W piksel qiymatlarini qayta hisoblaydi.
 * Bu qiymatlar nafaqat vizual (CSS) o'lchamni, balki ulanish nuqtalari va
 * chiziqlarning joylashuv matematikasini ham belgilaydi — shu sababli
 * o'zgargandan keyin BUTUN ish maydonini qayta chizish shart (resetRenderState).
 */
function applySizeSettings() {
  const s = state.settings || DEFAULT_SETTINGS;
  const empScale = clamp(Number(s.empScale) || 100, 60, 160) / 100;
  const projScale = clamp(Number(s.projScale) || 100, 60, 160) / 100;
  EMP_W = Math.round(EMP_W_BASE * empScale);
  EMP_H = Math.round(EMP_H_BASE * empScale);
  PROJ_W = Math.round(PROJ_W_BASE * projScale);
}

/** Ulanish chizig'ining rangi/qalinligini CSS custom property orqali (butun sahifa uchun) qo'llaydi. */
function applyConnStyleSettings() {
  const s = state.settings || DEFAULT_SETTINGS;
  const color = /^#[0-9a-fA-F]{6}$/.test(s.connColor) ? s.connColor : DEFAULT_SETTINGS.connColor;
  const width = clamp(Number(s.connWidth) || DEFAULT_SETTINGS.connWidth, 1, 6);
  document.documentElement.style.setProperty("--conn-color", color);
  document.documentElement.style.setProperty("--conn-width", String(width));
}

/** Sozlamalar oynasidagi input'larni joriy `state.settings`ga moslab ko'rsatadi. */
function syncSettingsFormFromState() {
  const s = { ...DEFAULT_SETTINGS, ...state.settings };
  settingsEmpScaleEl.value = s.empScale;
  settingsEmpScaleValEl.textContent = s.empScale + "%";
  settingsProjScaleEl.value = s.projScale;
  settingsProjScaleValEl.textContent = s.projScale + "%";
  settingsConnColorEl.value = s.connColor;
  settingsConnWidthEl.value = s.connWidth;
  settingsConnWidthValEl.textContent = s.connWidth + "px";
}

const btnSettingsEl = document.getElementById("btnSettings");
const settingsModalEl = document.getElementById("settingsModal");
const settingsEmpScaleEl = document.getElementById("settingsEmpScale");
const settingsEmpScaleValEl = document.getElementById("settingsEmpScaleVal");
const settingsProjScaleEl = document.getElementById("settingsProjScale");
const settingsProjScaleValEl = document.getElementById("settingsProjScaleVal");
const settingsConnColorEl = document.getElementById("settingsConnColor");
const settingsConnWidthEl = document.getElementById("settingsConnWidth");
const settingsConnWidthValEl = document.getElementById("settingsConnWidthVal");
const settingsResetBtnEl = document.getElementById("settingsResetBtn");

btnSettingsEl.addEventListener("click", () => {
  syncSettingsFormFromState();
  openModal(settingsModalEl);
});

settingsEmpScaleEl.addEventListener("input", () => {
  state.settings.empScale = Number(settingsEmpScaleEl.value);
  settingsEmpScaleValEl.textContent = state.settings.empScale + "%";
  applySizeSettings();
  resetRenderState();
  saveState();
});

settingsProjScaleEl.addEventListener("input", () => {
  state.settings.projScale = Number(settingsProjScaleEl.value);
  settingsProjScaleValEl.textContent = state.settings.projScale + "%";
  applySizeSettings();
  resetRenderState();
  saveState();
});

settingsConnColorEl.addEventListener("input", () => {
  state.settings.connColor = settingsConnColorEl.value;
  applyConnStyleSettings();
  saveState();
});

settingsConnWidthEl.addEventListener("input", () => {
  state.settings.connWidth = Number(settingsConnWidthEl.value);
  settingsConnWidthValEl.textContent = state.settings.connWidth + "px";
  applyConnStyleSettings();
  saveState();
});

settingsResetBtnEl.addEventListener("click", () => {
  state.settings = { ...DEFAULT_SETTINGS };
  syncSettingsFormFromState();
  applySizeSettings();
  applyConnStyleSettings();
  resetRenderState();
  saveState();
});

/* ------------------------------ Eksport (JPG / PDF) ------------------------------ */

/**
 * Ish maydonidagi BARCHA joylashtirilgan xodim va loyihalarning dunyo koordinatasidagi
 * chegaralarini hisoblaydi (eksport paytida hech biri "kesilib" qolmasligi uchun).
 * Hech narsa joylashtirilmagan bo'lsa — null.
 */
/**
 * `extraBottomYs` — ixtiyoriy, qo'shimcha (dunyo koordinatasidagi) pastki
 * chegaralar ro'yxati (masalan, eksport paytida loyiha kartalarining tagiga
 * vaqtincha joylashtirilgan jadvallarning pastki chetlari) — berilsa, ular
 * ham chegaraga qo'shib hisoblanadi, shunda kadrdan "kesilib" qolmaydi.
 */
function computeContentWorldBounds(extraBottomYs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.employees.filter((e) => e.placed).forEach((e) => {
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + EMP_W);
    maxY = Math.max(maxY, e.y + EMP_H);
  });
  state.projects.filter((p) => p.placed).forEach((p) => {
    const h = getProjectCardHeight(p);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + PROJ_W);
    maxY = Math.max(maxY, p.y + h);
  });
  // Ulanish chizig'ining bezier boshqaruv nuqtasi ikkala kartadan TASHQARIGA
  // (ulanish tomoni yo'nalishida) chiqib ketishi mumkin — bu nuqtalar ham
  // chegaraga kiritilmasa, uzoq masofadagi kartalarni bog'laydigan chiziqning
  // "bo'rtib chiqqan" qismi eksportda kesilib qolishi mumkin.
  state.connections.forEach((conn) => {
    const emp = state.employees.find((e) => e.id === conn.employeeId);
    const proj = state.projects.find((p) => p.id === conn.projectId);
    if (!emp || !proj) return;
    const sides = connSides(conn);
    const empOff = employeePointOffset(sides.empSide);
    const projPos = projConnPointWorldPos(conn);
    const x1 = emp.x + empOff.offsetX;
    const y1 = emp.y + empOff.offsetY;
    const dx = Math.max(45, Math.abs(projPos.x - x1) * 0.5);
    const c1x = sides.empSide === "left" ? x1 - dx : x1 + dx;
    const c2x = sides.projSide === "left" ? projPos.x - dx : projPos.x + dx;
    [c1x, x1, projPos.x, c2x].forEach((x) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    });
    [y1, projPos.y].forEach((y) => {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    });
  });
  if (Array.isArray(extraBottomYs)) {
    extraBottomYs.forEach((y) => {
      if (isFinite(y)) maxY = Math.max(maxY, y);
    });
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Ko'rinishni (pan/zoom) shunday sozlaydiki, ish maydonidagi BARCHA kartalar bitta
 * kadrga (hech biri kesilmay) sig'adi — eksportdan oldin chaqiriladi. Muvaffaqiyatli
 * bo'lsa true, joylashtirilgan kontent umuman yo'q bo'lsa false qaytaradi.
 * `extraBottomYs` — computeContentWorldBounds'ga qarang.
 */
function fitViewToContent(padding = 70, extraBottomYs) {
  const bounds = computeContentWorldBounds(extraBottomYs);
  if (!bounds) return false;
  const rect = workspace.getBoundingClientRect();
  const contentW = Math.max(1, bounds.maxX - bounds.minX);
  const contentH = Math.max(1, bounds.maxY - bounds.minY);
  const availW = Math.max(50, rect.width - padding * 2);
  const availH = Math.max(50, rect.height - padding * 2);
  const zoom = clamp(Math.min(availW / contentW, availH / contentH), ZOOM_MIN, 1);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  state.view.zoom = zoom;
  state.view.panX = rect.width / 2 - centerX * zoom;
  state.view.panY = rect.height / 2 - centerY * zoom;
  applyView();
  return true;
}

/** Fayl nomi uchun "kun.oy.yil soat-daqiqa" ko'rinishidagi vaqt yorlig'ini yasaydi. */
function exportTimestampLabel() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

const exportToastEl = document.getElementById("exportToast");
function showExportToast(text) {
  exportToastEl.textContent = text;
  exportToastEl.classList.remove("hidden");
}
function hideExportToast() {
  exportToastEl.classList.add("hidden");
}

/** Ish maydonini (barcha kartalar bilan) rasmga (canvas) tushiradi. */
/**
 * Eksport uchun: hozir joylashtirilgan HAR BIR FAOL (hali tugamagan) loyiha
 * kartasining tagiga, uning xodim-vaqt/xarajat jadvalini TO'LIQ OCHIQ holatda
 * (tableCollapsed holatidan qat'iy nazar) vaqtincha joylashtiradi. Jadvallar
 * dunyo koordinatasida (cardsLayer ichida, loyiha kartasi bilan bir xil
 * pan/zoom qatlamida) joylashadi, shunda ular ham suratga to'liq tushadi va
 * boshqa kartalar bilan ustma-ust tushmaydi (yuqori-o'ng burchakdagi qat'iy
 * panel esa shu payt yashiriladi). Tugagan loyihalarning jadvali qo'shilmaydi —
 * ularning yakuniy hisoboti allaqachon Telegramga yuborilgan bo'ladi.
 * Qaytariladi: [{el, bottom}] — `bottom` shu elementning dunyo koordinatasidagi
 * pastki cheti (fitViewToContent kadrga sig'dirishi uchun kerak).
 */
function createExportProjectTables() {
  const now = Date.now();
  const created = [];
  // Jadval "shtamp" kabi kartaning pastki burchagiga biroz ustma-ust tushib
  // biriktiriladi — shuning uchun kartadan torroq va yuqoriga bir oz siljitilgan.
  const TABLE_W = 260;
  const OVERLAP = 16;

  const rectsOverlap = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

  // Boshqa kartalar (xodimlar va qolgan loyihalar) — jadval ular ustiga tushib
  // qolmasligi uchun to'qnashuv tekshiruvida ishlatiladi.
  const baseObstacles = [];
  state.employees
    .filter((e) => e.placed)
    .forEach((e) => baseObstacles.push({ x1: e.x, y1: e.y, x2: e.x + EMP_W, y2: e.y + EMP_H }));

  state.projects
    .filter((p) => p.placed && !projectProgressInfo(p, now).done)
    .forEach((proj) => {
      const rows = projectLedgerRows(proj, now);
      const rowsHtml = rows.length
        ? rows
            .map(
              (r) => `
          <tr class="${r.connected ? "" : "ptbl-row-disconnected"}">
            <td class="ptbl-td-name">${escapeHtml(r.name)}${r.connected ? "" : ' <span class="ptbl-tag">uzilgan</span>'}</td>
            <td class="ptbl-td-time">${formatDurationHours(r.realHours)}</td>
            <td class="ptbl-td-cost">${formatMoney(r.cost)}</td>
          </tr>`
            )
            .join("")
        : `<tr><td colspan="3" class="ptbl-empty-row">Hali xodim ulanmagan</td></tr>`;

      const cardHeight = getProjectCardHeight(proj);
      const top = proj.y + cardHeight - OVERLAP;

      const el = document.createElement("div");
      el.className = "ptbl ptbl-export";
      el.style.width = TABLE_W + "px";
      el.style.top = top + "px";
      // Avval chap variantda joylashtiramiz — haqiqiy balandligini o'lchash uchun.
      el.style.left = proj.x + "px";
      el.innerHTML = `
        <div class="ptbl-header">
          <span class="ptbl-name">${escapeHtml(proj.name)}</span>
        </div>
        <div class="ptbl-body">
          <div class="ptbl-allocated">Ajratilgan vaqt: ${escapeHtml(formatHours(projectTotalManHours(proj)))}</div>
          <table class="ptbl-table">
            <thead><tr><th>Xodim</th><th>Vaqt</th><th>Summasi</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`;
      cardsLayer.appendChild(el);
      const tableH = el.offsetHeight;

      // Chap-past va o'ng-past burchak variantlaridan qaysi biri boshqa kartalar
      // bilan kamroq to'qnashsa — o'shani tanlaymiz ("bo'sh joyga qarab avtomatik").
      const leftRect = { x1: proj.x, y1: top, x2: proj.x + TABLE_W, y2: top + tableH };
      const rightX = proj.x + PROJ_W - TABLE_W;
      const rightRect = { x1: rightX, y1: top, x2: rightX + TABLE_W, y2: top + tableH };

      const obstacles = baseObstacles.concat(
        state.projects
          .filter((p) => p.placed && p.id !== proj.id)
          .map((p) => ({ x1: p.x, y1: p.y, x2: p.x + PROJ_W, y2: p.y + getProjectCardHeight(p) })),
        created.map((c) => c.rect)
      );

      const leftHits = obstacles.filter((o) => rectsOverlap(leftRect, o)).length;
      const rightHits = obstacles.filter((o) => rectsOverlap(rightRect, o)).length;

      let rect = leftRect;
      if (rightHits < leftHits) {
        rect = rightRect;
        el.style.left = rightX + "px";
        el.classList.add("ptbl-export-right");
      }

      created.push({ el, bottom: rect.y2, rect });
    });
  return created;
}

async function captureWorkspaceCanvas() {
  if (typeof html2canvas !== "function") {
    throw new Error("html2canvas kutubxonasi yuklanmadi (internet aloqasini tekshiring)");
  }
  const prevView = { ...state.view };
  // Joylashtirilgan hech narsa bo'lmasa ham, hozirgi (bo'sh) ko'rinishni o'zi eksport qilinadi.
  // Rasm/qalqib chiquvchi elementlar (kontekst menyu va h.k.) tasodifan tushib qolmasligi uchun yopamiz.
  closeRosterContextMenu();
  if (!exportMenuEl.classList.contains("hidden")) exportMenuEl.classList.add("hidden");

  // Yuqori-o'ng burchakdagi qat'iy jadval panelini vaqtincha yashirib, o'rniga
  // har bir faol loyiha kartasining tagiga to'liq ochiq jadval joylashtiramiz.
  const prevPanelDisplay = projectTablesPanelEl.style.display;
  projectTablesPanelEl.style.display = "none";
  const exportTables = createExportProjectTables();
  const extraBottoms = exportTables.map((t) => t.bottom);

  const hadContent = fitViewToContent(70, extraBottoms);

  // --- Ulanish chiziqlari (SVG qatlami) eksportda ko'rinishi uchun ---
  // html2canvas SVG elementini oddiy DOM kabi emas, ALOHIDA rasm sifatida
  // serializatsiya qilib, uning o'z o'lchamida rasterlaydi. Agar bu o'lcham
  // juda katta bo'lsa (bizdagi 30000x30000 qatlam kabi), brauzerning canvas
  // hajm chegarasidan oshib ketadi va natijada BUTUNLAY BO'SH (shaffof) rasm
  // qaytadi — aynan shu sababli chiziqlar eksportda umuman ko'rinmayotgan edi.
  // Yechim: eksport paytida SVG'ni faqat haqiqiy kontent maydoniga mos
  // (kichik, xavfsiz) o'lchamga keltiramiz. `viewBox` esa ichkaridagi
  // koordinatalar avvalgidek dunyo koordinatasida qolishini ta'minlaydi.
  const svgBounds = computeContentWorldBounds(extraBottoms);
  let svgResized = false;
  if (svgBounds) {
    // Bezier boshqaruv nuqtalari endi computeContentWorldBounds ichida aniq
    // hisoblab chegaraga qo'shilgan — shuning uchun bu yerda faqat chiziq
    // qalinligi/yumaloqlanish xatoligi uchun kichik zaxira yetarli.
    const pad = 40;
    const vbX = Math.floor(svgBounds.minX - pad);
    const vbY = Math.floor(svgBounds.minY - pad);
    const vbW = Math.max(1, Math.ceil(svgBounds.maxX - svgBounds.minX + pad * 2));
    const vbH = Math.max(1, Math.ceil(svgBounds.maxY - svgBounds.minY + pad * 2));
    svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.left = vbX + "px";
    svg.style.top = vbY + "px";
    svg.style.width = vbW + "px";
    svg.style.height = vbH + "px";
    svgResized = true;
  }

  // Layout to'liq barqarorlashishi (kartalar qayta joylashishi) uchun bir necha kadr kutamiz.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const canvas = await html2canvas(workspace, {
    backgroundColor: "#0e1015",
    // Matn aniq (o'qib bo'ladigan darajada) chiqishi uchun har doim yuqori
    // aniqlikda rasterlaymiz — qurilmaning o'z devicePixelRatio'siga bog'liq emas.
    scale: 3,
    useCORS: true,
    logging: false,
  });

  // SVG qatlamini asl holatiga qaytaramiz.
  if (svgResized) {
    svg.removeAttribute("viewBox");
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.left = "";
    svg.style.top = "";
    svg.style.width = "";
    svg.style.height = "";
  }

  exportTables.forEach((t) => t.el.remove());
  projectTablesPanelEl.style.display = prevPanelDisplay;

  if (hadContent) {
    state.view = prevView;
    applyView();
  }
  return canvas;
}

function triggerDownload(dataUrl, filename) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function exportAsJpg() {
  showExportToast("Eksport tayyorlanmoqda...");
  try {
    const canvas = await captureWorkspaceCanvas();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    triggerDownload(dataUrl, `Metal zavod xodimlari_${exportTimestampLabel()}.jpg`);
  } catch (err) {
    console.error(err);
    alert("Eksport qilishda xatolik yuz berdi: " + err.message);
  } finally {
    hideExportToast();
  }
}

async function exportAsPdf() {
  showExportToast("Eksport tayyorlanmoqda...");
  try {
    if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
      throw new Error("jsPDF kutubxonasi yuklanmadi (internet aloqasini tekshiring)");
    }
    const canvas = await captureWorkspaceCanvas();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    const { jsPDF } = window.jspdf;
    const orientation = canvas.width >= canvas.height ? "landscape" : "portrait";
    const pdf = new jsPDF({ orientation, unit: "px", format: [canvas.width, canvas.height] });
    pdf.addImage(dataUrl, "JPEG", 0, 0, canvas.width, canvas.height);
    pdf.save(`Metal zavod xodimlari_${exportTimestampLabel()}.pdf`);
  } catch (err) {
    console.error(err);
    alert("Eksport qilishda xatolik yuz berdi: " + err.message);
  } finally {
    hideExportToast();
  }
}

const btnExportEl = document.getElementById("btnExport");
const exportMenuEl = document.getElementById("exportMenu");

btnExportEl.addEventListener("click", (e) => {
  e.stopPropagation();
  exportMenuEl.classList.toggle("hidden");
});

exportMenuEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-format]");
  if (!btn) return;
  exportMenuEl.classList.add("hidden");
  if (btn.dataset.format === "jpg") exportAsJpg();
  else if (btn.dataset.format === "pdf") exportAsPdf();
});

document.addEventListener("mousedown", (e) => {
  if (!exportMenuEl.classList.contains("hidden") && !e.target.closest(".export-wrap")) {
    exportMenuEl.classList.add("hidden");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(closeModal);
  }
});

/* ------------------------------ Saqlash / tiklash (localStorage + Firebase) ------------------------------ */

let saveTimeout = null;

function saveState() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn("Ma'lumotlarni saqlashda xatolik:", err);
    }
    pushStateToFirebase();
  }, 150);
}

/**
 * Joriy holatni (bulutga) Firebase Realtime Database'ga yuboradi (debounce bilan).
 * Faqat foydalanuvchi tizimga kirgan (auth) holatda ishlaydi.
 */
function pushStateToFirebase() {
  if (!fbAuth.currentUser) return;
  clearTimeout(fbPushTimeout);
  fbPushTimeout = setTimeout(() => {
    const json = JSON.stringify(state);
    fbLastSyncedJSON = json;
    fbDb
      .ref(FB_STATE_PATH)
      .set(JSON.parse(json))
      .catch((err) => console.warn("Bulutga saqlashda xatolik:", err));
  }, 400);
}

/**
 * Holatni tiklaydi. `parsed` berilmasa — brauzerning localStorage'idan o'qiydi
 * (birinchi tezkor ko'rsatish uchun). `parsed` berilsa (masalan Firebase'dan
 * kelgan ma'lumot) — to'g'ridan-to'g'ri o'shani ishlatadi.
 * @param {object|undefined} parsed
 * @returns {boolean} muvaffaqiyatli tiklandimi
 */
function loadState(parsed) {
  if (parsed === undefined) {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      raw = null;
    }
    if (!raw) return false;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return false;
    }
  }
  if (!parsed || typeof parsed !== "object") return false;

  // Eslatma: "placed" maydoni eski (yangilanishdan oldingi) saqlangan ma'lumotlarda
  // yo'q bo'lishi mumkin — bunday hollarda xodim avvalgidek ish maydonida
  // ko'rsatilgan deb hisoblanadi (orqaga moslik uchun).
  state.employees = Array.isArray(parsed.employees)
    ? parsed.employees.map((e) => ({
        ...e,
        x: Number(e.x) || 0,
        y: Number(e.y) || 0,
        placed: e.placed !== undefined ? !!e.placed : true,
        multiBranch: !!e.multiBranch,
      }))
    : [];
  // Eslatma: eski (vaqt kuzatuvi joriy etilishidan oldingi) saqlangan loyihalarda
  // "qty"/"hoursPerUnit" o'rniga faqat yagona "hours" maydoni bo'lgan — uni
  // "1 dona × N soat" ko'rinishiga o'tkazamiz (soni=1). Joylashtirilgan (placed)
  // loyihalarda vaqt kuzatuvi maydonlari yo'q bo'lsa, hisoblagich shu yuklanish
  // daqiqasidan yangidan boshlanadi (avvalgi tarix noma'lum bo'lgani uchun).
  const loadNow = Date.now();
  state.projects = Array.isArray(parsed.projects)
    ? parsed.projects.map((p) => {
        const hasNewFields = p.qty !== undefined && p.hoursPerUnit !== undefined;
        const qty = hasNewFields ? Number(p.qty) || 1 : 1;
        const hoursPerUnit = hasNewFields ? Number(p.hoursPerUnit) || 0 : Number(p.hours) || 0;
        const placed = p.placed !== undefined ? !!p.placed : true;
        const hasTimer = p.startedAt && p.checkpointAt;
        return {
          ...p,
          qty,
          hoursPerUnit,
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          placed,
          startedAt: hasTimer ? p.startedAt : placed ? loadNow : null,
          checkpointAt: hasTimer ? p.checkpointAt : placed ? loadNow : null,
          workedManHours: hasTimer ? Number(p.workedManHours) || 0 : 0,
          workedCost: hasTimer ? Number(p.workedCost) || 0 : 0,
          workedRealHours: hasTimer ? Number(p.workedRealHours) || 0 : 0,
          nightShift: !!p.nightShift,
          // Har bir xodimning shu loyihadagi shaxsiy hissasi (soat + summasi) — timer
          // yangidan boshlanган bo'lsa (hasTimer=false) bo'sh holatdan boshlaymiz,
          // aks holda avvalgi (saqlangan) yozuvlarni tozalab olib qolamiz.
          employeeLedger:
            hasTimer && p.employeeLedger && typeof p.employeeLedger === "object"
              ? Object.fromEntries(
                  Object.entries(p.employeeLedger).map(([eid, v]) => [
                    eid,
                    {
                      realHours: Number(v && v.realHours) || 0,
                      cost: Number(v && v.cost) || 0,
                      name: (v && v.name) || "",
                    },
                  ])
                )
              : {},
          tableCollapsed: !!p.tableCollapsed,
        };
      })
    : [];
  // Eski (nuqtalar soni qo'lda belgilanadigan) formatdagi ulanishlarni yangi
  // formatga ("projSide": "left"/"right") migratsiya qilamiz — shunda oldin
  // yaratilgan ulanishlar yangilanishdan keyin ham saqlanib qoladi.
  state.connections = (Array.isArray(parsed.connections) ? parsed.connections : []).map((c) => {
    if (c.projSide === "left" || c.projSide === "right") {
      return { id: c.id, employeeId: c.employeeId, empSide: c.empSide, projectId: c.projectId, projSide: c.projSide };
    }
    const proj = state.projects.find((p) => p.id === c.projectId);
    const legacyPoints = proj && Number(proj.points) > 0 ? Number(proj.points) : 4;
    const leftCount = Math.ceil(legacyPoints / 2);
    const idx = Number(c.pointIndex) || 0;
    const projSide = idx < leftCount ? "left" : "right";
    return { id: c.id, employeeId: c.employeeId, empSide: c.empSide, projectId: c.projectId, projSide };
  });
  state.view =
    parsed.view && typeof parsed.view === "object"
      ? {
          panX: Number(parsed.view.panX) || 0,
          panY: Number(parsed.view.panY) || 0,
          zoom: clamp(Number(parsed.view.zoom) || 1, ZOOM_MIN, ZOOM_MAX),
        }
      : { panX: 0, panY: 0, zoom: 1 };
  // Sozlamalar (karta o'lchami, chiziq rangi/qalinligi) — eski saqlangan
  // ma'lumotlarda bo'lmasligi mumkin, shuning uchun standart qiymatlar bilan
  // to'ldirib olamiz.
  state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {}) };
  applySizeSettings();
  applyConnStyleSettings();
  return true;
}

/* ------------------------------ Ishga tushirish ------------------------------ */

function renderAll() {
  state.employees.forEach((emp) => {
    renderRosterItem(emp);
    if (emp.placed) renderEmployee(emp);
  });
  state.projects.forEach((proj) => {
    renderProjectRosterItem(proj);
    if (proj.placed) renderProject(proj);
  });
  state.connections.forEach(renderConnection);
  updateEmptyHint();
  updateSidebarEmptyState();
  updateProjectSidebarEmptyState();
  applyView();
  renderProjectEmployeeTables();
}

/**
 * Oldin chizilgan barcha kartalar/chiziqlar/ro'yxat qatorlarini tozalab,
 * `state`dagi joriy ma'lumotlar asosida hammasini qaytadan chizadi.
 * Bulutdan (boshqa qurilmadan) yangi ma'lumot kelganda ishlatiladi.
 */
function resetRenderState() {
  cardsLayer.innerHTML = "";
  svg.innerHTML = "";
  employeeEls.clear();
  projectEls.clear();
  connectionEls.clear();
  sidebarList.querySelectorAll(".roster-item").forEach((el) => el.remove());
  projectSidebarList.querySelectorAll(".roster-item").forEach((el) => el.remove());
  rosterEls.clear();
  projRosterEls.clear();
  renderAll();
}

function init() {
  loadState();
  renderAll();
  updateAllProjectTimeInfo();
  if (!fbTickStarted) {
    fbTickStarted = true;
    setInterval(updateAllProjectTimeInfo, WORK_TICK_MS);
  }
}

/* ------------------------------ Qilingan ishlar (haftalik tugatilgan loyihalar) ------------------------------ */

/**
 * Firebase'ning "completedWorks" tuguni — har bir loyiha tabiiy yoki qo'lda
 * ("Tugatish" tugmasi bilan) tugaganda check-completed-projects.js (15 daqiqada
 * bir ishga tushadigan server skripti) tomonidan shu yerga yozuv qo'shiladi.
 * Har shanba kuni soat 19:00'da send-weekly-report.js shu ro'yxatni botga
 * hisobot qilib yuboradi va BUTUNLAY tozalaydi — shuning uchun bu yerda doim
 * faqat "joriy hafta"ga tegishli yozuvlar bo'ladi.
 */
const btnCompletedWorksEl = document.getElementById("btnCompletedWorks");
const completedWorksModalEl = document.getElementById("completedWorksModal");
const completedWorksListEl = document.getElementById("completedWorksList");
const completedWorksCountEl = document.getElementById("completedWorksCount");

function renderCompletedWorks(items) {
  completedWorksCountEl.textContent = String(items.length);
  completedWorksCountEl.classList.toggle("hidden", items.length === 0);

  if (items.length === 0) {
    completedWorksListEl.innerHTML = `<div class="sidebar-empty">Bu hafta hali tugagan loyiha yo'q.</div>`;
    return;
  }

  const sorted = items.slice().sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  completedWorksListEl.innerHTML = sorted
    .map((it) => {
      const rows = Array.isArray(it.rows) ? it.rows : [];
      const rowsHtml = rows.length
        ? rows
            .map(
              (r) => `
          <tr class="${r.connected ? "" : "ptbl-row-disconnected"}">
            <td class="ptbl-td-name">${escapeHtml(r.name || "")}${r.connected ? "" : ' <span class="ptbl-tag">uzilgan</span>'}</td>
            <td class="ptbl-td-time">${escapeHtml(r.hoursText || "")}</td>
            <td class="ptbl-td-cost">${escapeHtml(r.costText || "")}</td>
          </tr>`
            )
            .join("")
        : `<tr><td colspan="3" class="ptbl-empty-row">Xodim ulanmagan edi</td></tr>`;
      const when = it.finishedAt ? formatDateTime(it.finishedAt) : "";
      const started = it.startedAt ? formatDateTime(it.startedAt) : "-";
      // Eski (bu tuzatishdan oldingi) yozuvlarda "realHoursText" bo'lmasligi mumkin —
      // shunday holda "-" ko'rsatiladi.
      const realHoursText = it.realHoursText || "-";
      return `
        <div class="ptbl completed-work-card">
          <div class="ptbl-header">
            <span class="ptbl-name">${escapeHtml(it.name || "")}</span>
            <span class="completed-work-date">${escapeHtml(when)}</span>
          </div>
          <div class="ptbl-body">
            <div class="ptbl-allocated">
              Boshlandi: ${escapeHtml(started)}<br>
              Ajratilgan vaqt: ${escapeHtml(it.allocatedText || "-")} · Real ish vaqti: ${escapeHtml(realHoursText)}<br>
              Jami xarajat: ${escapeHtml(it.totalCostText || "-")}
            </div>
            <table class="ptbl-table">
              <thead><tr><th>Xodim</th><th>Vaqt</th><th>Summasi</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>`;
    })
    .join("");
}

/** Firebase'dagi "completedWorks" tuguniga jonli (real-time) tinglovchi ulaydi. */
let completedWorksListenerAttached = false;
function startCompletedWorksSync() {
  if (completedWorksListenerAttached) return;
  completedWorksListenerAttached = true;
  fbDb.ref("completedWorks").on("value", (snap) => {
    const val = snap.val() || {};
    renderCompletedWorks(Object.values(val));
  });
}

btnCompletedWorksEl.addEventListener("click", () => {
  openModal(completedWorksModalEl);
});

/* ------------------------------ Kirish (Firebase Auth) ------------------------------ */

const authOverlayEl = document.getElementById("authOverlay");
const authFormEl = document.getElementById("authForm");
const authErrorEl = document.getElementById("authError");
const authSubmitEl = document.getElementById("authSubmit");
const btnLogoutEl = document.getElementById("btnLogout");

function showAuthError(text) {
  authErrorEl.textContent = text;
  authErrorEl.classList.remove("hidden");
}

function hideAuthError() {
  authErrorEl.classList.add("hidden");
}

const AUTH_ERROR_MESSAGES = {
  "auth/invalid-email": "Email manzili noto'g'ri.",
  "auth/user-disabled": "Bu hisob bloklangan.",
  "auth/user-not-found": "Bunday hisob topilmadi.",
  "auth/wrong-password": "Parol noto'g'ri.",
  "auth/invalid-credential": "Email yoki parol noto'g'ri.",
  "auth/too-many-requests": "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring.",
  "auth/network-request-failed": "Internet aloqasi yo'q yoki uzilgan.",
};

authFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  hideAuthError();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  authSubmitEl.disabled = true;
  authSubmitEl.textContent = "Kirilmoqda...";
  fbAuth
    .signInWithEmailAndPassword(email, password)
    .catch((err) => {
      showAuthError(AUTH_ERROR_MESSAGES[err.code] || "Kirishda xatolik yuz berdi: " + err.message);
    })
    .finally(() => {
      authSubmitEl.disabled = false;
      authSubmitEl.textContent = "Kirish";
    });
});

btnLogoutEl.addEventListener("click", () => {
  fbAuth.signOut();
});

/**
 * Firebase'dagi ma'lumotlarni birinchi marta o'qiydi, kerak bo'lsa localStorage'dagi
 * mavjud ma'lumotni bulutga ko'chiradi, so'ng real-vaqt tinglovchisini yoqadi —
 * shu tinglovchi tufayli boshqa qurilmada qilingan o'zgarishlar shu qurilmada ham
 * avtomatik ko'rinadi.
 */
function startFirebaseSync() {
  if (fbListenerAttached) return;
  fbListenerAttached = true;
  const stateRef = fbDb.ref(FB_STATE_PATH);
  stateRef
    .once("value")
    .then((snap) => {
      const remote = snap.val();
      if (remote) {
        loadState(remote);
        fbLastSyncedJSON = JSON.stringify(remote);
      } else {
        // Bulutda hali hech narsa yo'q. localStorage'dan o'qiymiz, lekin FAQAT
        // unda haqiqatan ham xodim yoki loyiha bo'lsa, bulutga yuboramiz —
        // aks holda (masalan tarmoq nosozligi tufayli "remote" noto'g'ri bo'sh
        // ko'ringan holatda) bo'sh holatni bulutga yozib, mavjud ma'lumotni
        // o'chirib yuborish xavfining oldini olamiz.
        const hadLocal = loadState();
        if (hadLocal && (state.employees.length > 0 || state.projects.length > 0)) {
          pushStateToFirebase();
        }
      }
      init();

      stateRef.on("value", (snap2) => {
        const val = snap2.val();
        const json = JSON.stringify(val);
        if (json === fbLastSyncedJSON) return; // bu bizning o'z yozuvimizning aks-sadosi
        fbLastSyncedJSON = json;
        if (!val) return;
        loadState(val);
        resetRenderState();
      });
    })
    .catch((err) => {
      console.error("Firebase'dan o'qishda xatolik:", err);
      showAuthError("Ma'lumotlarni yuklashda xatolik: " + err.message);
    });
}

fbAuth.onAuthStateChanged((user) => {
  if (user) {
    authOverlayEl.classList.add("hidden");
    startFirebaseSync();
    startCompletedWorksSync();
  } else {
    authOverlayEl.classList.remove("hidden");
  }
});
