import { randomUUID } from 'node:crypto';

const version = '2026-07-28';
const prefix = 'io.modelcontextprotocol/';
const policyUri = 'politica://uso';
const endpoint = process.env.MCP_URL ?? 'http://127.0.0.1:7301/mcp';

async function request(method, params, traceparent) {
    const id = randomUUID();
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': version,
        'Mcp-Method': method
    };
    const name = params.name ?? params.uri;
    if (name) headers['Mcp-Name'] = name;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
            jsonrpc: '2.0', id, method,
            params: {
                ...params,
                _meta: {
                    [prefix + 'protocolVersion']: version,
                    [prefix + 'clientInfo']: { name: 'agente-central-de-salas', version: '1.0.0' },
                    [prefix + 'clientCapabilities']: { elicitation: { form: {} } },
                    ...(traceparent && { traceparent })
                }
            }
        })
    });
    const body = response.headers.get('content-type')?.includes('text/event-stream')
        ? JSON.parse((await response.text()).split(/\r?\n/).filter(line => line.startsWith('data:')).at(-1).slice(5))
        : await response.json();
    if (body.id !== id) throw new Error('Resposta MCP com id inesperado');
    if (body.error) throw new Error(body.error.message);
    if (!response.ok || !body.result) throw new Error('Resposta MCP invalida');
    return body.result;
}

export async function descobrirReserva(traceparent) {
    const { tools } = await request('tools/list', {}, traceparent);
    const tool = tools.find(item => item.name === 'reservar_sala');
    if (!tool) throw new Error('Ferramenta de reserva indisponivel');
    const { contents } = await request('resources/read', { uri: policyUri }, traceparent);
    const politica = /^versao:\s*(\S+)/.exec(contents.find(item => item.uri === policyUri)?.text)?.[1];
    if (!politica) throw new Error('Versao da politica indisponivel');
    return { name: tool.name, politica };
}

export function chamarReserva(name, args, traceparent, retry) {
    return request('tools/call', { name, arguments: args, ...retry }, traceparent);
}

