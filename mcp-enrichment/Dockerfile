FROM node:18-alpine

# Install system dependencies
RUN apk add --no-cache curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies with npm install (not npm ci)
RUN npm install --production

# Copy source code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp -u 1001 -G nodejs

# Change ownership
RUN chown -R mcp:nodejs /app
USER mcp

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Start command
CMD ["node", "server.js"]
