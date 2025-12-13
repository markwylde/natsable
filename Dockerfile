FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source files
COPY src ./src
COPY config ./config

# Create certs directory
RUN mkdir -p /app/certs

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "src/server.ts"]
