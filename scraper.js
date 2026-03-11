const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(process.cwd(), "competicoes.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalize(str) {
  return (str || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .trim();
}

function containsAny(text, keywords) {
  if (!keywords || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(String(k).toLowerCase()));
}

function shouldKeepCompetition(comp, config) {
  const id = Number(comp.competitionId);
  const name = comp.nome || "";

  if (config.includeCompetitionIds && config.includeCompetitionIds.length > 0) {
    if (!config.includeCompetitionIds.map(Number).includes(id)) return false;
  }

  if (config.excludeCompetitionIds && config.excludeCompetitionIds.length > 0) {
    if (config.excludeCompetitionIds.map(Number).includes(id)) return false;
  }

  if (config.includeKeywords && config.includeKeywords.length > 0) {
    if (!containsAny(name, config.includeKeywords)) return false;
  }

  if (config.excludeKeywords && config.excludeKeywords.length > 0) {
    if (containsAny(name, config.excludeKeywords)) return false;
  }

  return true;
}

async function closeCookiesIfVisible(page) {
  const selectors = [
    'button:has-text("Aceitar")',
    'button:has-text("Aceito")',
    'button:has-text("OK")',
    'button:has-text("Fechar")',
    'button:has-text("Accept")'
  ];

  for (const selector of selectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.count()) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {}
  }

  return false;
}

async function clickClassificacaoTab(page) {
  const locators = [
    page.getByText("Classificação", { exact: true }),
    page.locator('a:has-text("Classificação")').first(),
    page.locator('button:has-text("Classificação")').first(),
    page.locator('[role="tab"]:has-text("Classificação")').first()
  ];

  for (const locator of locators) {
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 5000 });
        await page.waitForTimeout(4000);
        return true;
      }
    } catch {}
  }

  return false;
}

function parseStandingsFromText(text) {
  const normalized = normalize(text);

  const regex = /(?:^|\n)(\d+)\t([^\t\n]+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)(?=\n|$)/g;

  const table = [];
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    table.push({
      posicao: Number(match[1]),
      equipa: match[2].trim(),
      jogos: Number(match[3]),
      vitorias: Number(match[4]),
      empates: Number(match[5]),
      derrotas: Number(match[6]),
      gm: Number(match[7]),
      gs: Number(match[8]),
      pontos: Number(match[9])
    });
  }

  return table;
}

async function getCompetitionLinks(page, associationId, seasonId) {
  const url = `https://resultados.fpf.pt/Competition/GetCompetitionsByAssociation?associationId=${associationId}&seasonId=${seasonId}`;

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(4000);

  const rawLinks = await page.locator('a[href*="Competition/Details?competitionId="]').evaluateAll(anchors => {
    return anchors.map(a => ({
      href: a.href || "",
      text: (a.textContent || "").trim()
    }));
  });

  const unique = new Map();

  for (const item of rawLinks) {
    try {
      const u = new URL(item.href);
      const competitionId = u.searchParams.get("competitionId");
      const seasonIdFromUrl = u.searchParams.get("seasonId");

      if (!competitionId) continue;

      const key = `${competitionId}-${seasonIdFromUrl || ""}`;

      if (!unique.has(key)) {
        unique.set(key, {
          competitionId: Number(competitionId),
          seasonId: seasonIdFromUrl ? Number(seasonIdFromUrl) : Number(seasonId),
          nome: item.text || `Competição ${competitionId}`,
          url: item.href
        });
      }
    } catch {}
  }

  return Array.from(unique.values());
}

async function scrapeCompetition(page, comp) {
  const detailsUrl = `https://resultados.fpf.pt/Competition/Details?competitionId=${comp.competitionId}&seasonId=${comp.seasonId}`;

  await page.goto(detailsUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(5000);

  await closeCookiesIfVisible(page);
  const clickedClassificacao = await clickClassificacaoTab(page);

  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const tabela = parseStandingsFromText(bodyText);

  return {
    competitionId: comp.competitionId,
    seasonId: comp.seasonId,
    competicao: comp.nome,
    sourceUrl: detailsUrl,
    clickedClassificacao,
    totalEquipas: tabela.length,
    tabela
  };
}

async function run() {
  const config = readJson(CONFIG_PATH);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "pt-PT",
    viewport: { width: 1366, height: 900 }
  });

  const page = await context.newPage();

  try {
    console.log("A ler lista de competições...");
    let competitions = await getCompetitionLinks(page, config.associationId, config.seasonId);

    competitions = competitions.filter(comp => shouldKeepCompetition(comp, config));

    if (config.maxCompetitions) {
      competitions = competitions.slice(0, config.maxCompetitions);
    }

    console.log(`Competições encontradas após filtro: ${competitions.length}`);

    const results = [];

    for (let i = 0; i < competitions.length; i++) {
      const comp = competitions[i];
      console.log(`[${i + 1}/${competitions.length}] ${comp.nome} (${comp.competitionId})`);

      try {
        const result = await scrapeCompetition(page, comp);
        results.push(result);
      } catch (error) {
        results.push({
          competitionId: comp.competitionId,
          seasonId: comp.seasonId,
          competicao: comp.nome,
          sourceUrl: comp.url,
          error: error.message,
          totalEquipas: 0,
          tabela: []
        });
      }

      await sleep(1500);
    }

    const output = {
      fetchedAt: new Date().toISOString(),
      associationId: config.associationId,
      seasonId: config.seasonId,
      totalCompeticoes: results.length,
      competicoes: results
    };

    writeJson(path.join(process.cwd(), config.outputFile), output);

    console.log(`Ficheiro criado: ${config.outputFile}`);
    console.log("Concluído com sucesso.");
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error("Erro no scraper:", error);
  process.exit(1);
});
