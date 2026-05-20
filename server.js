const express = require('express');
const helmet = require("helmet")
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors({ origin: "*", allowedHeaders: "*" }));
app.use(express.json())
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            "default-src": ["'self'"],
            "img-src": ["'self'", "data:"],
        },
    })
);

// Passamos a usar o 'context' que contém a identidade falsa do navegador
async function buscarMercadoLivre(produto, context) {
    const termo = produto.replace(/ /g, '-');
    const url = `https://lista.mercadolivre.com.br/${termo}`;

    const page = await context.newPage();
    let resultados = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Espera um segundinho para dar tempo dos scripts da página carregarem
        await page.waitForTimeout(1000);
        // em vez de waitForTimeout

        const cards = await page.locator('.ui-search-layout__item').all();

        for (let card of cards) {
            if (resultados.length >= 5) break;

            const priceEl = card.locator('.andes-money-amount__fraction').first();
            const linkEl = card.locator('a').first();

            if (await priceEl.count() > 0 && await linkEl.count() > 0) {
                let textoPreco = await priceEl.innerText();
                let href = await linkEl.getAttribute('href');

                let limpo = textoPreco.replace(/\./g, '').trim();
                let valor = parseFloat(limpo);

                if (!isNaN(valor)) resultados.push({ preco: valor, url: href });
            }
        }
    } catch (e) {
        console.error("[Erro ML]:", e.message);
    } finally {
        await page.close();
    }

    console.log(`[OK] Mercado Livre finalizou. (${resultados.length} itens)`);
    return resultados;
}

async function buscarAmazon(produto, context) {
    const termo = produto.replace(/ /g, '+');
    const url = `https://www.amazon.com.br/s?k=${termo}`;

    const page = await context.newPage();
    let resultados = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Pausa um pouco maior para garantir a renderização de elementos dinâmicos
        await page.waitForTimeout(1400);
        // em vez de waitForTimeout
        // await page.waitForSelector('.ui-search-layout__item', { timeout: 10000 });

        const isCaptcha = await page.locator('form[action="/errors/validateCaptcha"]').count();
        if (isCaptcha > 0) {
            console.log("    [ALERTA] Amazon pediu CAPTCHA! Resolva no navegador (15s).");
            await page.waitForTimeout(15000);
        }

        // Pega todos os blocos que a Amazon considera "produto"
        const cards = await page.locator('div[data-asin]:not([data-asin=""])').all();

        // LOG DE DEBUG: Isso vai nos dizer se o problema é achar o card ou ler o preço dentro dele
        console.log(`    [DEBUG] Amazon carregou ${cards.length} blocos de produtos na página.`);

        for (let card of cards) {
            if (resultados.length >= 5) break;

            // Seletores com múltiplas opções (se um falhar, tenta o outro)
            // Na Amazon, às vezes o preço patrocinado muda de classe
            const priceEl = card.locator('.a-price .a-offscreen, .a-color-price').first();
            const linkEl = card.locator('h2 a, .a-link-normal.s-no-outline').first();

            if (await priceEl.count() > 0 && await linkEl.count() > 0) {
                let textoPreco = await priceEl.innerText();
                let href = await linkEl.getAttribute('href');

                if (!href) continue;

                let limpo = textoPreco.replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
                let valor = parseFloat(limpo);
                let urlCompleta = href.startsWith('http') ? href : `https://www.amazon.com.br${href}`;

                if (!isNaN(valor)) {
                    resultados.push({ preco: valor, url: urlCompleta });
                }
            }
        }

        // Se encontrou blocos, mas nenhum preço/link foi validado, a estrutura mudou radicalmente
        if (cards.length > 0 && resultados.length === 0) {
            console.log("    [ALERTA DEBUG] Os produtos estão na tela, mas as tags de preço ou link não deram 'match'.");
        }

    } catch (e) {
        console.error("[Erro Amazon]:", e.message);
    } finally {
        await page.close();
    }

    console.log(`[OK] Amazon finalizou. (${resultados.length} itens extraídos)`);
    return resultados;
}

let browser;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
            headless: true,
            args: ['--disable-blink-features=AutomationControlled']
        });
    }
    return browser;
}

app.get('/api/v1/compare', async (req, res) => {
    const { produto } = req.query;
    console.log(`\n======================================`);
    console.log(`[LOG] Iniciando busca por: "${produto}"`);
    console.log(`======================================`);

    // 1. INICIA O NAVEGADOR VISÍVEL E COM PROTEÇÕES DESLIGADAS
    const browser = await getBrowser()

    // 2. CRIA UMA IDENTIDADE FALSA DE UM USUÁRIO REAL DO WINDOWS 10
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 }
    });

    await context.route('**/*', (route) => {
        const blocked = ['image', 'stylesheet', 'font', 'media'];
        if (blocked.includes(route.request().resourceType())) {
            route.abort();
        } else {
            route.continue();
        }
    });

    const [ml, amz] = await Promise.all([
        buscarMercadoLivre(produto, context),
        buscarAmazon(produto, context)
    ]);

    await context.close();
    console.log(`[LOG] Navegador fechado. Calculando médias...`);

    const todosPrecos = [...ml, ...amz];
    const media = (arr) => arr.length ? arr.reduce((a, b) => a + b.preco, 0) / arr.length : 0;

    let menor = null;
    let maior = null;
    if (todosPrecos.length > 0) {
        menor = todosPrecos.reduce((min, p) => p.preco < min.preco ? p : min, todosPrecos[0]);
        maior = todosPrecos.reduce((max, p) => p.preco > max.preco ? p : max, todosPrecos[0]);
    }

    res.status(200).json({
        mercadoLivre: { media: media(ml), qtd: ml.length },
        amazon: { media: media(amz), qtd: amz.length },
        geral: media(todosPrecos),
        extremos: { menor, maior }
    });
});

app.listen(5000, () => console.log("Servidor Backend Furtivo rodando na porta 5000!"));