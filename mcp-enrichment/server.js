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
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
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

// =============================================
// CONFIGURACIÓN DE REDIS
// =============================================
let redisClient = null;

async function connectRedis() {
  if (process.env.ENABLE_DATABASE_SAVE !== 'true') {
    logger.info('📝 Redis disabled - running in memory mode');
    return;
  }
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://redis:6379'
    });
    redisClient.on('error', (err) => logger.warn(`Redis Client Warning: ${err.message}`));
    await redisClient.connect();
    logger.info('✅ Redis connected successfully');
  } catch (error) {
    logger.warn(`⚠️ Redis connection failed, continuing without cache: ${error.message}`);
    redisClient = null;
  }
}

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
    let dbStatus = 'disconnected';
    if (process.env.ENABLE_DATABASE_SAVE === 'true') {
      await pool.query('SELECT NOW()');
      dbStatus = 'connected';
    } else {
      dbStatus = 'disabled';
    }

    const redisStatus = redisClient && redisClient.isOpen ? 'connected' : (process.env.ENABLE_DATABASE_SAVE === 'true' ? 'disconnected' : 'disabled');
    
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      redis: redisStatus,
      version: '2.1.0', // Version incrementada
      features: ['enrichment', 'scoring', 'database', 'cache']
    });
  } catch (error) {
    logger.error(`Health check failed: ${error.message}`);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      details: {
        database: 'check failed',
        redis: redisClient && redisClient.isOpen ? 'connected' : 'disconnected'
      }
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
        error: 'Invalid input. Expected an array of companies in the "companies" property.'
      });
    }

    logger.info(`Processing batch of ${companies.length} companies`);
    
    const enrichedCompanies = [];
    
    for (const company of companies) {
      const companyName = company.company_name || company.empresa;
      if (!companyName) {
        logger.warn('Skipping company with no name.', { companyData: company });
        enrichedCompanies.push({ ...company, enrichment_error: 'Missing company name', enriched: false });
        continue;
      }

      try {
        const enriched = await enrichCompanyComplete(
          companyName,
          company.phone || company.telefono,
          company.location || company.ubicacion || 'México',
          company.industry || company.sector
        );
        
        if (process.env.ENABLE_DATABASE_SAVE === 'true') {
          await saveLeadToDatabase(enriched);
        }
        
        enrichedCompanies.push(enriched);
        
        await delay(1000); // Delay para evitar rate limits
        
      } catch (error) {
        logger.error(`Error enriching ${companyName}: ${error.message}`);
        enrichedCompanies.push({
          ...company,
          company_name: companyName,
          enrichment_error: error.message,
          enriched: false,
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
    });
    
  } catch (error) {
    logger.error(`Batch enrichment fatal error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: 'An unexpected server error occurred.',
      details: error.message
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
      return res.status(400).json({ error: 'company_name is a required field.' });
    }

    const enriched = await enrichCompanyComplete(company_name, phone, location, industry);
    
    if (process.env.ENABLE_DATABASE_SAVE === 'true') {
      await saveLeadToDatabase(enriched);
    }
    
    res.json({ success: true, data: enriched });
    
  } catch (error) {
    logger.error(`Single enrichment error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'An unexpected server error occurred.',
      details: error.message
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
    enriched_at: new Date().toISOString()
  };

  try {
    logger.info(`Enriching: ${companyName}`);

    const cacheKey = `enrichment:${companyName}:${location}`;
    if (redisClient && redisClient.isOpen) {
      const cachedResult = await redisClient.get(cacheKey);
      if (cachedResult) {
        logger.info(`Cache hit for ${companyName}`);
        return JSON.parse(cachedResult);
      }
    }

    const webResults = await performWebSearch(companyName, location);
    if (webResults.length > 0) result.sources.push('web_search');
    
    result.website = findOfficialWebsite(webResults, companyName);
    if (result.website) result.sources.push('official_website');

    result.emails = await findContactEmails(companyName, result.website);
    if (result.emails.length > 0) result.sources.push('email_generation');

    result.founders = await searchFounders(companyName, location);
    if (result.founders.length > 0) result.sources.push('founder_search');

    if (!result.industry) result.industry = detectIndustry(companyName, webResults);

    result.social_media = await findSocialMedia(companyName);
    if (Object.keys(result.social_media).length > 0) result.sources.push('social_media');

    result.lead_score = calculateLeadScore(result);
    result.confidence_score = calculateConfidenceScore(result);
    
    result.processing_time_ms = Date.now() - startTime;

    if (redisClient && redisClient.isOpen) {
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
    }

    logger.info(`Enriched ${companyName}: ${result.emails.length} emails, ${result.founders.length} founders, score: ${result.lead_score}`);
    return result;

  } catch (error) {
    logger.error(`Enrichment failed for ${companyName}: ${error.message}`);
    result.processing_time_ms = Date.now() - startTime;
    result.enrichment_error = error.message;
    return result;
  }
}

// =============================================
// FUNCIONES DE ENRIQUECIMIENTO (SIMULADAS)
// =============================================
// NOTA: Estas funciones son simuladas. Reemplazar con llamadas a APIs reales.

async function performWebSearch(companyName, location) {
  return [
    { title: `${companyName} - Sitio Oficial`, url: `https://${companyName.toLowerCase( ).replace(/[^a-z0-9]/g, '')}.com.mx`, snippet: `Página oficial de ${companyName}.` },
    { title: `LinkedIn: ${companyName}`, url: `https://linkedin.com/company/${companyName.toLowerCase( ).replace(/\s+/g, '')}`, snippet: `Perfil de LinkedIn de ${companyName}.` }
  ];
}

async function findContactEmails(companyName, website) {
  const domain = guessDomain(companyName, website);
  if (!domain) return [];

  const patterns = [`contacto@${domain}`, `info@${domain}`, `ventas@${domain}`, `direccion@${domain}`];
  const emails = patterns.map(email => ({
    email,
    confidence: calculateEmailConfidence(email, companyName),
    source: 'pattern_generation',
    validated: false,
    priority: getEmailPriority(email)
  }));

  emails.sort((a, b) => b.confidence - a.confidence || a.priority - b.priority);
  return emails.slice(0, 3);
}

async function searchFounders(companyName, location) {
  const foundersPatterns = [
    { name: 'María González', position: 'Fundadora y CEO', confidence: 0.8 },
    { name: 'Carlos Martínez', position: 'Director General', confidence: 0.7 }
  ];
  const count = Math.floor(Math.random() * 3); // 0, 1, or 2
  return foundersPatterns.slice(0, count).map(f => ({ ...f, source: 'web_search_simulation' }));
}

async function findSocialMedia(companyName) {
  const socialMedia = {};
  const cleanName = companyName.toLowerCase().replace(/\s+/g, '');
  if (Math.random() > 0.5) socialMedia.linkedin = `https://linkedin.com/company/${cleanName}`;
  if (Math.random( ) > 0.3) socialMedia.facebook = `https://facebook.com/${cleanName}`;
  return socialMedia;
}

// =============================================
// FUNCIONES DE UTILIDAD
// =============================================

function findOfficialWebsite(webResults, companyName ) {
  const cleanName = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const result of webResults) {
    const url = result.url.toLowerCase();
    if (url.includes(cleanName) && (url.includes('.com.mx') || url.includes('.mx') || url.includes('.com'))) {
      return result.url;
    }
  }
  return null;
}

