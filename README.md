# 🚀 Sales Automation MCP

Sistema completo de automatización de ventas para PyMEs mexicanas utilizando Model Context Protocol (MCP) para enriquecimiento inteligente de leads.

## 🎯 **Características Principales**

- **🔍 Enriquecimiento Inteligente**: Encuentra emails corporativos y fundadores automáticamente
- **📊 Lead Scoring**: Asigna puntajes de calidad a cada lead basado en datos encontrados
- **🤖 MCP Integration**: Utiliza Claude con herramientas especializadas para búsquedas web
- **📧 Email Discovery**: Genera y valida patrones de email corporativos mexicanos
- **👥 Founder Detection**: Busca información de fundadores y ejecutivos
- **🗄️ Database Integration**: Almacena y trackea todos los leads enriquecidos
- **🔄 N8N Ready**: API endpoints listos para integración con workflows

## 🏗️ **Arquitectura del Sistema**

```
Tu Scraper → N8N → MCP Enrichment → PostgreSQL → Google Sheets Enriquecida
```

### **Componentes:**
- **MCP Enrichment Server**: Servidor Node.js con herramientas de enriquecimiento
- **PostgreSQL**: Base de datos para leads y tracking de interacciones
- **Redis**: Cache para mejorar performance de búsquedas
- **API Gateway**: Endpoints REST para integración con N8N

## 📊 **Datos de Entrada vs Salida**

### **Entrada (de tu scraper):**
```json
{
  "company_name": "Tacos El Buen Sabor",
  "phone": "+52 55 1234 5678",
  "sector": "Restaurantes",
  "location": "Ciudad de México"
}
```

### **Salida (enriquecida):**
```json
{
  "company_name": "Tacos El Buen Sabor",
  "phone": "+52 55 1234 5678",
  "emails": [
    "contacto@tacoselbuenosabor.com.mx",
    "info@tacoselbuenosabor.com.mx"
  ],
  "founders": [
    {
      "name": "María González",
      "position": "Fundadora y Propietaria",
      "confidence": 0.8
    }
  ],
  "website": "https://tacoselbuenosabor.com.mx",
  "social_media": {
    "facebook": "facebook.com/tacoselbuenosabor"
  },
  "lead_score": 85,
  "confidence_score": 0.87
}
```

## 🚀 **Instalación y Deployment**

### **Prerequisitos:**
- Docker y Docker Compose
- Cuenta en Dokploy
- API Keys (Google Custom Search, Anthropic Claude)

### **1. Clonar Repositorio:**
```bash
git clone https://github.com/ramonpando/sales-automation-mcp.git
cd sales-automation-mcp
```

### **2. Configurar Variables de Entorno:**
```bash
cp .env.example .env
# Editar .env con tus API keys
```

### **3. Deploy en Dokploy:**
1. Crear nueva aplicación en Dokploy
2. Tipo: **Docker Compose**
3. Repository: `https://github.com/ramonpando/sales-automation-mcp`
4. Configurar variables de entorno en Dokploy UI
5. Deploy!

## 🔧 **Configuración de APIs**

### **Google Custom Search API (Gratis):**
1. Ir a [Google Cloud Console](https://console.cloud.google.com/)
2. Crear proyecto nuevo
3. Habilitar Custom Search API
4. Crear API Key
5. Configurar Programmable Search Engine en [Programmable Search](https://programmablesearchengine.google.com/)

### **Anthropic Claude API:**
1. Ir a [Anthropic Console](https://console.anthropic.com/)
2. Crear cuenta
3. Obtener API Key

## 🔗 **Integración con N8N**

### **Endpoint Principal:**
```
POST http://tu-vps:3000/enrich-batch
```

### **Ejemplo de Workflow N8N:**
```json
{
  "nodes": [
    {
      "name": "Get Scraper Data",
      "type": "HTTP Request",
      "url": "http://swip-scraper/api/results"
    },
    {
      "name": "Enrich Data",
      "type": "HTTP Request",
      "method": "POST",
      "url": "http://sales-api:3000/enrich-batch",
      "body": {
        "companies": "{{$json.scraped_companies}}"
      }
    },
    {
      "name": "Save to Google Sheets",
      "type": "Google Sheets",
      "operation": "append"
    }
  ]
}
```

## 📊 **API Endpoints**

### **Enriquecimiento:**
- `POST /enrich-batch` - Enriquecer múltiples empresas
- `POST /enrich-single` - Enriquecer una empresa
- `GET /leads` - Obtener leads guardados
- `PUT /leads/:id` - Actualizar lead

### **Health Checks:**
- `GET /health` - Estado del sistema
- `GET /health/database` - Estado de la base de datos
- `GET /health/redis` - Estado del cache

## 📈 **Performance Esperado**

- **Tiempo de procesamiento**: 30-60 segundos por empresa
- **Tasa de éxito emails**: 80-90%
- **Tasa de éxito fundadores**: 60-75%
- **Precisión de datos**: 95%+

## 🔄 **Roadmap**

### **Semana 1**: ✅ Base + Enrichment
- MCP deployment
- Database setup
- Basic enrichment

### **Semana 2**: 📧 Email Automation
- Envío de emails personalizados
- Tracking de opens/clicks
- Follow-up automático

### **Semana 3**: 📱 WhatsApp + CRM
- WhatsApp Business integration
- Lead scoring avanzado
- Meeting scheduling

### **Semana 4**: 📊 Dashboard + Analytics
- Dashboard en tiempo real
- Métricas de conversión
- Reportes automáticos

## 🛠️ **Desarrollo Local**

### **Prerequitos:**
- Node.js 18+
- PostgreSQL 15+
- Redis 7+

### **Setup:**
```bash
# Instalar dependencias
cd mcp-enrichment && npm install
cd ../api-gateway && npm install

# Iniciar servicios localmente
docker-compose -f docker-compose.dev.yml up -d

# Iniciar aplicaciones
npm run dev
```

## 🐛 **Troubleshooting**

### **Error: Cannot connect to database**
```bash
# Verificar que PostgreSQL esté corriendo
docker ps | grep postgres

# Verificar logs
docker logs sales-postgres
```

### **Error: Rate limit exceeded**
```bash
# Verificar configuración en .env
echo $RATE_LIMIT_MAX_REQUESTS

# Verificar logs del MCP
docker logs mcp-enrichment
```

## 📞 **Soporte**

- **Documentación**: Ver carpeta `/docs`
- **Issues**: GitHub Issues
- **Logs**: `docker logs <container_name>`

## 📄 **Licencia**

MIT License - Ver [LICENSE](LICENSE) para más detalles.

---

**Desarrollado con ❤️ para automatizar ventas de PyMEs mexicanas** 🇲🇽
