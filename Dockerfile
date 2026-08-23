FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

# Run Prisma setup at BUILD time, not container start. Render's free-tier health check
# kills the process if it doesn't bind $PORT quickly enough, and "prisma generate" +
# "migrate deploy" running first (the old `docker-start` script) can eat that whole
# window before the server ever starts listening. Doing it here means the runtime CMD
# only has to do one thing: bind the port immediately.
RUN npx prisma generate && npx prisma migrate deploy

CMD ["npm", "run", "start"]
