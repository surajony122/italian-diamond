FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

# "prisma generate" only needs the schema (no DB connection), so it's safe and fast to
# run at BUILD time - keeps it off the runtime critical path that Render's free-tier
# health check times out on (see the earlier SQLite-era fix for why that matters).
RUN npx prisma generate

# "prisma migrate deploy" DOES need a live connection to the real database (now an
# external Postgres, not a local file), so it has to run at container START, once
# DATABASE_URL is actually available. Against an already-up-to-date DB this is fast
# (a metadata check, not a rebuild), so it shouldn't reintroduce the startup-timeout
# problem - only the very first deploy pays the cost of creating the schema.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
