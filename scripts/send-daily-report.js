// Har kuni soat 18:00 (Toshkent) da ishga tushadi (GitHub Actions cron orqali):
// ilova sahifasini ochadi, barcha joylashtirilgan kartalar ko'rinadigan qilib
// (fitViewToContent) rasmga oladi va Telegramga yuboradi.

const path = require("path");
const { openLoggedInPage, sendTelegramPhoto } = require("./common");

(async () => {
  const { browser, page } = await openLoggedInPage();
  try {
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
    const caption = `Kunlik hisobot — ${dd}.${mm}.${now.getFullYear()}`;

    await sendTelegramPhoto(outPath, caption);
    console.log("Kunlik hisobot muvaffaqiyatli yuborildi.");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("Xatolik:", err);
  process.exit(1);
});
