Optional webfonts (you must own a license to use Helvetica Neue Pro on the web):

Place WOFF2 files here with these exact names so the UI can load them:

  HelveticaNeuePro-Regular.woff2   → 400 weight
  HelveticaNeuePro-Medium.woff2    → 600 weight (headings / emphasis)

If these files are missing, the app falls back to system Helvetica Neue / sans-serif (no 404 errors in modern browsers for failed @font-face).

Rename files from your font package to match the names above, or edit the @font-face URLs in public/index.html.
