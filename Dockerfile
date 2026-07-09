FROM node:24-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/app.db

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "src/server.js"]
