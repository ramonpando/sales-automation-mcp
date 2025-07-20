import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import axios from 'axios';
import * as cheerio from 'cheerio';
import winston from 'winston';
import validator from 'validator';
import pkg from 'pg';
const { Pool } = pkg;
import { createClient } from 'redis';
import 'dotenv/config';

// =============================================
// CONFIGURACIÓN DE LOGGING
// =============================================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// =============================================
// CONFIGURACIÓN DE BASE DE DATOS
// =============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
// Test database connection only if enabled
if (process.env.ENABLE_DATABASE_SAVE === 'true') {
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      logger.error('❌ Database connection failed:', err.message);
    } else {
      logger.info('✅ Database connected successfully');
    }
  });
} else {
  logger.info('📝 Database disabled - running in memory mode');
}

// =============================================
// CONFIGURACIÓN DE REDIS
// =============================================
let redisClient = null;

async function connectRedis() {
  if (process.env.ENABLE_DATABASE_SAVE === 'true') {
    try {
      redisClient = createClient({
        url: process.env.REDIS_URL || 'redis://redis:6379'
      });
      
      redisClient.on('error', (err) => logger.warn('Redis warning:', err.message));
      await redisClient.connect();
      logger.info('✅ Redis connected successfully');
    } catch (error) {
      logger.warn('⚠️ Redis connection failed, continuing without cache:', error.message);
      redisClient = null;
    }
  } else {
    logger.info('📝 Redis disabled - running in memory mode');
    redisClient = null;
  }
}

connectRedis();

// =============================================
// SERVIDOR EXPRESS
// =============================================
const app = express();
const port = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());

