import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const root = new URL('../', import.meta.url);
const processes = new Set();
const started = [];
const secret = randomBytes(32).toString('hex');

async function availablePort() {
    const socket = createServer().listen(0, host);
    await once(socket, 'listening');
    const { port } = socket.address();
    socket.close();
    await once(socket, 'close');
    return port;
}

async function start(file, port, environment) {
    const child = spawn(process.execPath, [fileURLToPath(new URL(file, root))], {
        cwd: root,
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    const processInfo = { child, stderr: '', stopped: once(child, 'exit') };
    started.push(processInfo);
    processes.add(processInfo);
    child.stderr.setEncoding('utf8').on('data', chunk => { processInfo.stderr += chunk; });
    // Register the rejection handler before probing readiness.
    processInfo.stopped.catch(() => {});
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
        const ready = await new Promise(resolve => {
            const socket = connect(port, host);
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => resolve(false));
        });
        if (ready && child.pid && child.exitCode === null) return processInfo;
        await delay(50);
    }
    throw new Error('Processo indisponível: ' + file);
}

async function stop(processInfo) {
    const { child, stopped } = processInfo;
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    await stopped;
    processes.delete(processInfo);
}

async function example(name) {
    return JSON.parse(await readFile(new URL('exemplos/wire/' + name, root), 'utf8')).request;
}

async function rpc(url, body, headers) {
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
    });
    return { status: response.status, body: await response.json() };
}

async function traceEntries(processInfo, traceId) {
    for (let attempt = 0; attempt < 40; attempt++) {
        const entries = processInfo.stderr.split(/\r?\n/)
            .filter(line => line.startsWith('{') && line.endsWith('}'))
            .map(line => JSON.parse(line))
            .filter(entry => entry.traceparent?.split('-')[1] === traceId);
        if (entries.length >= 4) return entries;
        await delay(50);
    }
    throw new Error('Trace da Task não apareceu nas quatro chamadas MCP');
}

try {
    const mcpPort = await availablePort();
    let a2aPort = await availablePort();
    while (a2aPort === mcpPort) a2aPort = await availablePort();

    const mcpUrl = 'http://' + host + ':' + mcpPort + '/mcp';
    const a2aUrl = 'http://' + host + ':' + a2aPort + '/a2a';
    const startMcp = () => start('servidor-mcp/server.mjs', mcpPort, {
        MCP_PORT: String(mcpPort), REQUEST_STATE_SECRET: secret
    });
    let mcp = await startMcp();
    await start('agente/server.mjs', a2aPort, {
        A2A_PORT: String(a2aPort), A2A_URL: a2aUrl, MCP_URL: mcpUrl
    });

    const initial = await example('03-tools-call-conflito-input-required.json');
    const mismatch = await rpc(mcpUrl, initial.body, { ...initial.headers, 'Mcp-Name': 'listar_salas' });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error?.code, -32020);
    console.log('PASS headers MCP divergentes retornam HTTP 400 e -32020');

    const paused = await rpc(mcpUrl, initial.body, initial.headers);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.result?.resultType, 'input_required');
    const { inputRequests, requestState } = paused.body.result;
    assert.equal(typeof requestState, 'string');
    const [key] = Object.keys(inputRequests);

    await stop(mcp);
    mcp = await startMcp();
    const retry = await rpc(mcpUrl, {
        ...initial.body,
        id: initial.body.id + 1,
        params: {
            ...initial.body.params,
            requestState,
            inputResponses: { [key]: { action: 'accept', content: { sala: 'sala-fusca' } } }
        }
    }, initial.headers);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.result?.resultType, 'complete');
    assert.equal(retry.body.result.structuredContent?.reservado, true);
    assert.equal(retry.body.result.structuredContent?.sala, 'sala-fusca');
    console.log('PASS estado emitido antes do restart conclui reserva com a mesma chave');

    const traceId = randomBytes(16).toString('hex');
    const first = await example('08-a2a-send-message.json');
    const traceparent = '00-' + traceId + '-' + randomBytes(8).toString('hex') + '-01';
    const headers = { ...first.headers, traceparent };
    const sent = await rpc(a2aUrl, first.body, headers);
    const task = sent.body.result?.task;
    assert.equal(sent.status, 200);
    assert.equal(task?.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.equal(task.status.message.parts[0].text, 'alternativas: sala-mirante');

    const continuation = await example('10-a2a-send-message-continuacao.json');
    continuation.body.params.message.taskId = task.id;
    const resumed = await rpc(a2aUrl, continuation.body, headers);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.result?.task.status.state, 'TASK_STATE_COMPLETED');
    const entries = await traceEntries(mcp, traceId);
    assert.deepEqual(entries.map(entry => entry.method), ['tools/list', 'resources/read', 'tools/call', 'tools/call']);
    console.log('PASS trace A2A chega ao MCP na descoberta, leitura, chamada e retomada');

    const [initialCall, retryCall] = entries.slice(-2);
    assert.ok(initialCall.id && retryCall.id);
    assert.notEqual(initialCall.id, retryCall.id);
    console.log('PASS retomada A2A gera um novo id JSON-RPC no MCP');
} catch (error) {
    console.error(error);
    for (const { stderr } of started) {
        if (stderr) console.error(stderr);
    }
    process.exitCode = 1;
} finally {
    await Promise.allSettled([...processes].map(stop));
}
