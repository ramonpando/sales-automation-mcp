-- =============================================
-- SALES AUTOMATION DATABASE SCHEMA
-- =============================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =============================================
-- TABLA PRINCIPAL: LEADS
-- =============================================
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    
    -- Datos básicos
    company_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    location VARCHAR(100),
    industry VARCHAR(100),
    
    -- Datos enriquecidos (JSON)
    emails JSONB DEFAULT '[]'::jsonb,
    founders JSONB DEFAULT '[]'::jsonb,
    website VARCHAR(500),
    social_media JSONB DEFAULT '{}'::jsonb,
    sources JSONB DEFAULT '[]'::jsonb,
    
    -- Scoring
    lead_score INTEGER DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
    confidence_score DECIMAL(3,2) DEFAULT 0.00 CHECK (confidence_score >= 0.00 AND confidence_score <= 1.00),
    
    -- Status y workflow
    status VARCHAR(50) DEFAULT 'new',
    stage VARCHAR(50) DEFAULT 'prospecting',
    priority VARCHAR(20) DEFAULT 'medium',
    assigned_to VARCHAR(100),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_contact_at TIMESTAMP,
    next_follow_up TIMESTAMP,
    
    -- Constraints
    UNIQUE(company_name, phone)
);

-- =============================================
-- ÍNDICES PARA PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_leads_company_name ON leads(company_name);
CREATE INDEX IF NOT EXISTS idx_leads_lead_score ON leads(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_industry ON leads(industry);
CREATE INDEX IF NOT EXISTS idx_leads_company_name_trgm ON leads USING gin(company_name gin_trgm_ops);

-- =============================================
-- FUNCIÓN PARA ACTUALIZAR updated_at
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger para updated_at
CREATE TRIGGER update_leads_updated_at 
    BEFORE UPDATE ON leads 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- VISTA PARA ESTADÍSTICAS
-- =============================================
CREATE OR REPLACE VIEW leads_summary AS
SELECT 
    COUNT(*) as total_leads,
    AVG(lead_score)::numeric(5,2) as avg_score,
    COUNT(*) FILTER (WHERE lead_score >= 80) as high_quality_leads,
    COUNT(*) FILTER (WHERE emails != '[]'::jsonb) as leads_with_emails,
    COUNT(*) FILTER (WHERE founders != '[]'::jsonb) as leads_with_founders,
    COUNT(DISTINCT industry) as industries_covered,
    MAX(created_at) as last_import
FROM leads;

-- =============================================
-- DATOS DE EJEMPLO
-- =============================================
INSERT INTO leads (
    company_name, phone, location, industry, 
    emails, founders, website, social_media,
    lead_score, confidence_score, status
) VALUES 
(
    'Tacos El Buen Sabor',
    '+52 55 1234 5678',
    'Ciudad de México',
    'restaurante',
    '[
        {"email": "contacto@tacoselbuenosabor.com.mx", "confidence": 0.9, "source": "pattern_generation", "priority": 1},
        {"email": "info@tacoselbuenosabor.com.mx", "confidence": 0.8, "source": "pattern_generation", "priority": 2}
    ]'::jsonb,
    '[
        {"name": "María González", "position": "Fundadora y CEO", "confidence": 0.8, "source": "web_search"}
    ]'::jsonb,
    'https://tacoselbuenosabor.com.mx',
    '{"facebook": "https://facebook.com/tacoselbuenosabor"}'::jsonb,
    85,
    0.85,
    'new'
),
(
    'Panadería La Esperanza',
    '+52 55 9876 5432',
    'Ciudad de México',
    'panadería',
    '[
        {"email": "ventas@panaderiaesperanza.mx", "confidence": 0.8, "source": "pattern_generation", "priority": 3}
    ]'::jsonb,
    '[
        {"name": "Carlos Martínez", "position": "Propietario", "confidence": 0.7, "source": "web_search"}
    ]'::jsonb,
    'https://panaderiaesperanza.mx',
    '{}'::jsonb,
    75,
    0.75,
    'new'
)
ON CONFLICT (company_name, phone) DO NOTHING;
