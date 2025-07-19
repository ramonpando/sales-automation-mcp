-- Sales Automation Database Schema
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    company_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    location VARCHAR(100),
    emails JSONB DEFAULT '[]'::jsonb,
    founders JSONB DEFAULT '[]'::jsonb,
    website VARCHAR(500),
    social_media JSONB DEFAULT '{}'::jsonb,
    industry VARCHAR(100),
    lead_score INTEGER DEFAULT 0,
    confidence_score DECIMAL(3,2) DEFAULT 0.00,
    status VARCHAR(50) DEFAULT 'new',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_leads_company_name ON leads(company_name);
CREATE INDEX IF NOT EXISTS idx_leads_lead_score ON leads(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
