function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

async function embedText(apiKey, text) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] }
    })
  });
  if (!r.ok) throw new Error(`Embedding API error: ${r.status}`);
  const data = await r.json();
  return data.embedding.values;
}

async function retrieveChunks(env, embedding) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_article_chunks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: Number(env.TOP_K || "8")
    })
  });
  if (!r.ok) throw new Error(`Supabase RPC error: ${r.status}`);
  return r.json();
}

async function generateAnswer(apiKey, question, rows) {
  const context = rows
    .map((r, i) => `Kaynak ${i + 1}: ${r.title}\nURL: ${r.source_url}\nİçerik: ${r.chunk_text}`)
    .join("\n\n");

  const prompt = `Sen Mehmet Gülümser'in web sitesindeki dijital asistansın.

Kurallar:
- Sadece verilen kaynaklara dayan.
- Bilgi yoksa net olarak "Bu konuda kaynaklarda bilgi bulamadım." de.
- Cevap Türkçe, kısa ve net olsun.
- Cevabın sonuna "Kaynaklar" başlığıyla ilgili URL'leri ekle.

Soru: ${question}

Kaynaklar:
${context}`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  if (!r.ok) throw new Error(`Gemini API error: ${r.status}`);
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Yanıt üretilemedi.";
  return text;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    try {
      const { message } = await request.json();
      if (!message || !message.trim()) return json({ error: "Mesaj boş olamaz" }, 400);

      const embedding = await embedText(env.GEMINI_API_KEY, message.trim());
      const rows = await retrieveChunks(env, embedding);
      const reply = await generateAnswer(env.GEMINI_API_KEY, message.trim(), rows);

      const sources = [...new Set(rows.map((r) => r.source_url))];
      return json({ reply, sources });
    } catch (err) {
      return json({ error: "İstek işlenemedi", detail: String(err) }, 500);
    }
  }
};
