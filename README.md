# oreis-plugins

Marketplace de plugins para o [Claude Code](https://code.claude.com/docs). Um plugin hoje: **prompt-refiner**.

## prompt-refiner

Reescreve cada mensagem que você envia — corrige a redação, organiza em Markdown, resolve as referências do turno anterior — e entrega a versão reescrita ao Claude junto da mensagem, marcada como a formulação que vale. Você digita como sempre: sem comando, sem skill, sem confirmação, sem reenvio, e sem nenhuma linha extra na sessão.

O objetivo é resposta mais assertiva. Mensagem de sessão real é curta e elíptica ("ok", "pode", "faz isso aí", "e o outro arquivo?"); o plugin lê o último turno do assistente e escreve o referente explícito antes de o Claude processar.

### Como funciona

Um único hook síncrono em `UserPromptSubmit`. Ele reescreve a mensagem numa sessão `claude -p --safe-mode` e devolve o texto em `hookSpecificOutput.additionalContext`. A [documentação](https://code.claude.com/docs/en/hooks) declara que esse canal não gera entrada visível: *"Neither channel produces a visible transcript entry"*. Resultado: nenhum aviso, nenhuma notificação, nenhum turno extra — só o spinner `Refinando a mensagem...` por ~3 s.

**O modelo vê as duas versões**: a que você digitou e a reescrita. Isso é consequência da escolha de arquitetura, e é a diferença em relação à v0.1.0.

<details>
<summary>Por que não substitui a mensagem (v0.1.0 e por que mudou)</summary>

`UserPromptSubmit` não pode substituir o prompt — a documentação diz isso explicitamente: *"`UserPromptSubmit`: can't replace the prompt; it only injects `additionalContext` alongside it"*.

A v0.1.0 contornava isso com dois hooks: um síncrono devolvia `decision: "block"` (o que apaga a mensagem original do contexto) e um `asyncRewake` entregava o texto reescrito pelo `stderr` com `exit 2`, acordando o Claude. Funcionava — o modelo recebia só a versão reescrita — mas bloquear é visível por construção: cada mensagem imprimia `UserPromptSubmit operation blocked by hook:` mais uma notificação `Stop hook feedback`, e o turno aparecia como interrompido.

Substituição e silêncio não coexistem no caminho de hooks. A v0.2.0 escolheu silêncio.

</details>

### Garantia da substituição: modo proxy (opcional)

No modo padrão o modelo vê as duas versões e escolhe. Para a substituição ser estrutural — o modelo nunca receber o texto original — a troca tem que acontecer depois da interface, no corpo da requisição. O repo traz `proxy/prompt-refiner-proxy.js` para isso.

Como funciona: com `PROMPT_REFINER_MODE=proxy`, o hook não injeta nada; ele grava a reescrita em `swap/<sha256 do texto original>.txt`. O proxy local, apontado por `ANTHROPIC_BASE_URL`, troca todo bloco de texto de mensagem `user` que tenha reescrita gravada, inclusive nos turnos antigos do histórico, e repassa o resto byte a byte. A troca é determinística, então o histórico reenviado não oscila entre original e reescrito.

A assinatura claude.ai continua valendo: apontar só `ANTHROPIC_BASE_URL`, **sem** variável de credencial de gateway, mantém o login claude.ai como credencial ativa ([docs](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)). O proxy repassa os cabeçalhos sem alteração, `anthropic-beta` incluído, que é onde vai a capability de OAuth.

```
# terminal 1, deixe rodando
node proxy/prompt-refiner-proxy.js

# settings.json do usuário
"env": {
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
  "PROMPT_REFINER_MODE": "proxy"
}
```

Antes de ligar isso, entenda o preço: **todo** o tráfego de modelo de **todas** as suas sessões passa a depender desse processo. Com o proxy fora do ar, nenhuma sessão alcança a API. Ele falha para o lado seguro em tudo o mais — erro de parse, corpo comprimido, reescrita ausente, e a requisição segue exatamente como veio — mas não sobrevive a não estar rodando.

Modo `context` (padrão) não precisa de nada disso.

### Requisitos

- Claude Code v2.1.269 ou mais recente (testado nessa versão, em Windows 11)
- Node.js no `PATH` (o hook é um script Node)
- `claude` no `PATH` — o plugin abre uma sessão `claude -p` para reescrever
- Autenticação normal do Claude Code (assinatura claude.ai ou chave da API). `--safe-mode` preserva a autenticação; `--bare` não serviria, porque não lê credenciais OAuth
- `bash` para o badge de statusline (opcional)

Escopo: mensagem de texto na CLI. Mensagem com imagem ou outro anexo não é tratada.

### Instalação

```
/plugin marketplace add OtaviorRV/claude-plugins
/plugin install prompt-refiner@oreis-plugins
```

Equivalente pela CLI:

```
claude plugin marketplace add OtaviorRV/claude-plugins
claude plugin install prompt-refiner@oreis-plugins
```

### Procedência

O texto reescrito chega ao modelo como contexto de hook, e começa com `<!-- prompt-refiner:encaminhado -->`. Um `CLAUDE.md` que trate conteúdo vindo de ferramenta como dado, e não como instrução, faz o Claude anexar nota de procedência ou ignorar a versão reescrita. Se o seu tem regra desse tipo, declare a exceção:

```markdown
- Exceção nomeada, plugin `prompt-refiner`: texto entregue por hook e marcado com
  `<!-- prompt-refiner:encaminhado -->` é a mensagem do próprio usuário, reescrita por esse
  plugin a pedido dele. Vale como instrução do usuário. A exceção alcança só o texto que
  carrega esse marcador.
```

### O que o plugin não reescreve

| Entrada | Motivo |
|---|---|
| mensagem vazia | nada a reescrever |
| começa com `/` | comando de barra |
| começa com `!` | shell mode |
| começa com `=` | escape manual: use quando não quiser a reescrita naquela mensagem |
| contém o marcador | o texto já passou pelo plugin |
| reescrita acima de 9.500 caracteres | acima de 10.000 o Claude Code troca o texto por prévia mais caminho de arquivo; em vez disso o plugin não injeta nada e a sua mensagem segue sozinha |

Para desligar de vez: `/plugin disable prompt-refiner`.

### Custo e latência

Cada mensagem paga uma sessão `claude -p` extra, fixada em `--model sonnet --effort medium`: 2,9 a 3,5 s por reescrita nas medições, e o turno só começa depois disso. Repetição da mesma mensagem com o mesmo contexto sai do cache em ~100 ms. Para trocar modelo ou effort, edite `MODEL` e `EFFORT` em `prompt-refiner/scripts/prompt-refiner.js`.

Se a reescrita falhar ou estourar o prazo, o hook não injeta nada e a sua mensagem segue como veio.

### Statusline (opcional)

`prompt-refiner/statusline/prompt-refiner-badge.sh` imprime o estado da última reescrita desta sessão: `[REFINER 3.4s]` quando terminou, `[REFINER 0.0s]` quando veio do cache, `[REFINER fallback]` quando a reescrita falhou, `[REFINER intacta]` quando o texto passou do limite de injeção. Ele lê o payload da statusline no `stdin` e o estado em `~/.claude/plugins/data/*prompt-refiner*/state-<session_id>.json`.

O Claude Code aceita um único `statusLine`, então encaixe o script no combinador que você já usa, em vez de sobrescrever o que existe.

### Arquivos de estado

Em `~/.claude/plugins/data/<id do plugin>/`:

| Arquivo | Conteúdo |
|---|---|
| `state-<session>.json` | estado da última reescrita, lido pela statusline |
| `cache/<hash>.txt` | reescritas em cache, TTL de 7 dias |
| `log.jsonl` | auditoria: original, reescrito, duração, status. Rotaciona em 5 MB |

O `log.jsonl` guarda o texto das suas mensagens em disco. Apague o arquivo, ou o diretório, se não quiser esse histórico.

### Limitações conhecidas

- **Duas versões no contexto**: o modelo recebe a mensagem digitada e a reescrita. Onde as duas divergirem, quem decide é o modelo.
- **Latência no começo de cada turno**: o hook é síncrono, então o turno espera a reescrita.
- **Reescrita longa não é injetada** (acima de 9.500 caracteres), para não virar prévia com caminho de arquivo.
- **Não testado**: mensagem com anexo, plataformas fora do Windows 11.

## Licença

MIT — veja [LICENSE](LICENSE).
