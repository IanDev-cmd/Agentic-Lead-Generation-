FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN pip3 install --break-system-packages --no-cache-dir -r fallback/requirements.txt

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
