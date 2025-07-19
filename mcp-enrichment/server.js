import express from 'express';

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Test endpoint
app.post('/enrich-batch', (req, res) => {
  const { companies } = req.body;
  
  res.json({
    success: true,
    message: 'MCP server working!',
    companies_received: companies?.length || 0,
    processed_at: new Date().toISOString()
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 MCP Server running on port ${port}`);
});
