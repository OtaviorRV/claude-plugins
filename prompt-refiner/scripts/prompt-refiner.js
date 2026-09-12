'use strict';
// UserPromptSubmit hook do plugin prompt-refiner.
//
// Um hook síncrono, sem bloqueio: reescreve a mensagem do usuário e devolve o
// texto em `additionalContext`. Esse canal não produz entrada visível para o
// usuário (hooks.md, "UserPromptSubmit decision control"), então a sessão fica
// sem linha de aviso, sem notificação e sem turno extra.
//
// A versão 0.1.0 bloqueava a mensagem original com `decision: "block"` e
// entregava o texto reescrito por um hook `asyncRewake`. Isso substituía a
// mensagem de fato, mas bloquear é visível por construção: cada mensagem
// mostrava `UserPromptSubmit operation blocked by hook:` e uma notificação
// `Stop hook feedback`. Trocado por decisão do usuário: silêncio vale mais que
// substituição. Consequência declarada: o modelo vê as duas versões, a digitada
// e a reescrita.
//
// argv[2] é ${CLAUDE_PLUGIN_DATA}: estado da statusline, cache e log.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '<!-- prompt-refiner:encaminhado -->';
const HEADER = 'Versão reescrita desta mensagem do usuário, produzida pelo plugin prompt-refiner a partir do texto que ele enviou neste turno: mesmo conteúdo, redação corrigida, referências resolvidas. É a formulação que vale para a tarefa; o texto digitado permanece como original.';
const ESCAPE_PREFIX = '='; // mensagem começando com "=" não é reescrita
const MODEL = 'sonnet';
const EFFORT = 'medium';
const CHILD_DEADLINE_MS = 90000; // abaixo do timeout de 120 s do hook em hooks.json
const MAX_CONTEXT_CHARS = 9500; // acima de 10.000 o Claude Code troca o texto por prévia + caminho de arquivo
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const CONTEXT_MAX_CHARS = 2000;
const TRANSCRIPT_TAIL_BYTES = 262144;
const SYSTEM_PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'reformulacao.md');

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
  prompt = ''; // entrada ilegível: nada a reescrever, a mensagem segue como veio
}

// Placeholder não substituído não pode virar nome de diretório. Cai no caminho
// que a documentação declara para esse diretório, `~/.claude/plugins/data/{id}/`.
function fallbackDataDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'plugins', 'data', 'prompt-refiner');
}
const rawDataDir = process.argv[2] || '';
const dataDir = (!rawDataDir || rawDataDir.includes('$')) ? fallbackDataDir() : rawDataDir;

const slug = sessionId.replace(/[^A-Za-z0-9_-]/g, '-');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// Nada de estado, cache ou log pode atrapalhar a mensagem.
const quiet = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
const dataPath = (...parts) => path.join(dataDir, ...parts);

function writeState(status, extra) {
  if (!slug) return;
  quiet(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataPath(`state-${slug}.json`), JSON.stringify(Object.assign({ status, ts: Date.now() }, extra)));
  });
}

function prune() {
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
  // Restos da 0.1.0, que precisava deles para ordenar entregas e barrar reentrada.
  quiet(() => {
    for (const name of fs.readdirSync(dataDir)) {
      if (name.startsWith('delivered-')) fs.unlinkSync(dataPath(name));
    }
  });
  quiet(() => fs.rmSync(dataPath('pending'), { recursive: true, force: true }));
}

const cacheFile = (key) => dataPath('cache', `${key}.txt`);

function cacheGet(key) {
  return quiet(() => {
    const file = cacheFile(key);
    if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) return null;
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : null;
  }, null);
}

function cacheSet(key, text) {
  quiet(() => {
    fs.mkdirSync(dataPath('cache'), { recursive: true });
    fs.writeFileSync(cacheFile(key), text);
  });
}

function appendLog(entry) {
  quiet(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = dataPath('log.jsonl');
    if (quiet(() => fs.statSync(file).size, 0) > LOG_MAX_BYTES) fs.renameSync(file, dataPath('log.prev.jsonl'));
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  });
}

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

function passThrough(text) {
  const t = text.trimStart();
  if (t === '' || t.startsWith('/') || t.startsWith('!') || t.startsWith(ESCAPE_PREFIX)) return true;
  // Texto do próprio harness também chega por este evento: notificação de tarefa
  // em background, lembrete de sistema, retorno de hook. Reescrever isso gasta
  // uma chamada de modelo por notificação e não melhora pedido nenhum.
  if (t.startsWith('<task-notification>') || t.startsWith('<system-reminder>')) return true;
  return text.includes(MARKER);
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
}

prune();
writeState('rewriting');
const context = lastAssistantText();
const key = sha256(`${MODEL}|${EFFORT}|${context}|${prompt}`);

// Falha, prazo estourado ou texto acima do limite de injeção não injetam nada:
// a mensagem original segue sozinha, que é o comportamento de antes do plugin.
function settle(result, status) {
  const ms = Date.now() - startedAt;
  const tooLong = result !== null && result.length > MAX_CONTEXT_CHARS;
  const finalStatus = tooLong ? 'skipped' : status;
  if (result !== null && status === 'ok' && !tooLong) cacheSet(key, result);
  writeState(finalStatus, { ms });
  appendLog({
    ts: new Date().toISOString(), session: sessionId, status: finalStatus, ms,
    context_chars: context.length, original: prompt, refined: result === null ? '' : result,
  });
  if (result === null || tooLong) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${MARKER}\n${HEADER}\n\n${result}`,
    },
  }));
}

try {
  const cached = cacheGet(key);
  if (cached) settle(cached, 'cache');
  else rewrite(prompt, context, (result) => settle(result, result === null ? 'fallback' : 'ok'));
} catch (e) {
  settle(null, 'fallback');
}
