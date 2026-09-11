'use strict';
// UserPromptSubmit hook do plugin prompt-refiner.
//   block  : hook síncrono. Bloqueia a mensagem original (decision "block" a remove do contexto).
//   rewake : hook asyncRewake. Reescreve a mensagem e a entrega ao Claude pelo stderr com exit 2.
// A entrega do rewake volta a passar por UserPromptSubmit; MARKER e o registro de entregas
// fazem os dois modos deixá-la seguir sem reescrever de novo.
// argv[3] é ${CLAUDE_PLUGIN_DATA}: estado da statusline, cache, fila de ordem e log.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '<!-- prompt-refiner:encaminhado -->';
const HEADER = 'Mensagem enviada pelo usuário, reescrita pelo plugin prompt-refiner. A mensagem original foi substituída por este texto:';
const ESCAPE_PREFIX = '='; // mensagem começando com "=" segue literal, sem reescrita
const MODEL = 'sonnet';
const EFFORT = 'medium';
const CHILD_DEADLINE_MS = 240000; // abaixo do timeout de 300 s do hook em hooks.json
const ORDER_WAIT_MS = 60000; // espera máxima pela entrega de uma mensagem anterior
const ORDER_STALE_MS = 300000; // ticket mais velho que isso é abandonado
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const CONTEXT_MAX_CHARS = 2000;
const TRANSCRIPT_TAIL_BYTES = 262144;
const DELIVERED_KEEP = 5;
const DELIVERED_HEAD_CHARS = 200;
const SYSTEM_PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'reformulacao.md');

const mode = process.argv[2];
const rawDataDir = process.argv[3] || '';
// Placeholder não substituído (plugin carregado de um jeito que não expande
// ${CLAUDE_PLUGIN_DATA}) não pode virar nome de diretório. Cai no caminho que a
// documentação declara para esse diretório, `~/.claude/plugins/data/{id}/`, para
// estado, cache, fila e log não sumirem em silêncio.
function fallbackDataDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'plugins', 'data', 'prompt-refiner');
}
const dataDir = (!rawDataDir || rawDataDir.includes('$')) ? fallbackDataDir() : rawDataDir;
const startedAt = Date.now();
let prompt = '';
let sessionId = '';
let transcriptPath = '';
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (typeof input.prompt === 'string') prompt = input.prompt;
  if (typeof input.session_id === 'string') sessionId = input.session_id;
  if (typeof input.transcript_path === 'string') transcriptPath = input.transcript_path;
} catch (e) {
  prompt = ''; // entrada ilegível: passa direto, a mensagem original segue sem bloqueio
}

const slug = sessionId.replace(/[^A-Za-z0-9_-]/g, '-');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// Nada de estado, cache, fila ou log pode interromper o fluxo da mensagem.
const quiet = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
const dataPath = (...parts) => path.join(dataDir, ...parts);

function writeState(status, extra) {
  if (!dataDir || !slug) return;
  quiet(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataPath(`state-${slug}.json`), JSON.stringify(Object.assign({ status, ts: Date.now() }, extra)));
  });
}

function prune() {
  if (!dataDir) return;
  quiet(() => {
    for (const name of fs.readdirSync(dataDir)) {
      if (!name.startsWith('state-')) continue;
      const file = dataPath(name);
      if (Date.now() - fs.statSync(file).mtimeMs > STATE_TTL_MS) fs.unlinkSync(file);
    }
  });
  quiet(() => {
    for (const name of fs.readdirSync(dataPath('cache'))) {
      const file = dataPath('cache', name);
      if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) fs.unlinkSync(file);
    }
  });
  quiet(() => {
    for (const name of fs.readdirSync(dataPath('pending', slug))) {
      const file = dataPath('pending', slug, name);
      if (Date.now() - fs.statSync(file).mtimeMs > ORDER_STALE_MS) fs.unlinkSync(file);
    }
  });
}

