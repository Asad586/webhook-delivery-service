const http = require('node:http');

const port = Number(process.argv[2] || 4001);
const mode = process.argv[3] || 'ok'; // ok | fail | flaky | slow

let count = 0;

http
  .createServer((req, res) => {
    count++;
    const id = req.headers['x-webhook-event-id'];
    console.log(`[${port}] #${count} event=${id} mode=${mode}`);

    if (mode === 'fail') {
      res.writeHead(500).end('nope');
      return;
    }
    if (mode === 'flaky' && count < 4) {
      res.writeHead(503).end('try again');
      return;
    }
    if (mode === 'slow') {
      setTimeout(() => res.writeHead(200).end('ok'), 15000);
      return;
    }
    res.writeHead(200).end('ok');
  })
  .listen(port, () => console.log(`stub subscriber on ${port} mode=${mode}`));
