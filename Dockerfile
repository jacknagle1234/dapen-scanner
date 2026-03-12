# Node 20 on Debian (Bookworm) for Playwright Chromium
FROM node:20-bookworm-slim

WORKDIR /app

# Install Playwright system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN npx playwright install chromium

EXPOSE 8080
ENV PORT=8080
CMD ["node", "index.js"]