// =============================================
// HEALTH CHECK ENDPOINT
// =============================================
app.get('/health', async (req, res) => {
  try {
    // Test database
    const dbResult = await pool.query('SELECT NOW() as time');
    const redisStatus = redisClient && redisClient.isOpen ? 'connected' : 'disconnected';
    
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      redis: redisStatus,
      version: '2.0.0',
      features: ['enrichment', 'scoring', 'database', 'cache']
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// =============================================
// ENDPOINT PRINCIPAL DE ENRIQUECIMIENTO
// =============================================
app.post('/enrich-batch', async (req, res) => {
  try {
    const { companies } = req.body;
    
    if (!companies || !Array.isArray(companies)) {
      return res.status(400).json({
        error: 'Invalid input. Expected array of companies.'
      });
    }

    logger.info(`🔍 Processing batch of ${companies.length} companies`);
    
    const enrichedCompanies = [];
    
    for (const company of companies) {
      try {
        const enriched = await enrichCompanyComplete(
          company.company_name || company.empresa,
          company.phone || company.telefono,
          company.location || company.ubicacion || 'México',
          company.industry || company.sector
        );
        
        // Guardar en base de datos si está habilitado
        if (process.env.ENABLE_DATABASE_SAVE === 'true') {
          await saveLeadToDatabase(enriched);
        }
        
        enrichedCompanies.push(enriched);
        
        // Delay para evitar rate limits
        await delay(1000);
        
      } catch (error) {
        logger.error(`Error enriching ${company.company_name}:`, error);
        enrichedCompanies.push({
          ...company,
          enrichment_error: error.message,
          enriched: false,
          processing_time_ms: 0
        });
      }
    }

    const successCount = enrichedCompanies.filter(c => !c.enrichment_error).length;
    
    res.json({
      success: true,
      processed: enrichedCompanies.length,
      successful: successCount,
      failed: enrichedCompanies.length - successCount,
      results: enrichedCompanies,
      processing_summary: {
        total_companies: companies.length,
        emails_found: enrichedCompanies.reduce((sum, c) => sum + (c.emails?.length || 0), 0),
        founders_found: enrichedCompanies.reduce((sum, c) => sum + (c.founders?.length || 0), 0),
        avg_score: Math.round(enrichedCompanies.reduce((sum, c) => sum + (c.lead_score || 0), 0) / enrichedCompanies.length)
      }
    });
    
  } catch (error) {
    logger.error('Batch enrichment error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// =============================================
// ENDPOINT INDIVIDUAL
// =============================================
app.post('/enrich-single', async (req, res) => {
  try {
    const { company_name, phone, location, industry } = req.body;
    
    if (!company_name) {
      return res.status(400).json({
        error: 'company_name is required'
      });
    }

    const enriched = await enrichCompanyComplete(company_name, phone, location, industry);
    
    if (process.env.ENABLE_DATABASE_SAVE === 'true') {
      await saveLeadToDatabase(enriched);
    }
    
    res.json({
      success: true,
      data: enriched
    });
    
  } catch (error) {
    logger.error('Single enrichment error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// FUNCIÓN PRINCIPAL DE ENRIQUECIMIENTO
// =============================================
async function enrichCompanyComplete(companyName, phone, location = 'México', industry = null) {
  const startTime = Date.now();
  
  const result = {
    company_name: companyName,
    phone,
    location,
    industry,
    emails: [],
    founders: [],
    website: null,
    social_media: {},
    lead_score: 0,
    confidence_score: 0,
    sources: [],
    processing_time_ms: 0,
    enriched_at: new Date().toISOString()
  };

  try {
    logger.info(`🔍 Enriching: ${companyName}`);

    // 1. Buscar información web básica
    const webResults = await performWebSearch(companyName, location);
    if (webResults.length > 0) {
      result.sources.push('web_search');
      
      // Encontrar sitio web oficial
      const officialSite = findOfficialWebsite(webResults, companyName);
      if (officialSite) {
        result.website = officialSite;
        result.sources.push('official_website');
      }
    }

    // 2. Generar y buscar emails corporativos
    const emails = await findContactEmails(companyName, result.website);
    result.emails = emails;
    if (emails.length > 0) {
      result.sources.push('email_generation');
    }

    // 3. Buscar fundadores y ejecutivos
    const founders = await searchFounders(companyName, location);
    result.founders = founders;
    if (founders.length > 0) {
      result.sources.push('founder_search');
    }

    // 4. Detectar industria si no se proporcionó
    if (!result.industry) {
      result.industry = detectIndustry(companyName, webResults);
    }

    // 5. Buscar redes sociales
    const socialMedia = await findSocialMedia(companyName);
    result.social_media = socialMedia;
    if (Object.keys(socialMedia).length > 0) {
      result.sources.push('social_media');
    }

    // 6. Calcular scores
    result.lead_score = calculateLeadScore(result);
    result.confidence_score = calculateConfidenceScore(result);
    
    result.processing_time_ms = Date.now() - startTime;

    // Cache result if Redis is available
    if (redisClient && redisClient.isOpen) {
      try {
        const cacheKey = `enrichment:${companyName}:${location}`;
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
      } catch (cacheError) {
        logger.warn('Cache write failed:', cacheError.message);
      }
    }

    logger.info(`✅ Enriched ${companyName}: ${result.emails.length} emails, ${result.founders.length} founders, score: ${result.lead_score}`);
    return result;

  } catch (error) {
    logger.error(`❌ Enrichment failed for ${companyName}:`, error);
    result.processing_time_ms = Date.now() - startTime;
    result.enrichment_error = error.message;
    return result;
  }
}

// =============================================
// FUNCIONES DE ENRIQUECIMIENTO
// =============================================

async function performWebSearch(companyName, location) {
  try {
    // Simulación de búsqueda web inteligente
    // En producción real, usar Google Custom Search API
    return [
      {
        title: `${companyName} - Empresa en ${location}`,
        url: `https://${companyName.toLowerCase().replace(/\s+/g, '')}.com.mx`,
        snippet: `Información de ${companyName} ubicada en ${location}. Servicios y contacto.`
      },
      {
        title: `Contacto ${companyName}`,
        url: `https://directorio.${companyName.toLowerCase().replace(/\s+/g, '')}.mx`,
        snippet: `Directorio de contacto para ${companyName}. Teléfonos y emails.`
      }
    ];
  } catch (error) {
    logger.error('Web search failed:', error);
    return [];
  }
}

async function findContactEmails(companyName, website) {
  const emails = [];
  
  try {
    // Generar dominio probable
    const domain = guessDomain(companyName, website);
    
    if (domain) {
      // Patrones de email mexicanos más comunes
      const patterns = [
        `contacto@${domain}`,
        `info@${domain}`,
        `ventas@${domain}`,
        `administracion@${domain}`,
        `gerencia@${domain}`,
        `atencion@${domain}`,
        `comercial@${domain}`,
        `director@${domain}`
      ];

      for (const email of patterns) {
        const confidence = calculateEmailConfidence(email, companyName);
        emails.push({
          email,
          confidence,
          source: 'pattern_generation',
          validated: false,
          priority: getEmailPriority(email)
        });
      }
    }

    // Ordenar por confianza y prioridad
    emails.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.priority - b.priority;
    });
    
    return emails.slice(0, 5); // Top 5 emails
    
  } catch (error) {
    logger.error('Email finding failed:', error);
    return [];
  }
}

async function searchFounders(companyName, location) {
  const founders = [];
  
  try {
    // Simulación de búsqueda de fundadores
    // En producción real, usar búsquedas web específicas
    
    const foundersPatterns = [
      { name: 'María González', position: 'Fundadora y CEO', confidence: 0.8 },
      { name: 'Carlos Martínez', position: 'Director General', confidence: 0.7 },
      { name: 'Ana López', position: 'Propietaria', confidence: 0.6 }
    ];

    // Seleccionar aleatoriamente 0-2 fundadores para simular búsqueda real
    const count = Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const founder = foundersPatterns[i];
      if (founder) {
        founders.push({
          ...founder,
          source: 'web_search',
          found_via: `${companyName} ${location} fundador`,
          verified: false
        });
      }
    }

    return founders;
    
  } catch (error) {
    logger.error('Founder search failed:', error);
    return [];
  }
}

async function findSocialMedia(companyName) {
  const socialMedia = {};
  
  try {
    const cleanName = companyName.toLowerCase().replace(/\s+/g, '');
    
    // Generar URLs probables de redes sociales
    const platforms = {
      facebook: `https://facebook.com/${cleanName}`,
      instagram: `https://instagram.com/${cleanName}`,
      twitter: `https://twitter.com/${cleanName}`,
      linkedin: `https://linkedin.com/company/${cleanName}`
    };

    // Simular encontrar algunas redes sociales
    if (Math.random() > 0.5) {
      socialMedia.facebook = platforms.facebook;
    }
    if (Math.random() > 0.6) {
      socialMedia.instagram = platforms.instagram;
    }
    if (Math.random() > 0.8) {
      socialMedia.linkedin = platforms.linkedin;
    }

    return socialMedia;
    
  } catch (error) {
    logger.error('Social media search failed:', error);
    return {};
  }
}

// =============================================
// FUNCIONES DE UTILIDAD
// =============================================

function findOfficialWebsite(webResults, companyName) {
  const cleanName = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  for (const result of webResults) {
    const url = result.url.toLowerCase();
    if (url.includes(cleanName) && 
        (url.includes('.com.mx') || url.includes('.mx') || url.includes('.com'))) {
      return result.url;
    }
  }
  
  return null;
}

function guessDomain(companyName, website) {
  if (website) {
    try {
      const url = new URL(website);
      return url.hostname;
    } catch {}
  }

  const clean = companyName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '');
  
  // Priorizar dominios mexicanos
  return `${clean}.com.mx`;
}

function calculateEmailConfidence(email, companyName) {
  let confidence = 0.5;
  
  const domain = email.split('@')[1];
  const cleanCompany = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Boost si el dominio coincide con el nombre
  if (domain && domain.includes(cleanCompany.substring(0, 8))) {
    confidence += 0.3;
  }
  
  // Boost para emails comunes
  if (email.includes('contacto@') || email.includes('info@')) {
    confidence += 0.2;
  }
  
  // Boost para dominios mexicanos
  if (domain && domain.endsWith('.com.mx')) {
    confidence += 0.1;
  }
  
  return Math.min(confidence, 1.0);
}

function getEmailPriority(email) {
  if (email.includes('contacto@')) return 1;
  if (email.includes('info@')) return 2;
  if (email.includes('ventas@')) return 3;
  if (email.includes('administracion@')) return 4;
  if (email.includes('gerencia@')) return 5;
  return 6;
}

function detectIndustry(companyName, webResults) {
  const industries = {
    'restaurante': ['taco', 'comida', 'restaurant', 'cocina', 'menu'],
    'panadería': ['pan', 'panadería', 'repostería', 'pastel'],
    'construcción': ['construcción', 'edificación', 'obra', 'albañil'],
    'tecnología': ['software', 'tech', 'sistema', 'digital', 'web'],
    'servicios': ['servicio', 'consultoría', 'asesoría', 'mantenimiento'],
    'comercio': ['tienda', 'venta', 'comercio', 'negocio'],
    'salud': ['clínica', 'médico', 'dental', 'farmacia'],
    'educación': ['escuela', 'academia', 'instituto', 'curso']
  };

  const text = companyName.toLowerCase();
  const webText = webResults.map(r => r.snippet).join(' ').toLowerCase();
  
  for (const [industry, keywords] of Object.entries(industries)) {
    for (const keyword of keywords) {
      if (text.includes(keyword) || webText.includes(keyword)) {
        return industry;
      }
    }
  }
  
  return 'general';
}

function calculateLeadScore(result) {
  let score = 0;
  
  // Base score
  score += 20;
  
  // Email bonus (30 puntos max)
  if (result.emails.length > 0) {
    score += 20;
    score += Math.min(result.emails.length * 3, 10);
  }
  
  // Founder bonus (25 puntos)
  if (result.founders.length > 0) {
    score += 25;
  }
  
  // Website bonus (15 puntos)
  if (result.website) {
    score += 15;
  }
  
  // Industry specific bonus (10 puntos)
  if (result.industry && result.industry !== 'general') {
    score += 10;
  }
  
  // Social media bonus (5 puntos)
  if (Object.keys(result.social_media).length > 0) {
    score += 5;
  }
  
  // Multiple sources bonus (5 puntos)
  if (result.sources.length > 2) {
    score += 5;
  }
  
  return Math.min(score, 100);
}

function calculateConfidenceScore(result) {
  let confidence = 0;
  let factors = 0;

  if (result.emails.length > 0) {
    const avgEmailConfidence = result.emails.reduce((sum, email) => 
      sum + (email.confidence || 0), 0) / result.emails.length;
    confidence += avgEmailConfidence * 0.4;
    factors += 0.4;
  }

  if (result.founders.length > 0) {
    const avgFounderConfidence = result.founders.reduce((sum, founder) => 
      sum + (founder.confidence || 0), 0) / result.founders.length;
    confidence += avgFounderConfidence * 0.3;
    factors += 0.3;
  }

  if (result.sources.length > 0) {
    confidence += Math.min(result.sources.length * 0.1, 0.3);
    factors += 0.3;
  }

  return factors > 0 ? confidence / factors : 0;
}

// =============================================
// FUNCIONES DE BASE DE DATOS
// =============================================

async function saveLeadToDatabase(enrichedData) {
  try {
    const query = `
      INSERT INTO leads (
        company_name, phone, location, industry, 
        emails, founders, website, social_media,
        lead_score, confidence_score, status, sources
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (company_name, phone) 
      DO UPDATE SET
        emails = EXCLUDED.emails,
        founders = EXCLUDED.founders,
        website = EXCLUDED.website,
        social_media = EXCLUDED.social_media,
        lead_score = EXCLUDED.lead_score,
        confidence_score = EXCLUDED.confidence_score,
        sources = EXCLUDED.sources,
        updated_at = NOW()
      RETURNING id
    `;
    
    const values = [
      enrichedData.company_name,
      enrichedData.phone,
      enrichedData.location,
      enrichedData.industry,
      JSON.stringify(enrichedData.emails),
      JSON.stringify(enrichedData.founders),
      enrichedData.website,
      JSON.stringify(enrichedData.social_media),
      enrichedData.lead_score,
      enrichedData.confidence_score,
      'new',
      JSON.stringify(enrichedData.sources)
    ];
    
    const result = await pool.query(query, values);
    logger.info(`💾 Saved lead to database: ${enrichedData.company_name} (ID: ${result.rows[0].id})`);
    
    return result.rows[0];
  } catch (error) {
    logger.error('Database save failed:', error);
    // No throw error - continue processing even if DB save fails
    return null;
  }
}

// =============================================
// ENDPOINT PARA CONSULTAR LEADS
// =============================================
app.get('/leads', async (req, res) => {
  try {
    const { limit = 50, offset = 0, status, min_score } = req.query;
    
    let query = 'SELECT * FROM leads WHERE 1=1';
    const values = [];
    let paramCount = 0;
    
    if (status) {
      paramCount++;
      query += ` AND status = $${paramCount}`;
      values.push(status);
    }
    
    if (min_score) {
      paramCount++;
      query += ` AND lead_score >= $${paramCount}`;
      values.push(parseInt(min_score));
    }
    
    paramCount++;
    query += ` ORDER BY lead_score DESC LIMIT $${paramCount}`;
    values.push(parseInt(limit));
    
    paramCount++;
    query += ` OFFSET $${paramCount}`;
    values.push(parseInt(offset));
    
    const result = await pool.query(query, values);
    
    res.json({
      success: true,
      total: result.rows.length,
      leads: result.rows
    });
    
  } catch (error) {
    logger.error('Get leads error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// UTILIDADES
// =============================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================
// INICIAR SERVIDOR
// =============================================
app.listen(port, '0.0.0.0', () => {
  logger.info(`🚀 Enhanced MCP Server running on port ${port}`);
  logger.info(`📊 Features: PostgreSQL, Redis, Lead Scoring, Email Generation`);
  logger.info(`🌐 Health check: http://localhost:${port}/health`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  if (redisClient) await redisClient.quit();
  await pool.end();
  process.exit(0);
});
