FROM node:22-alpine

RUN apk add --no-cache p7zip poppler-utils

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server server
COPY scripts scripts

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
