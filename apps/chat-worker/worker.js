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

async function retrieveChunks(env, queryText) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_article_chunks_fts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify({
      query_text: queryText,
      match_count: Number(env.TOP_K || "8")
    })
  });
  if (!r.ok) throw new Error(`Supabase RPC error: ${r.status}`);
  return r.json();
}

function buildBroadQuery(input) {
  const stopwords = new Set([
    "acaba","ama","ancak","artık","aslında","az","bazı","belki","ben","bence","beni","benim",
    "bir","biraz","birçok","bize","biz","bu","çok","çünkü","da","daha","de","diye","dolayı",
    "en","gibi","hangi","hani","hatta","hem","her","ile","için","ise","işte","kadar","ki",
    "kim","mi","mı","mu","mü","nasıl","ne","neden","nerede","nereye","niye","o","olan","olarak",
    "oldu","olduğu","oluyor","olsa","olsun","onlar","orada","sanki","şey","siz","şu","tabii",
    "ve","veya","ya","yani"
  ]);

  const words = (input || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopwords.has(word));

  const unique = [...new Set(words)].slice(0, 6);
  if (!unique.length) return "";
  return unique.join(" OR ");
}

async function generateAnswer(apiKey, question, rows) {
  if (!rows || rows.length === 0) {
    return "Bu konuda kaynaklarda bilgi bulamadım.";
  }

  const topRows = (rows || []).slice(0, 6);
  const context = topRows
    .map((r, i) => {
      const snippet = (r.chunk_text || "").slice(0, 1400);
      return `Kaynak ${i + 1}: ${r.title}\nURL: ${r.source_url}\nİçerik Özeti:\n${snippet}`;
    })
    .join("\n\n");

  const prompt = `Sen Mehmet Gülümser'in web sitesindeki dijital asistansın.

Kurallar:
- Sadece verilen kaynaklara dayan.
- Bilgi yoksa net olarak "Bu konuda kaynaklarda bilgi bulamadım." de.
- Cevap Türkçe, derli toplu ve anlaşılır olsun.
- Gerekliyse 3-6 maddede özetle.
- Markdown işaretleri kullanma (**, __, ##, * gibi).
- Düz metin yaz; maddeleme için sadece "-" kullan.
- Cevabın sonuna "Kaynaklar" başlığıyla ilgili URL'leri ekle.

Soru: ${question}

Kaynaklar:
${context}

Cevap formatı:
1) Kısa yanıt
2) Gerekirse maddeler
3) Kaynaklar (URL listesi)`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.15 }
    })
  });

  if (r.status === 429) {
    return "Şu an çok fazla istek alıyorum (kota/limit). Lütfen 1-2 dakika sonra tekrar deneyin.";
  }
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Gemini API error: ${r.status} ${detail}`);
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Yanıt üretilemedi.";
  return text;
}

function fallbackFromSources(rows) {
  const unique = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!seen.has(row.source_url)) {
      seen.add(row.source_url);
      unique.push(row);
    }
    if (unique.length >= 5) break;
  }
  if (!unique.length) return "Bu konuda kaynaklarda bilgi bulamadım.";

  const lines = [
    "Bu soru için ilgili yazılar bulundu. Kısa kaynak listesi:",
    ...unique.map((item) => `- ${item.title}: ${item.source_url}`),
    "İstersen bu kaynaklardan birini seç, sadece o yazı üzerinden net bir özet çıkarayım."
  ];
  return lines.join("\n");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    try {
      const { message } = await request.json();
      if (!message || !message.trim()) return json({ error: "Mesaj boş olamaz" }, 400);

      let rows = await retrieveChunks(env, message.trim());
      if (!rows || rows.length === 0) {
        const broadQuery = buildBroadQuery(message.trim());
        if (broadQuery) {
          rows = await retrieveChunks(env, broadQuery);
        }
      }
      let reply = "";
      try {
        reply = await generateAnswer(env.GEMINI_API_KEY, message.trim(), rows);
      } catch (llmErr) {
        reply = fallbackFromSources(rows);
      }

      const sources = [...new Set(rows.map((r) => r.source_url))];
      return json({ reply, sources });
    } catch (err) {
      return json({ error: "İstek işlenemedi", detail: String(err) }, 500);
    }
  }
};
