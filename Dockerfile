# Playwright + Node — MUST match package-lock playwright version (browsers path)
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV RENDER=1
ENV PLAYWRIGHT_CHROMIUM_ARGS=1

EXPOSE 8080

CMD ["node", "server.mjs"]
