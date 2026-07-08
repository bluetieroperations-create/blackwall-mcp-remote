// Tests for the Black_Wall remote MCP dispatcher. Pure dispatch() + a mocked
// oracle fetch — no network, no Worker runtime. Each assert notes the mutation
// it kills. Run: node test.mjs
import { dispatch } from './src/index.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ok —', msg); }
  else { fail++; console.error('  FAIL —', msg); }
}

// Mock oracle: returns a queued Response-like; records the request it saw.
function makeOracle(status, bodyObj, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (opts.throws) throw new Error('network down');
    return { status, ok: status >= 200 && status < 300, json: async () => bodyObj };
  };
  return { fetchImpl, calls };
}

const GO = { verdict: 'GO', score: 0.99, reasons: ['reputable', 'fair price'], receipt_id: 'bw_abc', signed_receipt: { key_id: 'k', sig: 's' } };
const ORACLE = 'https://oracle.example/v1/forecast-payment';

console.log('\n[initialize]');
{
  const o = makeOracle(200, GO);
  const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { ...o, oracleUrl: ORACLE });
  // Kills: not echoing the client protocol version / dropping tools capability.
  assert(r.result.protocolVersion === '2025-06-18', 'echoes client protocolVersion');
  assert(r.result.capabilities && r.result.capabilities.tools != null, 'advertises tools capability');
  assert(r.result.serverInfo.name === 'blackwall-remote-mcp', 'returns serverInfo');
}

console.log('\n[tools/list]');
{
  const o = makeOracle(200, GO);
  const r = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...o, oracleUrl: ORACLE });
  // Kills: not exposing forecast_payment / wrong required fields.
  assert(r.result.tools.length === 1 && r.result.tools[0].name === 'forecast_payment', 'lists forecast_payment');
  const req = r.result.tools[0].inputSchema.required;
  assert(['counterparty', 'amount', 'asset', 'chain'].every((k) => req.includes(k)), 'schema requires counterparty/amount/asset/chain');
}

console.log('\n[notifications + ping]');
{
  const o = makeOracle(200, GO);
  assert((await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, { ...o, oracleUrl: ORACLE })) === null, 'notification returns null (no response)');
  const p = await dispatch({ jsonrpc: '2.0', id: 3, method: 'ping' }, { ...o, oracleUrl: ORACLE });
  assert(p.result && Object.keys(p.result).length === 0, 'ping returns empty result');
}

console.log('\n[tools/call — free-tier verdict passthrough]');
{
  const o = makeOracle(200, GO);
  const r = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'forecast_payment', arguments: { counterparty: '0xabc', amount: '2.00', asset: 'USDC', chain: 'base' } } }, { ...o, oracleUrl: ORACLE });
  // Kills: dropping the verdict / not passing the signed receipt through.
  assert(o.calls[0].url === ORACLE, 'proxies to the oracle URL');
  assert(JSON.parse(o.calls[0].init.body).counterparty === '0xabc', 'forwards the tool arguments to the oracle');
  assert(r.result.structuredContent.verdict === 'GO', 'returns the full verdict as structuredContent');
  assert(r.result.structuredContent.signed_receipt != null, 'passes the signed receipt through');
  assert(/GO/.test(r.result.content[0].text), 'text block summarizes the verdict');
  assert(!r.result.isError, 'a successful verdict is not an error');
}

console.log('\n[tools/call — x402 challenge on 402]');
{
  const challenge = { x402Version: 1, accepts: [{ scheme: 'exact', maxAmountRequired: '10000' }] };
  const o = makeOracle(402, challenge);
  const r = await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'forecast_payment', arguments: { counterparty: '0xabc', amount: '50.00', asset: 'USDC', chain: 'base' } } }, { ...o, oracleUrl: ORACLE });
  // Kills: swallowing the 402 (agent must be able to pay + retry).
  assert(r.result.structuredContent.accepts != null, 'surfaces the x402 challenge as structuredContent');
  assert(/[Pp]ayment required/.test(r.result.content[0].text), 'tells the agent payment is required');
  assert(!r.result.isError, 'a 402 is a payment gate, not a tool error');
}

