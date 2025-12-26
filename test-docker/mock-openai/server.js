const http = require('http');

const models = {
  data: [
    { id: 'gpt-4o', object: 'model' },
    { id: 'gpt-4o-mini', object: 'model' },
    { id: 'gpt-3.5-turbo', object: 'model' }
  ]
};

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);

  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/v1/models' || req.url === '/models') {
    console.log('Returning model list...');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(models));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const PORT = 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock OpenAI API running on port ${PORT}`);
  console.log('Available endpoints:');
  console.log('  GET /v1/models');
  console.log('  GET /models');
});
