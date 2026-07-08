# Black_Wall remote MCP

A hosted **remote MCP** (Model Context Protocol over HTTP) that gives any
MCP-capable agent a pre-signature **payment-risk verdict** — with no install and
no signup. Add one URL and your agent can ask, before it signs an x402 payment,
*"should I pay this?"* and get **GO / HOLD / STOP** — from counterparty
settlement reputation, price-anomaly (quoted vs the payee's own median), and OFAC
sanctions — plus a **third-party-verifiable Ed25519 signed receipt**.

## Add it

Point your MCP client at:

```
https://mcp.blackwalltier.com
```

Transport: **Streamable HTTP**. No API key. Verdicts for amounts **under $10 at
risk are free**; at or above that, the tool returns an **x402 payment challenge**
your agent settles from its own wallet (pass the settled payment back as an
`X-PAYMENT` header, then retry).

## The tool: `forecast_payment`

| field | | |
|---|---|---|
| `counterparty` | string, required | recipient wallet from the 402 |
| `amount` | string, required | decimal string, e.g. `"0.09"` |
| `asset` | string, required | e.g. `USDC` |
| `chain` | string, required | e.g. `base` |
| `payer` / `resource` / `agent_id` / `context` | optional | binds settlement / context |

Returns a verdict (`GO`/`HOLD`/`STOP`) + reasons + signals, and a
`signed_receipt` anyone can verify against the published key at
`https://agent-egress-proxy.onrender.com/.well-known/blackwall-receipt-key.json`
(any RFC 8032 Ed25519 library) — Black_Wall never has to be in the loop.

## How it works

This Worker is a **thin transport + proxy**: it speaks minimal MCP JSON-RPC
(`initialize` / `tools/list` / `tools/call` / `ping`) and forwards
`forecast_payment` calls to the Black_Wall x402 oracle. All decision logic and
the receipt come from the oracle unchanged.

**Fail-closed by design:** if the oracle errors, is unreachable, or returns a
non-verdict, the tool returns an error — **never a phantom `GO`**. A payment
guardrail that can't reach its backend must not imply "safe to pay."

## Registry

Published to the official MCP Registry as
`com.blackwalltier/blackwall-x402-guardrail`.

## Develop

```sh
node test.mjs        # unit tests (mocked oracle)
npx wrangler dev     # run locally
npx wrangler deploy  # deploy (Cloudflare Workers)
```

By BlueTier. Verdict only — never takes custody, never in the settlement path.
*No evidence is not trust.*
