// Har shanba kuni soat 19:00 (Toshkent vaqti) ishga tushadi (GitHub Actions
// cron orqali): Firebase'dagi "completedWorks" ro'yxatini (shu hafta ichida
// tugagan barcha loyihalarni) o'qib, ularni bitta umumiy hisobot sifatida
// Telegram botga yuboradi, so'ng "completedWorks" ro'yxatini BUTUNLAY
// TOZALAYDI — shunda ilovadagi "Qilingan ishlar" paneli ham bo'shab, keyingi
// hafta uchun yangidan to'la boshlaydi.

const { openLoggedInPage, sendTelegramMessage } = require("./common");

function formatDateShort(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

(async () => {
  const { browser, page } = await openLoggedInPage();
  try {
    const items = await page.evaluate(async () => {
      const snap = await fbDb.ref("completedWorks").once("value");
      const val = snap.val() || {};
      return Object.values(val);
    });

    if (items.length === 0) {
      await sendTelegramMessage("📅 Haftalik hisobot: bu hafta tugagan loyihalar yo'q.");
      console.log("Bu hafta tugagan loyiha yo'q — bo'sh hisobot yuborildi.");
    } else {
      items.sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
      const lines = items.map((it, i) => {
        const when = it.finishedAt ? formatDateShort(it.finishedAt) : "?";
        return `${i + 1}) "${it.name}" — ${when}\n   Ajratilgan vaqt: ${it.allocatedText || "-"}, Jami xarajat: ${it.totalCostText || "-"}`;
      });
      const text = `📅 Haftalik hisobot — shu hafta ${items.length} ta loyiha tugadi:\n\n${lines.join("\n\n")}`;
      await sendTelegramMessage(text);
      console.log(`Haftalik hisobot yuborildi (${items.length} ta loyiha).`);
    }

    // Hisobot yuborilgach ro'yxatni butunlay tozalaymiz.
    await page.evaluate(async () => {
      await fbDb.ref("completedWorks").remove();
    });
    console.log("completedWorks tozalandi.");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("Xatolik:", err);
  process.exit(1);
});
