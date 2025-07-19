#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
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
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// =============================================
// CONFIGURACIÓN DE BASE DE DATOS
// =============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// =============================================
// CONFIGURACIÓN DE REDIS
// =============================================
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

redisClient.on('error', (err) => logger.error('Redis error:', err));

// Conectar a Redis de forma asíncrona
async function connectRedis() {
  try {
    await redisClient.connect();
    logger.info('✅ Redis connected');
  } catch (error) {
    logger.error('❌ Redis connection failed:', error);
  }
}

connectRedis();

// =============================================
// SERVIDOR PRINCIPAL
// =============================================
class BusinessIntelligenceServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3001;
    
    this.server = new Server(
      {
        name: 'business-intelligence-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupExpress();
    this.setupToolHandlers();
  }

  setupExpress() {
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(express.json());

    // Health check endpoint
    this.app.get('/health', async (req, res) => {
      try {
        // Test database connection
        const dbResult = await pool.query('SELECT NOW()');
        const redisStatus = redisClient.isOpen ? 'connected' : 'disconnected';
        
        res.json({ 
          status: 'healthy',
          timestamp: new Date().toISOString(),
          database: 'connected',
          redis: redisStatus,
          version: '1.0.0'
        });
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          error: error.message
        });
      }
    });

    // Main endpoint for N8N integration
    this.app.post('/enrich-batch', async (req, res) => {
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
            const enriched = await this.enrichCompanyComplete(
              company.company_name || company.empresa,
              company.phone || company.telefono,
              company.location || company.ubicacion || 'México'
            );
            
            enrichedCompanies.push(enriched);
            
            // Small delay to avoid rate limits
            await this.delay(1000);
            
          } catch (error) {
            logger.error(`Error enriching ${company.company_name}:`, error);
            enrichedCompanies.push({
              ...company,
              enrichment_error: error.message,
              enriched: false
            });
          }
        }

        res.json({
          success: true,
          processed: enrichedCompanies.length,
          results: enrichedCompanies
        });
        
      } catch (error) {
        logger.error('Batch enrichment error:', error);
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // Single company enrichment
    this.app.post('/enrich-single', async (req, res) => {
      try {
        const { company_name, phone, location } = req.body;
        
        if (!company_name) {
          return res.status(400).json({
            error: 'company_name is required'
          });
        }

        const enriched = await this.enrichCompanyComplete(company_name, phone, location);
        
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

    // Start HTTP server
    this.app.listen(this.port, '0.0.0.0', () => {
      logger.info(`🚀 MCP Business Intelligence Server running on port ${this.port}`);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'enrich_company_data',
          description: 'Enriquece datos de una empresa con emails, fundadores y scoring',
          inputSchema: {
            type: 'object',
            properties: {
              company_name: { type: 'string', description: 'Nombre de la empresa' },
              phone: { type: 'string', description: 'Teléfono de la empresa' },
              location: { type: 'string', description: 'Ubicación (default: México)' }
            },
            required: ['company_name']
          }
        },
        {
          name: 'search_business_emails',
          description: 'Busca y genera emails corporativos para una empresa',
          inputSchema: {
            type: 'object',
            properties: {
              company_name: { type: 'string', description: 'Nombre de la empresa' },
              domain: { type: 'string', description: 'Dominio web si se conoce' }
            },
            required: ['company_name']
          }
        },
        {
          name: 'find_company_founders',
          description: 'Busca información de fundadores y ejecutivos',
          inputSchema: {
            type: 'object',
            properties: {
              company_name: { type: 'string', description: 'Nombre de la empresa' },
              industry: { type: 'string', description: 'Industria o sector' }
            },
            required: ['company_name']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'enrich_company_data':
            return await this.handleEnrichCompany(args);
          case 'search_business_emails':
            return await this.handleSearchEmails(args);
          case 'find_company_founders':
            return await this.handleFindFounders(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
        }
      } catch (error) {
        logger.error(`Error executing ${name}:`, error);
        throw new McpError(ErrorCode.InternalError, error.message);
      }
    });
  }

  // =============================================
  // MCP TOOL HANDLERS
  // =============================================

  async handleEnrichCompany(args) {
    const { company_name, phone, location } = args;
    const enriched = await this.enrichCompanyComplete(company_name, phone, location);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(enriched, null, 2)
        }
      ]
    };
  }

  async handleSearchEmails(args) {
    const { company_name, domain } = args;
    const emails = await this.findContactEmails(company_name, domain);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            company_name,
            emails_found: emails,
            total: emails.length
          }, null, 2)
        }
      ]
    };
  }

  async handleFindFounders(args) {
    const { company_name, industry } = args;
    const founders = await this.searchFounders(company_name, industry);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            company_name,
            founders_found: founders,
            total: founders.length
          }, null, 2)
        }
      ]
    };
  }

  // =============================================
  // CORE ENRICHMENT LOGIC
  // =============================================

  async enrichCompanyComplete(companyName, phone, location = 'México') {
    const startTime = Date.now();
    
    const result = {
      company_name: companyName,
      phone,
      location,
      emails: [],
      founders: [],
      website: null,
      social_media: {},
      industry: null,
      lead_score: 0,
      confidence_score: 0,
      sources: [],
      processing_time_ms: 0,
      enriched_at: new Date().toISOString()
    };

    try {
      // Cache check
      const cacheKey = `enrichment:${companyName}:${location}`;
      
      if (redisClient.isOpen) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached) {
            logger.info(`📋 Cache hit for ${companyName}`);
            return JSON.parse(cached);
          }
        } catch (redisError) {
          logger.warn('Redis cache read failed:', redisError);
        }
      }

      // 1. Web search for basic info
      const webResults = await this.performWebSearch(companyName, location);
      if (webResults.length > 0) {
        result.sources.push('web_search');
        
        // Extract website
        const officialSite = this.findOfficialWebsite(webResults, companyName);
        if (officialSite) {
          result.website = officialSite;
          result.sources.push('official_website');
        }
      }

      // 2. Find emails
      const emails = await this.findContactEmails(companyName, result.website);
      result.emails = emails;
      if (emails.length > 0) {
        result.sources.push('email_generation');
      }

      // 3. Find founders
      const founders = await this.searchFounders(companyName, location);
      result.founders = founders;
      if (founders.length > 0) {
        result.sources.push('founder_search');
      }

      // 4. Detect industry
      result.industry = this.detectIndustry(companyName, webResults);
      
      // 5. Calculate scores
      result.lead_score = this.calculateLeadScore(result);
      result.confidence_score = this.calculateConfidenceScore(result);
      
      result.processing_time_ms = Date.now() - startTime;

      // Cache result for 1 hour
      if (redisClient.isOpen) {
        try {
          await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
        } catch (redisError) {
          logger.warn('Redis cache write failed:', redisError);
        }
      }

      logger.info(`✅ Enriched ${companyName} in ${result.processing_time_ms}ms`);
      return result;

    } catch (error) {
      logger.error(`❌ Enrichment failed for ${companyName}:`, error);
      result.processing_time_ms = Date.now() - startTime;
      result.enrichment_error = error.message;
      return result;
    }
  }

  async performWebSearch(companyName, location) {
    try {
      // Mock web search - en producción usar Google Custom Search API
      const searchQueries = [
        `"${companyName}" ${location} contacto`,
        `"${companyName}" sitio web oficial`,
        `"${companyName}" email información empresa`
      ];

      // Simulación de resultados de búsqueda
      return [
        {
          title: `${companyName} - Empresa en ${location}`,
          url: `https://${companyName.toLowerCase().replace(/\s+/g, '')}.com.mx`,
          snippet: `Información de contacto y servicios de ${companyName} ubicada en ${location}`
        }
      ];
    } catch (error) {
      logger.error('Web search failed:', error);
      return [];
    }
  }

  async findContactEmails(companyName, website) {
    const emails = [];
    
    try {
      // Generate common email patterns for Mexican businesses
      const domain = this.guessDomain(companyName, website);
      
      if (domain) {
        const patterns = [
          `contacto@${domain}`,
          `info@${domain}`,
          `ventas@${domain}`,
          `administracion@${domain}`,
          `gerencia@${domain}`,
          `atencion@${domain}`,
          `comercial@${domain}`
        ];

        for (const email of patterns) {
          emails.push({
            email,
            confidence: this.calculateEmailConfidence(email, companyName),
            source: 'pattern_generation',
            validated: false
          });
        }
      }

      // Sort by confidence
      emails.sort((a, b) => b.confidence - a.confidence);
      
      return emails.slice(0, 5); // Top 5 emails
      
    } catch (error) {
      logger.error('Email finding failed:', error);
      return [];
    }
  }

  async searchFounders(companyName, location) {
    const founders = [];
    
    try {
      // Mock founder search - en producción usar búsquedas web reales
      const mockFounders = [
        {
          name: 'María González',
          position: 'Fundadora',
          confidence: 0.8,
          source: 'web_search'
        },
        {
          name: 'Carlos Martínez',
          position: 'Director General',
          confidence: 0.7,
          source: 'web_search'
        }
      ];

      // Return mock data for demo
      return mockFounders.slice(0, Math.floor(Math.random() * 3));
      
    } catch (error) {
      logger.error('Founder search failed:', error);
      return [];
    }
  }

  // =============================================
  // UTILITY FUNCTIONS
  // =============================================

  findOfficialWebsite(webResults, companyName) {
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

  guessDomain(companyName, website) {
    if (website) {
      try {
        const url = new URL(website);
        return url.hostname;
      } catch {}
    }

    const clean = companyName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '');
    
    return `${clean}.com.mx`;
  }

  calculateEmailConfidence(email, companyName) {
    let confidence = 0.5;
    
    const domain = email.split('@')[1];
    const cleanCompany = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (domain && domain.includes(cleanCompany.substring(0, 8))) {
      confidence += 0.3;
    }
    
    if (email.includes('contacto@') || email.includes('info@')) {
      confidence += 0.2;
    }
    
    if (domain && domain.endsWith('.com.mx')) {
      confidence += 0.1;
    }
    
    return Math.min(confidence, 1.0);
  }

  detectIndustry(companyName, webResults) {
    const industries = {
      'restaurante': ['taco', 'comida', 'restaurant', 'cocina'],
      'panadería': ['pan', 'panadería', 'repostería'],
      'construcción': ['construcción', 'edificación', 'obra'],
      'tecnología': ['software', 'tech', 'sistema', 'digital'],
      'servicios': ['servicio', 'consultoría', 'asesoría']
    };

    const text = companyName.toLowerCase();
    
    for (const [industry, keywords] of Object.entries(industries)) {
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          return industry;
        }
      }
    }
    
    return 'general';
  }

  calculateLeadScore(result) {
    let score = 0;
    
    // Base score
    score += 20;
    
    // Email bonus
    if (result.emails.length > 0) {
      score += 30;
      score += Math.min(result.emails.length * 5, 20);
    }
    
    // Founder bonus
    if (result.founders.length > 0) {
      score += 25;
    }
    
    // Website bonus
    if (result.website) {
      score += 15;
    }
    
    // Industry bonus
    if (result.industry && result.industry !== 'general') {
      score += 10;
    }
    
    return Math.min(score, 100);
  }

  calculateConfidenceScore(result) {
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

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async run() {
    try {
      // Test database connection
      await pool.query('SELECT NOW()');
      logger.info('✅ Database connected');
      
      // MCP mode for Claude integration
      if (process.argv.includes('--mcp')) {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        logger.info('✅ MCP Server started in MCP mode');
      } else {
        logger.info('✅ MCP Server started in HTTP mode');
      }
    } catch (error) {
      logger.error('❌ Failed to start MCP server:', error);
      process.exit(1);
    }
  }
}

// =============================================
// SIGNAL HANDLING
// =============================================
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  await redisClient.quit();
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  await redisClient.quit();
  await pool.end();
  process.exit(0);
});

// =============================================
// START SERVER
// =============================================
const server = new BusinessIntelligenceServer();
server.run().catch(error => {
  logger.error('Server startup failed:', error);
  process.exit(1);
});
