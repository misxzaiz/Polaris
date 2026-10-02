import http from 'http';

const PORT = Number(process.argv[2] || 18999);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        remote: req.socket.remoteAddress,
        server: 'node test server',
        body: body || null,
      })
    );
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`node server listening on 0.0.0.0:${PORT}`, { pid: process.pid });
});
process.on('SIGINT', () => server.close(() => process.exit(0)));