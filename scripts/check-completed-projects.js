// Har 15 daqiqada ishga tushadi (GitHub Actions cron orqali): ilovani ochib,
// har bir joylashtirilgan loyihaning holatini (tugadimi-yo'qmi — tabiiy
// ravishda vaqti tugab yoki "Tugatish" tugmasi bilan qo'lda) ilovaning o'z
// hisoblash mantig'i orqali tekshiradi. Yangi tugagan loyiha topilsa:
//   1) uning yakuniy xodim-vaqt/xarajat jadvali bilan birga Telegramga xabar
//      yuboradi va Firebase'da "notifiedProjects" ostida belgilaydi (shu
//      tufayli bir xil loyiha uchun xabar faqat 1 marta yuboriladi);
//   2) ilovadagi "Qilingan ishlar" panelida ko'rinishi uchun Firebase'ning
//      "completedWorks" ostiga yozuv qo'shadi va "completedWorksLogged" ostida
//      belgilaydi — agar bu loyiha "Tugatish" tugmasi orqali ilovaning o'zi
//      tomonidan ALLAQACHON yozilgan bo'lsa (darhol, shu skript ishga
//      tushishini kutmasdan), bu yerda qayta (dublikat) yozilmaydi. Loyiha
//      tugallanmagan holatga qaytsa (masalan qayta ish maydoniga tashlansa),
//      ikkala belgi ham tozalanib, keyingi safar tugaganda yana ishlaydi.
// "completedWorks" ro'yxati har shanba kuni send-weekly-report.js tomonidan
// botga yuborilib, keyin butunlay tozalanadi.

const { openLoggedInPage, sendTelegramMessage } = require("./common");

function formatDateTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

(async () => {
  const { browser, page } = await openLoggedInPage();
  try {
    const result = await page.evaluate(async () => {
      const placedProjects = state.projects.filter((p) => p.placed);
      const now = Date.now();
      const statuses = placedProjects.map((p) => {
        const info = projectProgressInfo(p, now);
        const rows = projectLedgerRows(p, now);
        const rowsText = rows.length
          ? rows
              .map(
                (r) =>
                  `• ${r.name}${r.connected ? "" : " (uzilgan)"}: ${formatDurationHours(r.realHours)} — ${formatMoney(r.cost)}`
              )
              .join("\n")
          : "(xodim ulanmagan)";
        const rowsData = rows.map((r) => ({
          name: r.name,
          connected: !!r.connected,
          hoursText: formatDurationHours(r.realHours),
          costText: formatMoney(r.cost),
        }));
        return {
          id: p.id,
          name: p.name,
          done: info.done,
          startedAt: p.startedAt || null,
          allocatedText: formatHours(projectTotalManHours(p)),
          realHoursText: formatDurationHours(info.realHours),
          totalCostText: formatMoney(info.workedCost),
          rowsText,
          rowsData,
        };
      });

      const notifiedSnap = await fbDb.ref("notifiedProjects").once("value");
      const notified = notifiedSnap.val() || {};
      const loggedSnap = await fbDb.ref("completedWorksLogged").once("value");
      const logged = loggedSnap.val() || {};

      const newlyDone = [];
      for (const s of statuses) {
        if (s.done && !notified[s.id]) {
          newlyDone.push(s);
          await fbDb.ref("notifiedProjects/" + s.id).set(true);
        }
        if (s.done && !logged[s.id]) {
          // "Qilingan ishlar" paneli uchun yozuv — agar "Tugatish" tugmasi orqali
          // ilova o'zi allaqachon yozgan bo'lsa (completedWorksLogged), qayta
          // yozilmaydi.
          await fbDb.ref("completedWorksLogged/" + s.id).set(true);
          await fbDb.ref("completedWorks").push({
            id: s.id,
            name: s.name,
            startedAt: s.startedAt,
            finishedAt: now,
            allocatedText: s.allocatedText,
            realHoursText: s.realHoursText,
            totalCostText: s.totalCostText,
            rows: s.rowsData,
          });
        }
        if (!s.done && notified[s.id]) {
          // Loyiha qayta ochilgan/tahrirlangan bo'lsa — belgini olib tashlaymiz,
          // shunda keyingi safar chindan tugaganda xabar yana yuboriladi.
          await fbDb.ref("notifiedProjects/" + s.id).remove();
        }
        if (!s.done && logged[s.id]) {
          await fbDb.ref("completedWorksLogged/" + s.id).remove();
        }
      }
      return { newlyDone };
    });

    for (const proj of result.newlyDone) {
      const text = `✅ Loyiha tugadi: "${proj.name}"\nBoshlandi: ${formatDateTime(proj.startedAt)}\nAjratilgan vaqt: ${proj.allocatedText}\nReal ish vaqti: ${proj.realHoursText}\nJami xarajat: ${proj.totalCostText}\n\nXodimlar hissasi:\n${proj.rowsText}`;
      await sendTelegramMessage(text);
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
