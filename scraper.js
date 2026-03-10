const { chromium } = require("playwright");
const fs = require("fs");

async function run() {

  const competitionId = 27985;
  const seasonId = 105;

  const url = `https://resultados.fpf.pt/Competition/Details?competitionId=${competitionId}&seasonId=${seasonId}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded" });

  await page.waitForTimeout(5000);

  const tab = page.getByText("Classificação");
  if (await tab.count()) {
    await tab.click();
  }

  await page.waitForTimeout(4000);

  const text = await page.evaluate(() => document.body.innerText);

  const regex = /(\d+)\t([^\t]+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)/g;

  const table = [];

  let match;

  while ((match = regex.exec(text)) !== null) {
    table.push({
      posicao: Number(match[1]),
      equipa: match[2],
      jogos: Number(match[3]),
      vitorias: Number(match[4]),
      empates: Number(match[5]),
      derrotas: Number(match[6]),
      gm: Number(match[7]),
      gs: Number(match[8]),
      pontos: Number(match[9])
    });
  }

  fs.writeFileSync("classificacao.json", JSON.stringify(table, null, 2));

  await browser.close();

  console.log("Classificação atualizada");

}

run();
