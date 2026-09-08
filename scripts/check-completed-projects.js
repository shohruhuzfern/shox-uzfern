// Har 15 daqiqada ishga tushadi (GitHub Actions cron orqali): ilovani ochib,
// har bir joylashtirilgan loyihaning holatini (tugadimi-yo'qmi) ilovaning
// o'z hisoblash mantig'i orqali tekshiradi. Yangi tugagan loyiha topilsa —
// Telegramga xabar yuboradi va Firebase'da "notifiedProjects" ostida belgilaydi
// (shu tufayli bir xil loyiha uchun xabar faqat 1 marta yuboriladi).

const { openLoggedInPage, sendTelegramMessage } = require("./common");

(async () => {
  const { browser, page } = await openLoggedInPage();
  try {
    const result = await page.evaluate(async () => {
      const placedProjects = state.projects.filter((p) => p.placed);
      const now = Date.now();
      const statuses = placedProjects.map((p) => ({
        id: p.id,
        name: p.name,
        done: projectProgressInfo(p, now).done,
      }));

      const notifiedSnap = await fbDb.ref("notifiedProjects").once("value");
      const notified = notifiedSnap.val() || {};

      const newlyDone = [];
      for (const s of statuses) {
        if (s.done && !notified[s.id]) {
          newlyDone.push(s);
          await fbDb.ref("notifiedProjects/" + s.id).set(true);
        } else if (!s.done && notified[s.id]) {
          await fbDb.ref("notifiedProjects/" + s.id).remove();
        }
      }
      return { newlyDone };
    });

    for (const proj of result.newlyDone) {
      await sendTelegramMessage(`✅ Loyiha tugadi: "${proj.name}"`);
      console.log(`Xabar yuborildi: ${proj.name}`);
    }
    if (result.newlyDone.length === 0) {
      console.log("Yangi tugagan loyiha yo'q.");
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("Xatolik:", err);
  process.exit(1);
});
