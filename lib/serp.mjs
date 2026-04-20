/**
 * Search engine helpers (Google → Bing; optional DuckDuckGo).
 * Shared with the legacy playwright-gemini scraper patterns.
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isLikelyCampusPage(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (
      /google\.|bing\.|duckduckgo\.|facebook\.|linkedin\.|youtube\.|instagram\.|twitter\.|x\.com|tiktok\.|reddit\.|pinterest\./i.test(
        h
      )
    ) {
      return false;
    }
    return /\.edu$|\.edu\.|\.ac\.uk|\.gov/i.test(h) || h.endsWith(".edu");
  } catch {
    return false;
  }
}

export function unwrapSearchRedirect(raw) {
  const decodeBingU = (val) => {
    const s = String(val || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    const uriDecoded = (() => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })();
    if (/^https?:\/\//i.test(uriDecoded)) return uriDecoded;
    const base = uriDecoded.replace(/^a1/i, "");
    const normalized = base.replace(/-/g, "+").replace(/_/g, "/");
    try {
      const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
      const decoded = Buffer.from(normalized + pad, "base64").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* empty */
    }
    return "";
  };

  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();

    if (h.includes("duckduckgo.com")) {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }

    if (h.includes("google.")) {
      const q = u.searchParams.get("q");
      if (q && /^https?:\/\//i.test(q)) return q;
      const urlParam = u.searchParams.get("url");
      if (urlParam && /^https?:\/\//i.test(urlParam)) {
        try {
          return decodeURIComponent(urlParam);
        } catch {
          return urlParam;
        }
      }
      if ((u.pathname === "/url" || u.pathname.endsWith("/url")) && q) return q;
    }

    if (h.includes("bing.com")) {
      const viaU = decodeBingU(u.searchParams.get("u"));
      if (viaU) return viaU;
      const viaUrl = decodeBingU(u.searchParams.get("url"));
      if (viaUrl) return viaUrl;
      const viaR = decodeBingU(u.searchParams.get("r"));
      if (viaR) return viaR;
    }
  } catch {
    /* empty */
  }
  return raw;
}

export function dedupeUrlStrings(urls) {
  const seen = new Set();
  const out = [];
  for (const raw0 of urls) {
    const raw = unwrapSearchRedirect(raw0);
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    u.hash = "";
    if (u.searchParams.has("utm_source")) u.searchParams.delete("utm_source");
    const key = u.href;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isLikelyCampusPage(key)) out.push(key);
  }
  return out;
}

async function dismissGoogleConsent(page) {
  const tryClick = async (locator) => {
    try {
      if (await locator.isVisible({ timeout: 600 })) {
        await locator.click({ timeout: 3000 });
        await sleep(800);
        return true;
      }
    } catch {
      /* empty */
    }
    return false;
  };
  await tryClick(page.getByRole("button", { name: /^Accept all$/i }).first());
  await tryClick(page.getByRole("button", { name: /^I agree$/i }).first());
  await tryClick(page.locator("#L2AGLb"));
  await tryClick(page.locator("button").filter({ hasText: /^Accept$/i }).first());
}

export async function searchDuckDuckGo(page, query) {
  const enc = encodeURIComponent(query);
  await page.goto(`https://html.duckduckgo.com/html/?q=${enc}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await sleep(900);
  const links = await page
    .$$eval("a.result__a, a[href]", (as) =>
      as
        .map((a) => a.href)
        .filter(Boolean)
        .filter((href) => /uddg=|^https?:\/\//i.test(href))
    )
    .catch(() => []);
  return links;
}

export async function searchBing(page, query) {
  const enc = encodeURIComponent(query);
  await page.goto(`https://www.bing.com/search?q=${enc}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await sleep(900);
  const links = await page
    .$$eval("li.b_algo h2 a, h2 a, a[href]", (as) =>
      as
        .map((a) => a.href)
        .filter(Boolean)
        .filter((href) => /^https?:\/\//i.test(href))
    )
    .catch(() => []);
  return links;
}

export async function searchGoogle(page, query) {
  const enc = encodeURIComponent(query);
  await page.goto(`https://www.google.com/search?q=${enc}&num=10&hl=en&gl=us&pws=0`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await dismissGoogleConsent(page);
  await page.locator("#rso").waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  await sleep(900);

  const blockedHint = await page.locator("body").innerText().catch(() => "");
  if (/unusual traffic|automated queries|I'm not a robot|reCAPTCHA|can't verify you're not a robot/i.test(blockedHint)) {
    return [];
  }

  const links = await page
    .evaluate(() => {
      const skip = (u) =>
        !u ||
        /google\.com\/(search\?|intl\/|maps|imgres|travel|flights|accounts)/i.test(u) ||
        /support\.google|policies\.google|chrome\.google|play\.google/i.test(u);

      const pushUnique = (set, arr, href) => {
        if (!href || skip(href)) return;
        if (set.has(href)) return;
        set.add(href);
        arr.push(href);
      };

      const out = [];
      const seen = new Set();

      const collectFrom = (root) => {
        if (!root) return;
        root.querySelectorAll("a[href]").forEach((a) => {
          pushUnique(seen, out, a.href);
        });
      };

      collectFrom(document.querySelector("#rso"));
      collectFrom(document.querySelector("#center_col"));

      document.querySelectorAll("a h3").forEach((h3) => {
        const a = h3.closest("a");
        if (a?.href) pushUnique(seen, out, a.href);
      });

      if (out.length < 2) collectFrom(document.querySelector("main"));
      if (out.length < 2) collectFrom(document.body);

      return out;
    })
    .catch(() => []);

  return links;
}

export function chromiumLaunchOptions() {
  const auto = ["--disable-blink-features=AutomationControlled"];
  const o = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_ARGS === "1" || process.env.RENDER) {
    o.args = [...auto, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
  } else {
    o.args = auto;
  }
  return o;
}