// --- registro de entregas: segundo guarda do passthrough ---------------------
// O MARKER é o guarda primário. Se um dia o envelope do Claude Code deixar de
// repassar o comentário HTML, o trecho inicial do texto já entregue ainda
// identifica a reentrada e evita reescrever (e pagar) a mesma mensagem em laço.
function deliveredEntries() {
  return quiet(() => {
    const raw = JSON.parse(fs.readFileSync(dataPath(`delivered-${slug}.json`), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  }, []);
}

function recordDelivered(body) {
  if (!dataDir || !slug) return;
  quiet(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    const entries = deliveredEntries();
    entries.push({ head: body.slice(0, DELIVERED_HEAD_CHARS), ts: Date.now() });
    fs.writeFileSync(dataPath(`delivered-${slug}.json`), JSON.stringify(entries.slice(-DELIVERED_KEEP)));
  });
}

function wasDelivered(text) {
  if (!dataDir || !slug) return false;
  return deliveredEntries().some((e) => e && typeof e.head === 'string' && e.head.length >= 40 && text.includes(e.head));
}

// --- ordem de entrega -------------------------------------------------------
// Duas mensagens enviadas dentro da janela de reescrita terminam em ordem
// imprevisível. O ticket é tirado na entrada do hook (ordem de envio) e a
// entrega espera os tickets mais antigos saírem.
function claimTicket() {
  if (!dataDir || !slug) return null;
  return quiet(() => {
    const dir = dataPath('pending', slug);
    fs.mkdirSync(dir, { recursive: true });
    const ticket = { ts: startedAt, file: path.join(dir, `${startedAt}-${sha256(prompt).slice(0, 8)}.tkt`) };
    fs.writeFileSync(ticket.file, '');
    return ticket;
  }, null);
}

function waitTurn(ticket, done) {
  if (!ticket) return done();
  const deadline = Date.now() + ORDER_WAIT_MS;
  const tick = () => {
    const blocked = quiet(() => fs.readdirSync(path.dirname(ticket.file)).some((name) => {
      if (!name.endsWith('.tkt') || name === path.basename(ticket.file)) return false;
      const ts = Number(name.split('-')[0]);
      return Number.isFinite(ts) && ts < ticket.ts && Date.now() - ts < ORDER_STALE_MS;
    }), false);
    if (!blocked || Date.now() > deadline) return done();
    setTimeout(tick, 200);
  };
  tick();
}

const releaseTicket = (ticket) => { if (ticket) quiet(() => fs.unlinkSync(ticket.file)); };

// --- cache ------------------------------------------------------------------
const cacheFile = (key) => dataPath('cache', `${key}.txt`);

function cacheGet(key) {
  if (!dataDir) return null;
  return quiet(() => {
    const file = cacheFile(key);
    if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) return null;
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : null;
  }, null);
}

function cacheSet(key, text) {
  if (!dataDir) return;
  quiet(() => {
    fs.mkdirSync(dataPath('cache'), { recursive: true });
    fs.writeFileSync(cacheFile(key), text);
  });
}

// --- log de auditoria -------------------------------------------------------
function appendLog(entry) {
  if (!dataDir) return;
  quiet(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = dataPath('log.jsonl');
    if (quiet(() => fs.statSync(file).size, 0) > LOG_MAX_BYTES) fs.renameSync(file, dataPath('log.prev.jsonl'));
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  });
}

// --- contexto da conversa ---------------------------------------------------
// Mensagem de sessão real é elíptica ("pode", "faz isso", "e o outro arquivo?").
// Sem o turno anterior, a reescrita só conserta ortografia. O texto abaixo serve
// exclusivamente para resolver referência; as regras de uso estão no system prompt.
function lastAssistantText() {
  if (!transcriptPath) return '';
  return quiet(() => {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      const entry = quiet(() => JSON.parse(line), null);
      if (!entry || entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) continue;
      const text = entry.message.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) return text.slice(-CONTEXT_MAX_CHARS);
    }
    return '';
  }, '');
}

// --- fluxo ------------------------------------------------------------------
function passThrough(text) {
  const t = text.trimStart();
  if (t === '' || t.startsWith('/') || t.startsWith('!') || t.startsWith(ESCAPE_PREFIX)) return true;
  return text.includes(MARKER) || wasDelivered(text);
}

function deliver(text) {
  process.stderr.write(`${MARKER}\n${HEADER}\n\n${text}`);
  process.exitCode = 2;
}

function rewrite(text, context, done) {
  let finished = false;
  let out = '';
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(result);
  };
  const child = spawn('claude', [
    '-p', '--safe-mode', '--tools', '', '--no-session-persistence',
    '--model', MODEL, '--effort', EFFORT,
    '--system-prompt-file', SYSTEM_PROMPT_FILE,
  ], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const timer = setTimeout(() => { child.kill(); finish(null); }, CHILD_DEADLINE_MS);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code === 0 && out.trim() ? out.trim() : null));
  child.stdin.on('error', () => finish(null));
  const contextBlock = context ? `<contexto_conversa>\n${context}\n</contexto_conversa>\n\n` : '';
  child.stdin.end(`${contextBlock}<mensagem_original>\n${text}\n</mensagem_original>\n`);
}

if (passThrough(prompt)) {
  process.exit(0);
} else if (mode === 'block') {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'refinando a mensagem',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
  }));
} else if (mode === 'rewake') {
  prune();
  writeState('rewriting');
  const ticket = claimTicket();
  const context = lastAssistantText();
  const key = sha256(`${MODEL}|${EFFORT}|${context}|${prompt}`);

  // Qualquer falha entrega a mensagem original sem alteração, para ela não se perder.
  const settle = (result, status) => {
    const body = result === null ? prompt : result;
    const ms = Date.now() - startedAt;
    if (result !== null && status === 'ok') cacheSet(key, result);
    writeState(status, { ms });
    recordDelivered(body);
    appendLog({ ts: new Date().toISOString(), session: sessionId, status, ms, context_chars: context.length, original: prompt, refined: body });
    waitTurn(ticket, () => { releaseTicket(ticket); deliver(body); });
  };

  try {
    const cached = cacheGet(key);
    if (cached) settle(cached, 'cache');
    else rewrite(prompt, context, (result) => settle(result, result === null ? 'fallback' : 'ok'));
  } catch (e) {
    settle(null, 'fallback');
  }
}
