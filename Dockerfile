FROM node:24-alpine

RUN apk add --no-cache python3 make g++ chromium nss freetype harfbuzz ca-certificates

WORKDIR /app

COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8978
ENV DB_PATH=/data/app.db
ENV PAN123_LOGIN_METHOD=api
ENV PAN123_PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PAN123_PLAYWRIGHT_HEADLESS=true

VOLUME ["/data"]
EXPOSE 8978

CMD ["node", "src/server.js"]