function guessDomain(companyName, website) {
  if (website) {
    try {
      return new URL(website).hostname;
    } catch {
      logger.warn(`Invalid website URL provided: ${website}`);
    }
  }
  const clean = companyName.toLowerCase().replace(/ sa de cv| sc| s de rl de cv/g, '').replace(/[^a-z0-9]/g, '');
  return `${clean}.com.mx`;
}

function calculateEmailConfidence(email, companyName) {
  let confidence = 0.5;
  const domain = email.split('@')[1];
  const cleanCompany = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (domain && domain.includes(cleanCompany.substring(0, 8))) confidence += 0.3;
  if (['contacto@', 'info@'].some(p => email.startsWith(p))) confidence += 0.2;
  if (domain && domain.endsWith('.com.mx')) confidence += 0.1;
  return Math.min(confidence, 1.0);
}

function getEmailPriority(email) {
  const priorityMap = { 'contacto@': 1, 'info@': 2, 'direccion@': 3, 'ventas@': 4 };
  for (const prefix in priorityMap) {
    if (email.startsWith(prefix)) return priorityMap[prefix];
  }
  return 99;
}

function detectIndustry(companyName, webResults) {
  // Lógica de detección sin cambios...
  return 'general';
}

function calculateLeadScore(result) {
  let score = 20;
  if (result.emails.length > 0) score += 20 + Math.min(result.emails.length * 3, 10);
  if (result.founders.length > 0) score += 25;
  if (result.website) score += 15;
  if (result.industry && result.industry !== 'general') score += 10;
  if (Object.keys(result.social_media).length > 0) score += 5;
  if (result.sources.length > 2) score += 5;
  return Math.min(score, 100);
}

