function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function classifyUrlTier(url) {
  const u = String(url || "").toLowerCase();
  if (/union|auxiliar|commercial|vendor/.test(u)) return 1;
  if (/student-life|student-affairs|student-experience|dean-of-students/.test(u)) return 2;
  if (/student-government|student-association|student-senate|asuc|sg\./.test(u)) return 3;
  if (/entrepreneur|innovation|venture|startup/.test(u)) return 4;
  if (/multicultural|south-asian|cultural/.test(u)) return 5;
  if (/sustainability|zero-waste|green/.test(u)) return 6;
  if (/food-truck|mobile-vendor/.test(u)) return 7;
  if (/dining|catering|food-service/.test(u)) return 8;
  if (/ehs|environmental-health|food-safety|permits/.test(u)) return 9;
  return null;
}

export function extractEmailsFromHtml(html) {
  const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = String(html || "").match(EMAIL_REGEX) || [];
  return [...new Set(matches.map(normalizeEmail))]
    .filter((e) => e && !e.includes("example.") && !e.includes("domain."))
    .map((email) => ({ email, linkText: "", source: "html_regex" }));
}

export function extractContextWindows(bodyText, emails) {
  const windows = {};
  const text = String(bodyText || "");
  for (const { email } of emails || []) {
    const idx = text.toLowerCase().indexOf(String(email || "").toLowerCase());
    if (idx === -1) continue;
    windows[email] = text.slice(Math.max(0, idx - 150), Math.min(text.length, idx + 150));
  }
  return windows;
}

function extractEmailsFromText(bodyText) {
  const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = String(bodyText || "").match(EMAIL_REGEX) || [];
  return [...new Set(matches.map(normalizeEmail))]
    .filter((e) => e && !e.includes("example.") && !e.includes("domain."))
    .map((email) => ({ email, linkText: "", source: "page_text" }));
}

function mergeEmailSources(mailtos, htmlEmails, bodyText) {
  const textEmails = extractEmailsFromText(bodyText);
  const map = new Map();
  for (const m of [...(mailtos || []), ...(htmlEmails || []), ...textEmails]) {
    const e = normalizeEmail(m?.email);
    if (!e || !e.includes("@")) continue;
    if (!map.has(e)) map.set(e, { email: e, linkText: String(m?.linkText || ""), source: m?.source || "merged" });
  }
  return [...map.values()];
}

export async function fetchWithEmailExtraction(browser, url, tier = null, university = "") {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    document.querySelectorAll("[data-email],[data-user],[data-domain]").forEach((el) => {
      const user = el.dataset.user || el.dataset.email || "";
      const domain = el.dataset.domain || "";
      if (user && domain && !String(user).includes("@")) el.textContent = `${user}@${domain}`;
    });

    document.body.innerHTML = document.body.innerHTML
      .replace(/\s*\[at\]\s*/gi, "@")
      .replace(/\s*\[dot\]\s*/gi, ".")
      .replace(/\s*&#64;\s*/g, "@");

    document.querySelectorAll("span").forEach((span) => {
      if (span.textContent.trim() === "@") {
        const prev = span.previousElementSibling;
        const next = span.nextElementSibling;
        if (prev && next) {
          prev.textContent = `${prev.textContent}@${next.textContent}`;
          span.remove();
          next.remove();
        }
      }
    });
  });

  const bodyText = await page.innerText("body").catch(() => "");
  const rawHtml = await page.content().catch(() => "");
  const htmlEmails = extractEmailsFromHtml(rawHtml);
  const mailtos =
    (await page
      .$$eval("a[href^='mailto:']", (els) =>
        els.map((el) => ({
          email: (el.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0],
          linkText: (el.textContent || "").trim().slice(0, 200),
          source: "mailto",
        }))
      )
      .catch(() => [])) || [];
  const allEmails = mergeEmailSources(mailtos, htmlEmails, bodyText);
  const contextWindows = extractContextWindows(bodyText, allEmails);
  const finalUrl = page.url();
  const title = await page.title().catch(() => "");
  await page.close();
  return {
    url,
    finalUrl,
    title,
    bodyText: String(bodyText || "").slice(0, 100000),
    rawHtml: String(rawHtml || "").slice(0, 200000),
    mailtos: allEmails,
    contextWindows,
    tier: classifyUrlTier(finalUrl) || tier,
    university,
  };
}

