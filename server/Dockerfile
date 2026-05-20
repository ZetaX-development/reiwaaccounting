FROM node:20-alpine

# Prisma 5.x needs OpenSSL at runtime to talk to its schema engine; alpine
# doesn't ship it by default. libc6-compat covers Prisma's glibc-flavored
# binaries on musl.
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app/server

# Install deps separately so Docker caches this layer when only source changes.
COPY package.json package-lock.json ./
RUN npm install

# Schema is needed for `prisma generate`; copying it here means the generated
# client lands in the image's node_modules even if the host volume mount
# shadows /app/server/node_modules at runtime.
COPY prisma ./prisma
RUN npx prisma generate

EXPOSE 3000

# At runtime, apply any pending migrations, then start the watcher.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run dev"]
