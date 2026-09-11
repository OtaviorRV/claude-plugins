#!/usr/bin/env bash
# Badge [REFINER] para a statusline: mostra o estado da última reescrita DESTA sessão.
#
# O estado é escrito pelo hook em ${CLAUDE_PLUGIN_DATA}/state-<session_id>.json.
# O diretório de dados carrega o id do plugin com caracteres fora de
# [A-Za-z0-9_-] trocados por "-", então o nome exato depende do marketplace de
# instalação; o glob evita depender dessa mangling.
#
# Nada aqui pode falhar de forma visível: exit != 0 ou hang derruba a barra
# inteira, incluindo os badges que não são deste plugin.

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD="$(cat 2>/dev/null)"
fi

SID="$(printf '%s' "$PAYLOAD" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$SID" ] || exit 0

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE=""
for cand in "$CLAUDE_DIR"/plugins/data/*prompt-refiner*/state-"$SID".json; do
  [ -f "$cand" ] && STATE="$cand"
done
[ -n "$STATE" ] || exit 0

CONTENT="$(cat "$STATE" 2>/dev/null)"
STATUS="$(printf '%s' "$CONTENT" | grep -o '"status":"[a-z]*"' | head -1 | sed 's/.*:"\(.*\)"/\1/')"
MS="$(printf '%s' "$CONTENT" | grep -o '"ms":[0-9]*' | head -1 | sed 's/.*://')"

MTIME="$(stat -c %Y "$STATE" 2>/dev/null || echo 0)"
NOW="$(date +%s)"
AGE=$(( NOW - MTIME ))

case "$STATUS" in
  rewriting)
    # Estado preso (processo morto no meio) não fica piscando para sempre.
    [ "$AGE" -lt 300 ] && printf '[REFINER ...]'
    ;;
  ok|cache)
    if [ -n "$MS" ]; then
      printf '[REFINER %d.%ds]' "$(( MS / 1000 ))" "$(( (MS % 1000) / 100 ))"
    else
      printf '[REFINER]'
    fi
    ;;
  fallback)
    printf '[REFINER fallback]'
    ;;
esac

exit 0
