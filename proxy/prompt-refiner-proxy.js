'use strict';
// Proxy local do prompt-refiner.
//
// Garante a substituição: o modelo recebe a versão reescrita da mensagem no
// lugar da original, e o Claude Code não mostra nada, porque a troca acontece
// depois da interface, no corpo da requisição.
//
// O hook do plugin (modo proxy) reescreve a mensagem antes do turno começar e
// grava `swap/<sha256 do texto original>.txt`. Este processo procura esse
// arquivo para cada bloco de texto de mensagem `user` e troca o conteúdo.
// A troca é determinística: o mesmo texto original vira sempre a mesma
// reescrita, então o histórico reenviado a cada turno não oscila.
//
// Contrato que o Claude Code espera de um gateway em ANTHROPIC_BASE_URL
// (docs/en/llm-gateway-protocol): endpoints `/v1/messages` e
// `/v1/messages/count_tokens`, tráfego de startup `HEAD /api/hello` e
// `GET /v1/models`, repasse de `anthropic-version` e `anthropic-beta` sem
// alteração (é no `anthropic-beta` que vai a capability de OAuth, o que mantém
// a assinatura claude.ai como credencial), e streaming relado byte a byte,
// pings inclusive, sem bufferizar.
//
// Falha sempre para o lado de não mexer: qualquer erro de parse, arquivo
// ausente ou corpo comprimido faz a requisição seguir exatamente como veio.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PROMPT_REFINER_PROXY_PORT || 8787);
const UPSTREAM_HOST = process.env.PROMPT_REFINER_UPSTREAM || 'api.anthropic.com';
const LOG_ONLY = process.argv.includes('--log-only');
const DUMP_DIR = process.env.PROMPT_REFINER_DUMP_DIR || '';

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// O diretório de dados do plugin carrega o id com caracteres fora de
// [A-Za-z0-9_-] trocados por "-", e o id depende do marketplace de instalação.
function swapDirs() {
  if (process.env.PROMPT_REFINER_SWAP_DIR) return [process.env.PROMPT_REFINER_SWAP_DIR];
  const base = path.join(configDir(), 'plugins', 'data');
  try {
    return fs.readdirSync(base)
      .filter((name) => name.includes('prompt-refiner'))
      .map((name) => path.join(base, name, 'swap'));
  } catch (e) {
    return [];
  }
}

const SWAP_DIRS = swapDirs();
const LOG_FILE = path.join(path.dirname(SWAP_DIRS[0] || path.join(configDir(), 'plugins', 'data', 'prompt-refiner')), 'proxy.jsonl');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const quiet = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

function logLine(entry) {
  quiet(() => {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry))}\n`);
  });
}

function lookupSwap(text) {
  const key = sha256(text.trim());
  for (const dir of SWAP_DIRS) {
    const found = quiet(() => {
      const value = fs.readFileSync(path.join(dir, `${key}.txt`), 'utf8');
      return value.trim() ? value : null;
    }, null);
    if (found) return found;
  }
  return null;
}

// Troca todo bloco de texto de mensagem `user` que tenha reescrita gravada,
// inclusive nos turnos antigos do histórico, para o modelo nunca ver o original.
// Bloco que não é `type: "text"` (tool_result, image) nunca é tocado.
function rewriteBody(buffer) {
  const json = quiet(() => JSON.parse(buffer.toString('utf8')), null);
  if (!json || !Array.isArray(json.messages)) return null;
  let swapped = 0;
  for (const message of json.messages) {
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      const refined = lookupSwap(message.content);
      if (refined) { message.content = refined; swapped++; }
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      const refined = lookupSwap(block.text);
      if (refined) { block.text = refined; swapped++; }
    }
  }
  if (!swapped) return null;
  return { body: Buffer.from(JSON.stringify(json), 'utf8'), swapped };
}

function dump(name, buffer) {
  if (!DUMP_DIR) return;
  quiet(() => {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(DUMP_DIR, name), buffer);
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const pathOnly = req.url.split('?')[0];
    const isInference = req.method === 'POST' && pathOnly === '/v1/messages';
    const encoded = !!req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity';
    let swapped = 0;

    if (isInference && body.length) dump(`req-${Date.now()}-in.json`, body);

    if (isInference && body.length && !encoded && !LOG_ONLY) {
      const result = rewriteBody(body);
      if (result) { body = result.body; swapped = result.swapped; }
    }

    if (isInference && body.length && swapped) dump(`req-${Date.now()}-out.json`, body);

    const headers = Object.assign({}, req.headers, { host: UPSTREAM_HOST });
    delete headers['transfer-encoding'];
    if (body.length) headers['content-length'] = String(body.length);
    else delete headers['content-length'];

    const upstream = https.request({
      host: UPSTREAM_HOST, port: 443, method: req.method, path: req.url, headers,
    }, (up) => {
      if (isInference) logLine({ path: pathOnly, status: up.statusCode, swapped, bytes: body.length, log_only: LOG_ONLY });
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res); // streaming relado como chega, pings inclusive
    });
    upstream.on('error', (e) => {
      logLine({ path: pathOnly, error: e.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `prompt-refiner proxy: ${e.message}` } }));
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });
  req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end(); });
});

// Só escuta quando executado direto, para a lógica de troca poder ser testada
// sem subir servidor nenhum: `require` deste arquivo não abre porta.
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`prompt-refiner proxy em http://127.0.0.1:${PORT} -> https://${UPSTREAM_HOST}${LOG_ONLY ? ' (modo --log-only: nada e trocado)' : ''}\nswap: ${SWAP_DIRS.join(', ') || '(nenhum diretorio encontrado)'}\nlog: ${LOG_FILE}\n`);
  });
}

module.exports = { rewriteBody, lookupSwap, sha256, SWAP_DIRS };
