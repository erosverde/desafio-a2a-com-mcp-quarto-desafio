import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const version = '2026-07-28';
const policyUri = 'politica://uso';
const endpoint = process.env.MCP_URL ?? 'http://127.0.0.1:7301/mcp';

let connection;

function connect() {
    connection ??= (async () => {
        const client = new Client({ name: 'agente-central-de-salas', version: '1.0.0' }, {
            capabilities: { elicitation: { form: {} } },
            versionNegotiation: { mode: { pin: version } },
            // A Task must pause so its A2A caller can answer the elicitation.
            inputRequired: { autoFulfill: false }
        });
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        return client;
    })().catch(error => {
        connection = undefined;
        throw error;
    });
    return connection;
}

async function request(method, params, traceparent, options) {
    const client = await connect();
    return client.request({
        method,
        params: { ...params, ...(traceparent && { _meta: { traceparent } }) }
    }, { timeout: 10_000, ...options });
}

export async function descobrirReserva(traceparent) {
    const { tools } = await request('tools/list', {}, traceparent);
    const tool = tools.find(item => item.name === 'reservar_sala');
    if (!tool) throw new Error('Ferramenta de reserva indisponivel');
    const { contents } = await request('resources/read', { uri: policyUri }, traceparent);
    const primeiraLinha = contents.find(item => item.uri === policyUri)?.text?.split('\n', 1)[0];
    const politica = /^versao:\s*(\S+)/.exec(primeiraLinha)?.[1];
    if (!politica) throw new Error('Versao da politica indisponivel');
    return { name: tool.name, politica };
}

export function chamarReserva(name, args, traceparent, retry) {
    return request('tools/call', { name, arguments: args, ...retry }, traceparent, { allowInputRequired: true });
}
