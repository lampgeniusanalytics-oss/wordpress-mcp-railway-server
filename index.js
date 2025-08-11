const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const WP_API_URL = process.env.WP_API_URL;
const WP_API_USERNAME = process.env.WP_API_USERNAME;
const WP_API_PASSWORD = process.env.WP_API_PASSWORD;

app.use(cors());
app.use(express.json());

console.log('WordPress MCP Server starting...');
console.log('WP_API_URL:', WP_API_URL);
console.log('WP_API_USERNAME:', WP_API_USERNAME ? 'Set' : 'Not set');
console.log('WP_API_PASSWORD:', WP_API_PASSWORD ? 'Set' : 'Not set');

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'wordpress-mcp-railway',
    wp_url: WP_API_URL,
    node_version: process.version,
    endpoints: {
      health: '/health',
      proxy: '/wp-json/*'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    wp_configured: !!(WP_API_URL && WP_API_USERNAME && WP_API_PASSWORD),
    node_version: process.version
  });
});

// WordPress REST API proxy
app.all('/wp-json/*', async (req, res) => {
  if (!WP_API_URL || !WP_API_USERNAME || !WP_API_PASSWORD) {
    return res.status(500).json({
      error: 'WordPress credentials not configured',
      missing: {
        WP_API_URL: !WP_API_URL,
        WP_API_USERNAME: !WP_API_USERNAME,
        WP_API_PASSWORD: !WP_API_PASSWORD
      }
    });
  }

  try {
    const fetch = (await import('node-fetch')).default;
    
    const wpUrl = `${WP_API_URL.replace(/\/$/, '')}${req.path}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
    const auth = Buffer.from(`${WP_API_USERNAME}:${WP_API_PASSWORD}`).toString('base64');
    
    console.log(`Proxying ${req.method} request to: ${wpUrl}`);
    
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'WordPress-MCP-Railway/1.0'
      }
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }
    
    const response = await fetch(wpUrl, fetchOptions);
    const data = await response.json();
    
    res.status(response.status).json(data);
  } catch (error) {
    console.error('WordPress API Error:', error);
    res.status(500).json({
      error: 'WordPress API request failed',
      message: error.message,
      wp_url: WP_API_URL
    });
  }
});

app.listen(PORT, () => {
  console.log(`WordPress MCP Server running on port ${PORT}`);
  console.log(`Health check available at: http://localhost:${PORT}/health`);
});
