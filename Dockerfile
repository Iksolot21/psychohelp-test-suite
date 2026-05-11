FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/runs /app/reports && chown -R pwuser:pwuser /app

USER pwuser

ENV PORT=3000
ENV RUNS_DIR=/app/runs

EXPOSE 3000

CMD ["npm", "start"]
