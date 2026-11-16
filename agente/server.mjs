import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chamarReserva, descobrirReserva } from './mcp.mjs';

const port = Number(process.env.A2A_PORT ?? 7300);
const url = process.env.A2A_URL ?? 'http://127.0.0.1:' + port + '/a2a';
const card = {
    name: 'Central de Salas',
    description: 'Reserva salas de reuniao da Hill Valley Tech.',
    provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
    version: '1.0.0',
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
        id: 'reservar-sala', name: 'Reservar sala', tags: ['salas', 'agenda'],
        description: 'Reserva uma sala e apresenta alternativas em caso de conflito.'
    }]
};

const tasks = new Map();
const state = value => ({ state: 'TASK_STATE_' + value });

class RpcError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function registrarEstado(task, value, text) {
    task.status = state(value);
    if (text) {
        const message = {
            messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }],
            taskId: task.id, contextId: task.contextId
        };
        task.status.message = message;
        task.history.push(message);
    }
}

function aplicarResultado(record, result) {
    const { task } = record;
    record.pause = undefined;
    if (result.resultType === 'input_required') {
        const [[key, input]] = Object.entries(result.inputRequests);
        const sala = input.params.requestedSchema.properties.sala;
        const alternativas = sala.enum ?? [sala.const];
        record.pause = { key, alternativas, requestState: result.requestState };
        registrarEstado(task, 'INPUT_REQUIRED', 'alternativas: ' + alternativas.join(', '));
        return;
    }
    if (result.isError) {
        registrarEstado(task, 'FAILED', result.content.map(item => item.text).join('\n'));
        return;
    }
    const { reservado, motivo, politica, ...reserva } = result.structuredContent;
    if (!reservado) {
        registrarEstado(task, 'CANCELED', motivo);
        return;
    }
    task.artifacts.push({
        artifactId: randomUUID(), name: 'reserva',
        parts: [{ text: JSON.stringify({ ...reserva, politica: record.tool.politica }) }]
    });
    registrarEstado(task, 'COMPLETED', 'Reserva ' + reserva.reserva + ' confirmada na ' + reserva.sala + '.');
}

async function sendMessage(message, traceparent) {
    const text = message?.parts?.[0]?.text;
    if (typeof text !== 'string' || message.role !== 'ROLE_USER' || typeof message.messageId !== 'string') {
        throw new RpcError(-32602, 'Mensagem de usuario invalida');
    }

    let record;
    let retry;
    if (message.taskId) {
        record = tasks.get(message.taskId);
        if (!record) throw new RpcError(-32001, 'Task inexistente');
        const { task, pause } = record;
        if (!pause || task.status.state !== 'TASK_STATE_INPUT_REQUIRED') {
            throw new RpcError(-32004, 'Task indisponivel para continuacao');
        }
        if (message.contextId && message.contextId !== task.contextId) {
            throw new RpcError(-32602, 'contextId invalido');
        }
        task.history.push(message);
        const escolha = /^escolha=(\S+)$/.exec(text)?.[1];
        if (escolha !== 'recusar' && !pause.alternativas.includes(escolha)) return task;
        retry = {
            requestState: pause.requestState,
            inputResponses: {
                [pause.key]: escolha === 'recusar'
                    ? { action: 'decline' }
                    : { action: 'accept', content: { sala: escolha } }
            }
        };
        record.traceparent ??= traceparent;
    } else {
        const args = /^reservar sala=(?<sala>\S+) inicio=(?<inicio>\S+) fim=(?<fim>\S+) responsavel=(?<responsavel>.+)$/.exec(text)?.groups;
        if (!args) throw new RpcError(-32602, 'Formato de reserva invalido');
        const task = {
            id: randomUUID(), contextId: randomUUID(), status: state('SUBMITTED'),
            history: [message], artifacts: []
        };
        record = { task, args, traceparent };
        tasks.set(task.id, record);
    }

    const { task } = record;
    registrarEstado(task, 'WORKING');
    try {
        record.tool ??= await descobrirReserva(record.traceparent);
        aplicarResultado(record, await chamarReserva(record.tool.name, record.args, record.traceparent, retry));
    } catch (error) {
        record.pause = undefined;
        registrarEstado(task, 'FAILED', error.message);
    }
    return task;
}

function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') return reply(res, 200, card);
    if (req.method !== 'POST' || req.url !== '/a2a') return res.writeHead(404).end();

    let id = null;
    try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 64 * 1024) throw new RpcError(-32600, 'Mensagem grande demais');
            chunks.push(chunk);
        }
        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            throw new RpcError(-32700, 'JSON invalido');
        }
        if (body?.jsonrpc !== '2.0' || typeof body.method !== 'string') {
            throw new RpcError(-32600, 'Request JSON-RPC invalido');
        }
        id = body.id ?? null;
        let task;
        switch (body.method) {
            case 'GetTask':
                task = tasks.get(body.params?.id)?.task;
                if (!task) throw new RpcError(-32001, 'Task inexistente');
                if (body.params.historyLength !== undefined) {
                    const limit = body.params.historyLength;
                    if (!Number.isInteger(limit) || limit < 0) {
                        throw new RpcError(-32602, 'historyLength deve ser um inteiro nao negativo');
                    }
                    task = { ...task, history: limit === 0 ? [] : task.history.slice(-limit) };
                }
                break;
            case 'SendMessage':
                task = await sendMessage(body.params?.message, req.headers.traceparent);
                break;
            default:
                throw new RpcError(-32601, 'Metodo inexistente');
        }
        reply(res, 200, { jsonrpc: '2.0', id, result: { task } });
    } catch (error) {
        const rpcError = error instanceof RpcError
            ? { code: error.code, message: error.message }
            : { code: -32603, message: 'Erro interno' };
        reply(res, 200, { jsonrpc: '2.0', id, error: rpcError });
    }
}).listen(port, '127.0.0.1');
