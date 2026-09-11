// Har kuni soat 18:00 (Toshkent) da ishga tushadi (GitHub Actions cron orqali):
// ilova sahifasini ochadi, barcha joylashtirilgan kartalar ko'rinadigan qilib
// (fitViewToContent) rasmga oladi va Telegramga yuboradi. Rasmdan keyin, har bir
// joylashtirilgan loyiha uchun alohida "blok" qilib — loyiha nomi va unga ulangan
// (yoki avval ulanib, hozir uzilgan) xodimlarning ism, ishlagan vaqti va narxini
// MATN ko'rinishida ham yuboradi (jadval o'qish qulay bo'lishi uchun).

const fs = require("fs");
const path = require("path");
const { openLoggedInPage, sendTelegramPhoto, sendTelegramDocument, sendTelegramMessage } = require("./common");

/**
 * Telegram xabarlari 4096 belgidan oshmasligi kerak. Loyiha bloklarini (har biri
 * bitta butun bo'lak sifatida, o'rtasida bo'lib yubormasdan) shu chegaraga
 * moslab bir nechta xabarga bo'lib chiqadi.
 */
function chunkBlocks(blocks, maxLen) {
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? current + "\n\n" + block : block;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

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

    // Rasmning pastida — har bir joylashtirilgan loyiha uchun alohida blok:
    // loyiha nomi (+ jami xarajat), so'ng unga ulangan/avval ulangan xodimlarning
    // ism, ishlagan vaqt va narxi (xuddi "Qilingan ishlar" jadvalidagi kabi).
    const projectBlocks = await page.evaluate(() => {
      const now = Date.now();
      return state.projects
        .filter((p) => p.placed)
        .map((p) => {
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
          return `📌 ${p.name} (jami: ${formatMoney(info.workedCost)})\n${rowsText}`;
        });
    });

    if (projectBlocks.length > 0) {
      const chunks = chunkBlocks(projectBlocks, 3500);
      for (let i = 0; i < chunks.length; i++) {
        const header = chunks.length > 1 ? `📊 Loyihalar va xodimlar (${i + 1}/${chunks.length}):\n\n` : `📊 Loyihalar va xodimlar:\n\n`;
        await sendTelegramMessage(header + chunks[i]);
      }
      console.log("Loyiha-xodim jadvali (matn) muvaffaqiyatli yuborildi.");
    } else {
      console.log("Hozircha ish maydonida joylashtirilgan loyiha yo'q — matnli jadval yuborilmadi.");
    }

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
