# A Ponte — agente A2A com MCP

## Como subir

Requisitos: Node.js 20 ou superior com npm e Python 3.10 ou superior para o validador. Na raiz do clone, execute `npm ci`.

Terminal 1, servidor MCP em `http://127.0.0.1:7301/mcp`:

```sh
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
npm run mcp
```

No PowerShell, use `$env:REQUEST_STATE_SECRET = py -3 -c "import secrets; print(secrets.token_hex(32))"` antes de `npm run mcp`. Guarde a chave fora do Git e mantenha o mesmo valor ao reiniciar o servidor para retomar pedidos pendentes.

Terminal 2, agente A2A em `http://127.0.0.1:7300/a2a`:

```sh
npm run a2a
```

Em um terceiro terminal, consulte o Agent Card e execute o validador com os dois processos recém-iniciados:

```sh
curl http://127.0.0.1:7300/.well-known/agent-card.json
python3 validador/validar.py --agente http://127.0.0.1:7300 --mcp http://127.0.0.1:7301
```

No Windows, os equivalentes são `curl.exe` e `py -3`. Use `MCP_PORT` e `A2A_PORT` para alterar as portas, `MCP_URL` para indicar ao agente o endpoint do MCP e `A2A_URL` para definir a URL pública anunciada no card.

## Onde a ponte acontece

Em [agente/server.mjs](agente/server.mjs), `aplicarResultado` recebe o `input_required`, guarda o `requestState`, a chave da elicitation e as alternativas no registro interno da Task e publica `TASK_STATE_INPUT_REQUIRED` com a linha de alternativas. Quando `sendMessage` recebe uma escolha válida ou recusa com o mesmo `taskId`, reenvia a chamada original com `requestState` e `inputResponses`. O cliente em [agente/mcp.mjs](agente/mcp.mjs) gera um novo id JSON-RPC a cada request, incluindo a retomada.

## Decisões técnicas

- O servidor usa o SDK oficial MCP v2 com Streamable HTTP stateless. O codec do SDK assina o pedido original e as alternativas com HMAC-SHA256 e expiração de 10 minutos. O retry usa os argumentos assinados e verifica se a alternativa continua livre. O token continua válido após reinício com a mesma chave.
- O agente mantém as Tasks e o estado das pausas em memória. O MCP mantém as reservas em memória e carrega os dados iniciais a cada subida. Os dois processos executam regras determinísticas.
- O agente descobre a ferramenta por `tools/list` e lê a versão da política em `politica://uso`. O servidor registra método, id e `traceparent` no stderr. A mesma Task mantém o contexto de trace na descoberta, na chamada inicial e na retomada.

## Saída do validador

```text

trace-id desta execucao: fcabcc6157d9359d1007aced537ba48d
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
