// Har kuni soat 18:00 (Toshkent) da ishga tushadi (GitHub Actions cron orqali):
// ilova sahifasini ochadi, barcha joylashtirilgan kartalar ko'rinadigan qilib
// (fitViewToContent) rasmga oladi va Telegramga yuboradi.

const fs = require("fs");
const path = require("path");
const { openLoggedInPage, sendTelegramPhoto, sendTelegramDocument } = require("./common");

(async () => {
  const { browser, page } = await openLoggedInPage();
  try {
    // Barcha joylashtirilgan kartalar ko'rinadigan bo'lishi uchun ko'rinishni moslaymiz
    await page.evaluate(() => {
      if (typeof fitViewToContent === "function") fitViewToContent();
    });
    await page.waitForTimeout(500);

    const outPath = path.join(__dirname, "daily-report.jpg");
    const workspace = await page.$("#workspace");
    await workspace.screenshot({ path: outPath, type: "jpeg", quality: 92 });

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dateLabel = `${dd}.${mm}.${now.getFullYear()}`;

    await sendTelegramPhoto(outPath, `Kunlik hisobot — ${dateLabel}`);
    console.log("Kunlik hisobot (rasm) muvaffaqiyatli yuborildi.");

    // Zaxira nusxa: joriy barcha ma'lumotlarni (xodimlar, loyihalar, ulanishlar) sahifadan
    // o'qib, alohida .json fayl sifatida ham yuboramiz — Firebase biror sabab bilan
    // ishlamay qolsa ham, oxirgi holatni qo'lda tiklash uchun bu fayl qo'lda saqlanib qoladi.
    const backupState = await page.evaluate(() => (typeof state !== "undefined" ? state : null));
    if (backupState) {
      const backupPath = path.join(__dirname, "backup.json");
      fs.writeFileSync(backupPath, JSON.stringify(backupState, null, 2), "utf8");
      await sendTelegramDocument(backupPath, `zaxira_${dateLabel}.json`, `Ma'lumotlar zaxira nusxasi — ${dateLabel}`);
      console.log("Ma'lumotlar zaxira nusxasi muvaffaqiyatli yuborildi.");
    } else {
      console.warn("Ogohlantirish: sahifadan 'state' o'qib bo'lmadi, zaxira nusxa yuborilmadi.");
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("Xatolik:", err);
  process.exit(1);
});
