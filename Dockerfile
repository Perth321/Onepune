FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY data ./data

CMD ["node", "src/index.js"]