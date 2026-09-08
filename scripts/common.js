// Ikkala avtomatlashtirish skripti (kunlik hisobot va loyiha tugashi xabarnomasi)
// uchun umumiy funksiyalar: ilova sahifasiga kirish (login) va Telegram'ga yuborish.

const { chromium } = require("playwright");

const PAGE_URL = process.env.PAGE_URL;
const APP_EMAIL = process.env.APP_EMAIL;
const APP_PASSWORD = process.env.APP_PASSWORD;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function assertEnv() {
  const missing = [];
  if (!PAGE_URL) missing.push("PAGE_URL");
  if (!APP_EMAIL) missing.push("APP_EMAIL");
  if (!APP_PASSWORD) missing.push("APP_PASSWORD");
  if (!BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
  if (missing.length) {
    throw new Error("Quyidagi maxfiy sozlamalar (secrets) topilmadi: " + missing.join(", "));
  }
}

async function openLoggedInPage() {
  assertEnv();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });

  await page.fill("#authEmail", APP_EMAIL);
  await page.fill("#authPassword", APP_PASSWORD);
  await page.click("#authSubmit");

  await page.waitForSelector("#authOverlay.hidden", { timeout: 30000 });
  await page.waitForTimeout(3000);

  return { browser, page };
}

async function sendTelegramMessage(text) {
  assertEnv();
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error("Telegram xabar yuborishda xatolik: " + JSON.stringify(data));
  }
}

async function sendTelegramPhoto(filePath, caption) {
  assertEnv();
  const fs = require("fs");
  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  if (caption) form.append("caption", caption);
  form.append("photo", new Blob([fs.readFileSync(filePath)]), "report.jpg");

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error("Telegram rasm yuborishda xatolik: " + JSON.stringify(data));
  }
}

module.exports = { openLoggedInPage, sendTelegramMessage, sendTelegramPhoto, PAGE_URL };
