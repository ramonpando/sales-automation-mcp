# --- Stage 1: Builder ---
# En esta etapa, instalamos las dependencias como usuario root
FROM node:18-alpine AS builder

WORKDIR /app

# Copiar AMBOS package.json y package-lock.json
# Esto es crucial para una instalación de dependencias predecible y cacheable
COPY package.json package-lock.json* ./

# Instalar solo las dependencias de producción
RUN npm install --production

# --- Stage 2: Production ---
# En esta etapa, construimos la imagen final y ligera
FROM node:18-alpine

# Instalar curl, que es necesario para tu HEALTHCHECK
RUN apk add --no-cache curl

# Establecer el directorio de trabajo
WORKDIR /app

# Crear el grupo y el usuario no-root primero
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp -u 1001 -G nodejs

# Copiar las dependencias ya instaladas desde la etapa 'builder'
# Y establecer el propietario correcto inmediatamente
COPY --from=builder --chown=mcp:nodejs /app/node_modules ./node_modules

# Copiar el resto del código de la aplicación
# Y establecer el propietario correcto
COPY --chown=mcp:nodejs . .

# Cambiar al usuario no-root para el resto de las operaciones y la ejecución
USER mcp

# Exponer el puerto que la aplicación usará
EXPOSE 3001

# Healthcheck (tu healthcheck está bien escrito)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Comando para iniciar la aplicación
CMD ["node", "server.js"]
