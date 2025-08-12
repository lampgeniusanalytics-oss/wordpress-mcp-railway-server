// index.js
// WordPress MCP + REST proxy on Railway

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const WP_API_URL = process.env.WP_API_URL;
const WP_API_USERNAME = process.env.WP_API_USERNAME;
const WP_API_PASSWORD = process.env.WP_API_PASSWORD;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

console.log('WordPress MCP Server starting...');
console.log('WP_API_URL:', WP_API_URL);
console.log('WP_API_USERNAME:', WP_API_USERNAME ? 'Set' : 'Not set');
console.log('WP_API_PASSWORD:', WP_API_PASSWORD ? 'Set' : 'Not set');

// -------------------- Health check endpoints --------------------
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'wordpress-mcp-railway',
    wp_url: WP_API_URL,
    node_version: process.version,
    endpoints: {
      health: '/health',
      proxy: '/wp-json/*',
      mcp: '/mcp'
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

// -------------------- WordPress REST API proxy --------------------
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

    // preserve path + querystring
    const base = WP_API_URL.replace(/\/$/, '');
    const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const wpUrl = `${base}${req.path}${query}`;
    const auth = Buffer.from(`${WP_API_USERNAME}:${WP_API_PASSWORD}`).toString('base64');

    console.log(`Proxying ${req.method} -> ${wpUrl}`);

    const fetchOptions = {
      method: req.method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'WordPress-MCP-Railway/1.0'
      }
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(wpUrl, fetchOptions);
    const text = await response.text();

    // Try to JSON-parse; if it fails, return raw text
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

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

// -------------------- MCP JSON-RPC endpoint (HTTP) --------------------
// Minimal MCP surface for clients like n8n/Claude
app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body || {};
  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const err = (code = -32601, message = 'Method not found') =>
    res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      // Handshake: advertise only what we actually support
      case 'initialize':
        return ok({
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'wordpress-mcp', version: '0.1.0' },
          capabilities: {
            tools: {} // omit resources/prompts here; we stub them below anyway
          }
        });

      // List available tools
      case 'tools/list':
        return ok({
          tools: [
            {
              name: 'wp_request',
              description: 'Call WordPress REST API via /wp-json using configured Basic Auth.',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Absolute WP REST path, e.g. /wp-json/wp/v2/posts' },
                  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
                  body: { type: 'object', description: 'JSON body for non-GET methods' }
                },
                required: ['path', 'method'],
                additionalProperties: false
              },
              outputSchema: { type: 'object' }
            }
          ]
        });

      // Execute a tool call
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (name !== 'wp_request') return err(-32601, 'Unknown tool: ' + name);

        if (!WP_API_URL || !WP_API_USERNAME || !WP_API_PASSWORD) {
          return ok({
            content: [
              { type: 'text', text: 'WordPress credentials not configured (WP_API_URL/USERNAME/PASSWORD).' }
            ]
          });
        }

        const fetch = (await import('node-fetch')).default;
        const auth = Buffer.from(`${WP_API_USERNAME}:${WP_API_PASSWORD}`).toString('base64');

        const path = (args?.path || '').startsWith('/') ? args.path : `/${args?.path || ''}`;
        const wpUrl = `${WP_API_URL.replace(/\/$/, '')}${path}`;

        const options = {
          method: (args?.method || 'GET').toUpperCase(),
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
            'User-Agent': 'WordPress-MCP-Railway/1.0'
          }
        };
        if (!['GET', 'HEAD'].includes(options.method) && args?.body) {
          options.body = JSON.stringify(args.body);
        }

        const resp = await fetch(wpUrl, options);
        const text = await resp.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        return ok({
          content: [
            { type: 'json', data: { status: resp.status, url: wpUrl, data } }
          ]
        });
      }

      // Friendly no-ops so probing clients don’t fail on startup
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });

      default:
        return err();
    }
  } catch (e) {
    console.error('MCP Internal Error:', e);
    return res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: e?.message || 'Internal error' }
    });
  }
});

// -------------------- Start server --------------------
app.listen(PORT, () => {
  console.log(`WordPress MCP Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