console.log('\n[tools/call — X-PAYMENT passthrough]');
{
  const o = makeOracle(200, GO);
  await dispatch({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'forecast_payment', arguments: { counterparty: '0xabc', amount: '50.00', asset: 'USDC', chain: 'base' } } }, { ...o, oracleUrl: ORACLE, paymentHeader: 'PAY_TOKEN_XYZ' });
  // Kills: not forwarding a settled payment -> agent can never complete a paid call.
  assert(o.calls[0].init.headers['X-PAYMENT'] === 'PAY_TOKEN_XYZ', 'forwards X-PAYMENT header to the oracle');
}

console.log('\n[tools/call — FAIL CLOSED on oracle error / outage]');
{
  const oErr = makeOracle(500, { error: 'boom' });
  const r1 = await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'forecast_payment', arguments: { counterparty: '0xabc', amount: '2.00', asset: 'USDC', chain: 'base' } } }, { ...oErr, oracleUrl: ORACLE });
  // Kills: rendering a phantom GO when the oracle errored.
  assert(r1.result.isError === true, 'oracle 5xx -> tool error (no verdict)');
  assert(!/verdict/i.test(JSON.stringify(r1.result.structuredContent || {})), 'no verdict field on an errored call');
  assert(/do not treat as GO/i.test(r1.result.content[0].text), 'error text warns against treating as GO');

  const oDown = makeOracle(200, GO, { throws: true });
  const r2 = await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'forecast_payment', arguments: { counterparty: '0xabc', amount: '2.00', asset: 'USDC', chain: 'base' } } }, { ...oDown, oracleUrl: ORACLE });
  assert(r2.result.isError === true, 'oracle unreachable -> tool error (fail closed, never phantom GO)');
}

console.log('\n[tools/call — 402 must never surface a verdict]');
{
  // A 402 is a PAYMENT GATE, not a cleared verdict. If the oracle's 402 body ever
  // carries a verdict field (bug, cache poisoning, misbehaving upstream), it must
  // NOT reach the agent as structuredContent.verdict — that is a phantom GO.
  const forged = { x402Version: 1, accepts: [{ scheme: 'exact' }], verdict: 'GO', score: 0.99, receipt_id: 'bw_forged' };
  const o = makeOracle(402, forged);
  const r = await dispatch({ jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'forecast_payment', arguments: { counterparty: '0xabc', amount: '50.00', asset: 'USDC', chain: 'base' } } }, { ...o, oracleUrl: ORACLE });
  // Kills: passing the raw 402 body through so a verdict:GO leaks as structuredContent.
  assert(r.result.structuredContent == null || r.result.structuredContent.verdict == null, '402 structuredContent carries NO verdict field (no phantom GO)');
  assert(r.result.structuredContent && r.result.structuredContent.accepts != null, '402 still surfaces the x402 challenge (accepts) so the agent can pay');
  assert(!/GO/.test(r.result.content[0].text), '402 text never reads as GO');
}

console.log('\n[tools/call as a notification — no upstream, no response]');
{
  // A JSON-RPC notification (no id) is fire-and-forget. It MUST NOT get a response
  // and MUST NOT trigger a paid upstream oracle call.
  const o = makeOracle(200, GO);
  const r = await dispatch({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'forecast_payment', arguments: { counterparty: '0xabc', amount: '2.00', asset: 'USDC', chain: 'base' } } }, { ...o, oracleUrl: ORACLE });
  // Kills: executing a notification (unsolicited upstream call) / replying to a notification.
  assert(r === null, 'notification tools/call returns null (no JSON-RPC response)');
  assert(o.calls.length === 0, 'notification tools/call never touches the oracle');
}

console.log('\n[error paths]');
{
  const o = makeOracle(200, GO);
  const unknownTool = await dispatch({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } }, { ...o, oracleUrl: ORACLE });
  assert(unknownTool.error && unknownTool.error.code === -32602, 'unknown tool -> invalid params error');
  assert(o.calls.length === 0, 'unknown tool never touches the oracle');

  const unknownMethod = await dispatch({ jsonrpc: '2.0', id: 10, method: 'resources/list' }, { ...o, oracleUrl: ORACLE });
  assert(unknownMethod.error && unknownMethod.error.code === -32601, 'unknown method -> method not found');

  const bad = await dispatch({ id: 11, method: 'ping' }, { ...o, oracleUrl: ORACLE });
  assert(bad.error && bad.error.code === -32600, 'missing jsonrpc -> invalid request');
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