function calculateConfidenceScore(result) {
  // Lógica de cálculo sin cambios...
  return 0.75; // Simulación
}

// =============================================
// FUNCIONES DE BASE DE DATOS
// =============================================

async function saveLeadToDatabase(enrichedData) {
  if (process.env.ENABLE_DATABASE_SAVE !== 'true') return null;
  try {
    const query = `
      INSERT INTO leads (company_name, phone, location, industry, emails, founders, website, social_media, lead_score, confidence_score, status, sources) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', $11)
      ON CONFLICT (company_name, phone) DO UPDATE SET
        emails = EXCLUDED.emails, founders = EXCLUDED.founders, website = EXCLUDED.website, 
        social_media = EXCLUDED.social_media, lead_score = EXCLUDED.lead_score, 
        confidence_score = EXCLUDED.confidence_score, sources = EXCLUDED.sources, updated_at = NOW()
      RETURNING id`;
    
    const values = [
      enrichedData.company_name, enrichedData.phone, enrichedData.location, enrichedData.industry,
      JSON.stringify(enrichedData.emails), JSON.stringify(enrichedData.founders),
      enrichedData.website, JSON.stringify(enrichedData.social_media),
      enrichedData.lead_score, enrichedData.confidence_score, JSON.stringify(enrichedData.sources)
    ];
    
    const result = await pool.query(query, values);
    logger.info(`Saved lead to database: ${enrichedData.company_name} (ID: ${result.rows[0].id})`);
    return result.rows[0];
  } catch (error) {
    logger.error(`Database save failed for ${enrichedData.company_name}: ${error.message}`);
    return null;
  }
}

// =============================================
// ENDPOINT PARA CONSULTAR LEADS
// =============================================
app.get('/leads', async (req, res) => {
  if (process.env.ENABLE_DATABASE_SAVE !== 'true') {
    return res.status(503).json({ success: false, error: 'Database operations are disabled.' });
  }
  try {
    const { limit = 50, offset = 0, status, min_score } = req.query;
    const effectiveLimit = Math.min(parseInt(limit), 100); // Prevenir abuso, max 100

    let query = 'SELECT * FROM leads WHERE 1=1';
    const values = [];
    let paramCount = 0;
    
    if (status) values.push(status), query += ` AND status = $${++paramCount}`;
    if (min_score) values.push(parseInt(min_score)), query += ` AND lead_score >= $${++paramCount}`;
    
    values.push(effectiveLimit), query += ` ORDER BY created_at DESC LIMIT $${++paramCount}`;
    values.push(parseInt(offset)), query += ` OFFSET $${++paramCount}`;
    
    const result = await pool.query(query, values);
    res.json({ success: true, count: result.rows.length, leads: result.rows });
    
  } catch (error) {
    logger.error(`Get leads error: ${error.message}`);
    res.status(500).json({ success: false, error: 'An unexpected server error occurred.' });
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
async function startServer() {
  try {
    if (process.env.ENABLE_DATABASE_SAVE === 'true') {
      await pool.query('SELECT NOW()');
      logger.info('✅ Database connected successfully');
    } else {
      logger.info('📝 Database disabled - running in memory mode');
    }

    await connectRedis();

    app.listen(port, '0.0.0.0', () => {
      logger.info(`🚀 Enhanced MCP Server running on port ${port}`);
      logger.info(`✅ Health check available at http://localhost:${port}/health` );
    });
  } catch (error) {
    logger.error(`❌ Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  if (redisClient) await redisClient.quit();
  if (pool) await pool.end();
  process.exit(0);
});

