# Playwright + Node — matches package.json playwright version
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

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
