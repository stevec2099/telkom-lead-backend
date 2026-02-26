// api/lead.js
const AUTH_BASE = "https://login.mypurecloud.ie";
const API_BASE = "https://api.mypurecloud.ie";


let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30_000) return cachedToken;

  const clientId = process.env.GC_CLIENT_ID;
  const clientSecret = process.env.GC_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GC_CLIENT_ID / GC_CLIENT_SECRET env vars in Vercel.");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });

  const resp = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Token error: ${resp.status} ${resp.statusText} ${txt}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

async function gcApi(path) {
  const token = await getToken();
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`GC API error ${resp.status} ${resp.statusText}: ${txt}`);
  }
  return resp.json();
}

function extractOutboundIds(conversation) {
  let contactId = null;
  let contactListId = null;

  const participants = conversation.participants || [];
  for (const p of participants) {
    const attrs = p.attributes || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (!contactId && /outbound.*contact.*id|contactId/i.test(k) && v) contactId = v;
      if (!contactListId && /contactlist.*id|outbound.*contactlist/i.test(k) && v) contactListId = v;
    }
  }

  const top = conversation.attributes || {};
  for (const [k, v] of Object.entries(top)) {
    if (!contactId && /contactId/i.test(k) && v) contactId = v;
    if (!contactListId && /contactListId|contactlist/i.test(k) && v) contactListId = v;
  }

  return { contactId, contactListId };
}

export default async function handler(req, res) {
  try {
    // Basic CORS (tighten for production)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();

    const conversationId = req.query.conversationId;
    if (!conversationId) return res.status(400).json({ error: "Missing conversationId" });

    // 1) Fetch conversation
    let conv;
    try {
      conv = await gcApi(`/api/v2/conversations/calls/${encodeURIComponent(conversationId)}`);
    } catch {
      conv = await gcApi(`/api/v2/conversations/${encodeURIComponent(conversationId)}`);
    }

    // 2) Extract outbound ids
    const { contactId, contactListId } = extractOutboundIds(conv);
    if (!contactId || !contactListId) {
      return res.status(422).json({
        error: "Could not find contactId/contactListId in conversation payload.",
        tip: "Open browser devtools > Network/Console and share a redacted conversation payload so we can harden key extraction."
      });
    }

    // 3) Fetch lead record
    const lead = await gcApi(
      `/api/v2/outbound/contactlists/${encodeURIComponent(contactListId)}/contacts/${encodeURIComponent(contactId)}`
    );

    return res.status(200).json({ contactId, contactListId, lead });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
