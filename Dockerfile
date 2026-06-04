# ============================================================================
# Dockerfile - Area de Membros 2.0
# ============================================================================
# 
# Usa Node.js 20 LTS em Alpine (imagem leve ~50MB).
# Roda com usuário não-root por segurança.
# 
# ============================================================================

FROM node:20-alpine

# Diretório de trabalho dentro do container
WORKDIR /app

# libvips é dependência nativa do sharp (resize de imagens). Em Alpine é leve (~7MB).
RUN apk add --no-cache vips

# Copia arquivos de dependência primeiro (aproveita cache do Docker)
COPY package*.json ./

# Instala dependências de produção apenas
RUN npm install --omit=dev && npm cache clean --force

# Copia o resto do código
COPY . .

# Cria diretório de uploads (com subpastas pros presets) e dá permissão pro user node
RUN mkdir -p uploads/hero uploads/banner-produto uploads/card-produto uploads/card-categoria uploads/avatar uploads/raw \
    && chown -R node:node /app

# Usa o usuário "node" (não-root) que já vem na imagem Alpine
USER node

# Porta que o app escuta (EasyPanel detecta automaticamente)
EXPOSE 3000

# Health check pro EasyPanel saber que o app tá vivo
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Comando de inicialização
CMD ["node", "server.js"]
