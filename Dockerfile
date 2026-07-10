FROM node:24-alpine

RUN apk add --no-cache python3 make g++ ca-certificates

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8978
ENV DB_PATH=/data/app.db

VOLUME ["/data"]
EXPOSE 8978

CMD ["node", "src/server.js"]
