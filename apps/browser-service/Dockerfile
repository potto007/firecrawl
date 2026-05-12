FROM node:18-slim

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
RUN npx playwright install chromium --with-deps

RUN npm run build

ENV PORT=3001
EXPOSE 3001
EXPOSE 9222

CMD ["npm", "start"]
