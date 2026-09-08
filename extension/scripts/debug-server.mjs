#!/usr/bin/env node
/**
 * Local debug sink for Figma Sites Exporter.
 * Extension POSTs JSON logs to http://127.0.0.1:8788/log
 * This process prints them live and keeps a ring buffer.
 *
 *   npm run extension:debug-server
 */
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.FSE_DEBUG_PORT || 8788);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_DIR = path.join(ROOT, 'rehearsal/extension-debug');
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

const recent = [];
const MAX = 500;
const sseClients = new Set();

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function accept(entry) {
  const row = {
    t: new Date().toISOString(),
    ...entry,
  };
  recent.push(row);
  if (recent.length > MAX) recent.shift();
  try {
    appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  } catch { /* ignore */ }

  const line = `[${stamp()}] ${row.level || 'info'} ${row.source || '?'} ${row.message || ''} ${
    row.data != null ? JSON.stringify(row.data) : ''
  }`;
  console.log(line);

  const payload = `data: ${JSON.stringify(row)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS for extension / page
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: sseClients.size, recent: recent.length, logFile: LOG_FILE }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/recent') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recent.slice(-100), null, 2));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ hello: true, t: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/log') {
    try {
      const raw = await readBody(req);
      const text = raw.toString('utf8') || '{}';
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
      if (Array.isArray(body)) {
        for (const item of body) accept(typeof item === 'object' ? item : { message: String(item) });
      } else {
        accept(body);
      }
      res.writeHead(204);
      res.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset=utf-8><title>FSE Debug</title>
      <pre id=o></pre>
      <script>
        const o=document.getElementById('o');
        const es=new EventSource('/stream');
        es.onmessage=(ev)=>{ o.textContent += ev.data + '\\n'; o.scrollTop=o.scrollHeight; };
      </script>`);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fse-debug] listening http://127.0.0.1:${PORT}`);
  console.log(`[fse-debug] log file ${LOG_FILE}`);
  console.log(`[fse-debug] waiting for extension logs…`);
  accept({ source: 'debug-server', level: 'info', message: 'server_started', data: { port: PORT } });
});
