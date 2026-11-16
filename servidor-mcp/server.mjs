import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createMcpHandler, createRequestStateCodec, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const read = name => readFileSync(new URL('../dados/' + name, import.meta.url), 'utf8');
const salas = JSON.parse(read('salas.json'));
const reservas = JSON.parse(read('reservas.json'));
const politica = read('politica-de-uso.md');
const versao = politica.split(/\r?\n/, 1)[0].split(':')[1].trim();
const uri = 'politica://uso';
const secret = process.env.REQUEST_STATE_SECRET ?? '';
if (!/^[0-9a-f]{64,}$/i.test(secret) || secret.length % 2) {
    throw new Error('REQUEST_STATE_SECRET deve conter pelo menos 32 bytes em hexadecimal');
}
const codec = createRequestStateCodec({ key: Buffer.from(secret, 'hex'), ttlSeconds: 600 });
const escolha = 'escolha_de_sala';
const intervalo = z.object({ sala: z.string(), inicio: z.string(), fim: z.string() });
const pedido = intervalo.extend({ responsavel: z.string() });
const salaSchema = z.object({
    id: z.string(), nome: z.string(), capacidade: z.number().int(), recursos: z.array(z.string())
});
const dia = 86_400_000;
const hora = 3_600_000;
const completo = structuredContent => ({
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }]
});
const erro = text => ({ isError: true, content: [{ type: 'text', text }] });

function validar({ sala, inicio, fim }) {
    if (!salas.some(item => item.id === sala)) return 'Sala inexistente: ' + sala;
    const a = Date.parse(inicio);
    const b = Date.parse(fim);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !/(Z|[+-]\d\d:\d\d)$/i.test(inicio) || !/(Z|[+-]\d\d:\d\d)$/i.test(fim)) {
        return 'Intervalo invalido: use ISO 8601 com fuso horario';
    }
    if (b <= a) return 'Intervalo invalido: fim deve ser posterior a inicio';
    const localA = a - 3 * hora;
    const localB = b - 3 * hora;
    const abertura = Math.floor(localA / dia) * dia + 8 * hora;
    if (localA < abertura || localB > abertura + 12 * hora) {
        return 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00';
    }
    if (b - a > 2 * hora) return 'Duracao acima do limite: a politica permite no maximo 2 horas';
}

function conflitos({ sala, inicio, fim }) {
    return reservas.filter(item => item.sala === sala
        && Date.parse(item.inicio) < Date.parse(fim) && Date.parse(inicio) < Date.parse(item.fim));
}

function concluir(args) {
    const id = 'res-' + String(reservas.length + 1).padStart(4, '0');
    reservas.push({ ...args, id });
    return completo({ ...args, reserva: id, reservado: true, politica: versao });
}

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'central-de-salas', version: '1.0.0' }, {
        requestState: { verify: codec.verify }
    });
    server.registerTool('listar_salas', {
        inputSchema: z.object({}), outputSchema: z.object({ salas: z.array(salaSchema) })
    }, () => completo({ salas }));

    server.registerTool('consultar_disponibilidade', { inputSchema: intervalo }, args => {
        const problema = validar(args);
        if (problema) return erro(problema);
        const ocupacoes = conflitos(args).map(({ id, inicio, fim, responsavel }) => ({ id, inicio, fim, responsavel }));
        return completo({ sala: args.sala, livre: ocupacoes.length === 0, conflitos: ocupacoes });
    });

    server.registerTool('reservar_sala', { inputSchema: pedido }, async (args, ctx) => {
        const estado = ctx.mcpReq.requestState();
        if (estado) {
            const resposta = ctx.mcpReq.inputResponses?.[escolha];
            if (resposta?.action === 'decline' || resposta?.action === 'cancel') {
                return completo({ reservado: false, motivo: 'recusado' });
            }
            const sala = resposta?.content?.sala;
            if (resposta?.action !== 'accept' || !estado.alternativas.includes(sala)) {
                return erro('Escolha uma das salas oferecidas');
            }
            const alternativa = { ...estado.args, sala };
            if (conflitos(alternativa).length) return erro('Sala alternativa indisponivel no intervalo');
            return concluir(alternativa);
        }

        const problema = validar(args);
        if (problema) return erro(problema);
        if (!conflitos(args).length) return concluir(args);
        const capacidade = salas.find(item => item.id === args.sala).capacidade;
        const alternativas = salas
            .filter(item => item.capacidade >= capacidade && !conflitos({ ...args, sala: item.id }).length)
            .sort((a, b) => a.capacidade - b.capacidade || a.id.localeCompare(b.id))
            .slice(0, 3)
            .map(item => item.id);
        if (!alternativas.length) return erro('Sem alternativas disponiveis no intervalo');

        return inputRequired({
            inputRequests: {
                [escolha]: inputRequired.elicit({
                    mode: 'form',
                    message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.',
                    requestedSchema: {
                        type: 'object', required: ['sala'],
                        properties: { sala: { type: 'string', enum: alternativas } }
                    }
                })
            },
            requestState: await codec.mint({ args, alternativas })
        });
    });

    server.registerResource('politica-de-uso', uri, { mimeType: 'text/markdown' }, () => ({
        contents: [{ uri, mimeType: 'text/markdown', text: politica }]
    }));
    return server;
}, { legacy: 'reject' });

const metaPrefix = 'io.modelcontextprotocol/';
const nodeHandler = toNodeHandler({
    async fetch(request) {
        if (request.method === 'POST') {
            const body = await request.clone().json().catch(() => null);
            const meta = body?.params?._meta;
            console.error(JSON.stringify({ method: body?.method ?? null, id: body?.id ?? null, traceparent: meta?.traceparent ?? null }));
            if (body && (!meta?.[metaPrefix + 'protocolVersion'] || !meta?.[metaPrefix + 'clientCapabilities'])) {
                return Response.json({
                    jsonrpc: '2.0', id: body.id ?? null,
                    error: { code: -32602, message: 'Metadados MCP obrigatorios ausentes' }
                }, { status: 400 });
            }
        }
        return handler.fetch(request);
    }
});

createServer((req, res) => {
    if (req.url === '/mcp') return nodeHandler(req, res);
    res.writeHead(404).end();
}).listen(Number(process.env.MCP_PORT ?? 7301), '127.0.0.1');

