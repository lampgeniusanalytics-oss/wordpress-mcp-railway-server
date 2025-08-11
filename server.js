const { spawn } = require('child_process');

console.log('Starting WordPress MCP Proxy...');
console.log('Environment variables:');
console.log('WP_API_URL:', process.env.WP_API_URL);
console.log('WP_API_USERNAME:', process.env.WP_API_USERNAME ? 'Set' : 'Not set');

const mcpProcess = spawn('npx', ['@automattic/mcp-wordpress-remote@latest'], {
  stdio: 'inherit',
  env: process.env
});

mcpProcess.on('exit', (code) => {
  console.log(`MCP process exited with code ${code}`);
  process.exit(code);
});

mcpProcess.on('error', (error) => {
  console.error('Failed to start MCP process:', error);
  process.exit(1);
});
