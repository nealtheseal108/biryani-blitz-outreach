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

export function findEmailsNearName(bodyText, personName) {
  const text = String(bodyText || "");
  const parts = String(personName || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!text || !parts.length) return [];
  const lastName = parts[parts.length - 1];
  const idx = text.toLowerCase().indexOf(lastName);
  if (idx < 0) return [];
  const window = text.slice(Math.max(0, idx - 250), Math.min(text.length, idx + 250));
  const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = window.match(EMAIL_REGEX) || [];
  return [...new Set(matches.map(normalizeEmail))].filter((e) => e && !/example\.|noreply/i.test(e));
}

export function generateEmailFormats(fullName, domain) {
  const parts = String(fullName || "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2 || !domain) return [];
  const first = parts[0];
  const last = parts[parts.length - 1];
  const fi = first[0];
  const li = last[0];
  return [
    `${first}.${last}@${domain}`,
    `${fi}${last}@${domain}`,
    `${last}@${domain}`,
    `${first}${last}@${domain}`,
    `${first}${li}@${domain}`,
    `${last}.${first}@${domain}`,
  ];
}

export async function resolveEmailForPerson(person, domain, snapshot) {
  const near = findEmailsNearName(snapshot?.bodyText || "", person?.name || "");
  if (near.length) return { email: near[0], confidence: "high", source: snapshot?.finalUrl || snapshot?.url || "" };
  const infer = generateEmailFormats(person?.name || "", domain);
  if (infer.length) return { email: infer[0], confidence: "inferred", source: "format_inference" };
  return { email: null, confidence: "inferred", source: "none" };
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

