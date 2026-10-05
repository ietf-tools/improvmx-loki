#!/usr/bin/env node
// improvmx-to-loki.js
// Receives ImprovMX webhook POSTs and pushes each email to Grafana Loki as one log line.
// Requires Node.js 18+ (built-in fetch). No dependencies.
'use strict'
 
const http = require('node:http')
const crypto = require('node:crypto')
 
const cfg = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  path: process.env.WEBHOOK_PATH || '/improvmx',
  // Shared secret expected as ?token=... in the webhook URL (recommended).
  token: process.env.WEBHOOK_TOKEN || '',
  // ImprovMX sends webhooks from a single static IP. Set ALLOWED_IPS="" to disable the check.
  allowedIps: (process.env.ALLOWED_IPS ?? '15.237.103.194')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Set to "true" when running behind a reverse proxy that sets X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === 'true',
  lokiUrl: process.env.LOKI_URL || 'http://localhost:3100/loki/api/v1/push',
  lokiUser: process.env.LOKI_USER || '', // Grafana Cloud: numeric user ID
  lokiToken: process.env.LOKI_TOKEN || '', // Grafana Cloud: access policy token
  lokiTenant: process.env.LOKI_TENANT || '', // multi-tenant Loki: X-Scope-OrgID
  job: process.env.LOKI_JOB || 'email-ingest',
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 10 * 1024 * 1024),
  maxTextChars: Number(process.env.MAX_TEXT_CHARS || 64000)
}
 
// ---------- helpers ----------
 
function send (res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text + '\n')
}
 
function clientIp (req) {
  let ip = req.socket.remoteAddress || ''
  if (cfg.trustProxy && req.headers['x-forwarded-for']) {
    ip = String(req.headers['x-forwarded-for']).split(',')[0].trim()
  }
  return ip.replace(/^::ffff:/, '')
}
 
function safeEqual (a, b) {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}
 
function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cfg.maxBodyBytes) {
        const err = new Error('payload too large')
        err.status = 413
        req.destroy()
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
 
// Crude HTML-to-text, only used when the email has no text/plain part.
function htmlToText (html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}
 
// The alias the email was actually delivered to. Delivered-To is more accurate than
// the To: header when the app sends to several recipients or uses BCC.
function recipientOf (p) {
  let d = p.headers && p.headers['Delivered-To']
  if (Array.isArray(d)) d = d[0]
  const to = Array.isArray(p.to) && p.to[0] ? p.to[0].email : null
  return String(d || to || 'unknown').trim().toLowerCase()
}
 
function buildLokiPayload (p) {
  const rcpt = recipientOf(p)
  const text = p.text && p.text.trim() ? p.text : htmlToText(p.html || '')
 
  const line = {
    from: p.from ? p.from.email : null,
    from_name: p.from ? p.from.name : null,
    to: rcpt,
    subject: p.subject || '',
    message_id: p['message-id'] || null,
    date: p.date || null,
    attachments: (p.attachments || []).map((a) => a.name),
    body: text.slice(0, cfg.maxTextChars)
  }
 
  // Use arrival time rather than the email's Date header, so a skewed sender clock
  // or a delayed retry can't produce timestamps Loki rejects as too old.
  const tsNs = (BigInt(Date.now()) * 1_000_000n).toString()
 
  return {
    rcpt,
    subject: line.subject,
    body: {
      streams: [{
        stream: { job: cfg.job, source: rcpt.split('@')[0] },
        values: [[tsNs, JSON.stringify(line)]]
      }]
    }
  }
}
 
async function pushToLoki (body) {
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.lokiUser) {
    const cred = Buffer.from(`${cfg.lokiUser}:${cfg.lokiToken}`).toString('base64')
    headers.Authorization = `Basic ${cred}`
  }
  if (cfg.lokiTenant) headers['X-Scope-OrgID'] = cfg.lokiTenant
 
  const res = await fetch(cfg.lokiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) {
    throw new Error(`Loki responded ${res.status}: ${(await res.text()).slice(0, 500)}`)
  }
}
 
// ---------- request handling ----------
 
async function handle (req, res) {
  const url = new URL(req.url, 'http://localhost')
 
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok')
  if (url.pathname !== cfg.path) return send(res, 404, 'not found')
  if (req.method !== 'POST') return send(res, 405, 'method not allowed')
 
  const ip = clientIp(req)
  if (cfg.allowedIps.length && !cfg.allowedIps.includes(ip)) {
    console.warn(`rejected request from ${ip}`)
    return send(res, 403, 'forbidden')
  }
  if (cfg.token && !safeEqual(url.searchParams.get('token') || '', cfg.token)) {
    console.warn(`bad token from ${ip}`)
    return send(res, 403, 'forbidden')
  }
 
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (err) {
    return send(res, err.status || 400, err.status ? err.message : 'invalid JSON')
  }
 
  const entry = buildLokiPayload(payload)
  try {
    await pushToLoki(entry.body)
  } catch (err) {
    // Non-2xx makes ImprovMX retry (twice) later.
    console.error(`push failed for ${entry.rcpt}: ${err.message}`)
    return send(res, 502, 'loki push failed')
  }
 
  console.log(`stored email to ${entry.rcpt}: ${JSON.stringify(entry.subject)}`)
  return send(res, 200, 'ok')
}
 
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('unexpected error:', err)
    if (!res.headersSent) send(res, 500, 'internal error')
  })
})
 
server.listen(cfg.port, cfg.host, () => {
  console.log(`listening on ${cfg.host}:${cfg.port}${cfg.path} -> ${cfg.lokiUrl}`)
  if (!cfg.token) console.warn('WARNING: WEBHOOK_TOKEN is not set')
})
 
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
