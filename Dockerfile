FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Where the JSON "database" files live. On Railway/Render/etc., attach a
# persistent volume/disk at this same path via their dashboard — don't rely
# on a Docker VOLUME instruction here, some builders (Railway included)
# reject it outright, and it wouldn't survive a redeploy on plain Docker
# hosting anyway without an actual mounted volume.
ENV DATA_DIR=/app/data

EXPOSE 3000
CMD ["node", "server.js"]
