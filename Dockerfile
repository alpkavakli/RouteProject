FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Europe/Istanbul

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3050

ENV NODE_ENV=production

CMD ["node", "server.js"]
