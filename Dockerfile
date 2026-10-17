# --- build the React client ---
FROM node:20-alpine AS client
WORKDIR /client
COPY client/package.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# --- API + static client ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY --from=client /client/dist ./client/dist
EXPOSE 3000
CMD ["node", "server/index.js"]
