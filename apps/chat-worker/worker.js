function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

const STOPWORDS = new Set([
  "acaba","ama","ancak","artık","aslında","az","bazı","belki","ben","bence","beni","benim",
  "bir","biraz","birçok","bize","biz","bu","çok","çünkü","da","daha","de","diye","dolayı",
  "en","gibi","hangi","hani","hatta","hem","her","ile","için","ise","işte","kadar","ki",
  "kim","mi","mı","mu","mü","nasıl","ne","neden","nerede","nereye","niye","o","olan","olarak",
  "oldu","olduğu","oluyor","olsa","olsun","onlar","orada","sanki","şey","siz","şu","tabii",
  "ve","veya","ya","yani"
]);

function extractKeywords(input, minLen = 4, maxCount = 6) {
  const words = (input || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= minLen && !STOPWORDS.has(word));

  return [...new Set(words)].slice(0, maxCount);
}

function normalizeForMatch(text) {
  return (text || "").toLocaleLowerCase("tr-TR");
}

function countKeywordHits(text, keywords) {
  if (!text || !keywords?.length) return 0;
  let hits = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) hits += 1;
  }
  return hits;
}

function countKeywordOccurrences(text, keywords) {
  if (!text || !keywords?.length) return 0;
  let total = 0;
  for (const keyword of keywords) {
    let start = 0;
    while (true) {
      const idx = text.indexOf(keyword, start);
      if (idx === -1) break;
      total += 1;
      start = idx + keyword.length;
    }
  }
  return total;
}

function rankRowsForQuestion(rows, question) {
  const keywords = extractKeywords(question);
  const phrase = keywords.slice(0, 2).join(" ");

  return (rows || [])
    .map((row, idx) => {
      const title = normalizeForMatch(row.title);
      const chunk = normalizeForMatch(row.chunk_text);
      const similarity = Number(row.similarity || 0);
      const titleHits = countKeywordHits(title, keywords);
      const chunkHits = countKeywordHits(chunk, keywords);
      const chunkHitCount = countKeywordOccurrences(chunk, keywords);
      const allKeywordsInTitle = keywords.length > 0 && keywords.every((k) => title.includes(k));
      const phraseInTitle = phrase.length >= 5 && title.includes(phrase);

      const relevance =
        similarity +
        (titleHits * 2.2) +
        (chunkHits * 0.35) +
        (chunkHitCount * 0.12) +
        (allKeywordsInTitle ? 2.4 : 0) +
        (phraseInTitle ? 1.2 : 0);

      return {
        ...row,
        _idx: idx,
        _titleHits: titleHits,
        _chunkHitCount: chunkHitCount,
        _relevance: relevance
      };
    })
    .sort((a, b) => {
      if (b._relevance !== a._relevance) return b._relevance - a._relevance;
      return Number(b.similarity || 0) - Number(a.similarity || 0);
    });
}

async function listArticles(env, limit) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/articles`);
  url.searchParams.set("select", "title,source_url,source_site,published_at,excerpt");
  url.searchParams.set("order", "published_at.desc.nullslast");
  url.searchParams.set("limit", String(limit));

  const r = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if (!r.ok) throw new Error(`Supabase articles error: ${r.status}`);
  return r.json();
}

async function retrieveChunks(env, queryText, matchCount) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_article_chunks_fts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify({
      query_text: queryText,
      match_count: Number(matchCount || env.TOP_K || "8")
    })
  });
  if (!r.ok) throw new Error(`Supabase RPC error: ${r.status}`);
  return r.json();
}

function mergeRows(...rowArrays) {
  const merged = [];
  const seen = new Set();
  for (const arr of rowArrays) {
    for (const row of arr || []) {
      const key = `${row?.source_url || ""}::${row?.chunk_text || ""}`;
      if (!row?.source_url || seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  return merged;
}

function buildBroadQuery(input) {
  const unique = extractKeywords(input, 4, 6);
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
      return `Kaynak ${i + 1}: ${r.title}\nİçerik Özeti:\n${snippet}`;
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
- URL paylaşma.
- "Kaynaklar", "İlgili makaleler" gibi bir başlık ekleme.

Soru: ${question}

Kaynaklar:
${context}

Cevap formatı:
1) Kısa yanıt
2) Gerekirse maddeler`;

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

function buildRelatedArticles(rows, question, limit = 5) {
  const ranked = rankRowsForQuestion(rows, question);
  const withTitleMatch = ranked.filter((row) => row._titleHits > 0);
  const bestSimilarity = Number(ranked?.[0]?.similarity || 0);
  const similarityFloor = bestSimilarity > 0 ? bestSimilarity * 0.55 : 0;

  let prioritized = ranked;
  if (withTitleMatch.length > 0) {
    prioritized = withTitleMatch;
  } else {
    prioritized = ranked.filter(
      (row) => Number(row.similarity || 0) >= similarityFloor && Number(row._chunkHitCount || 0) >= 1
    );
  }

  const unique = [];
  const seen = new Set();
  for (const row of prioritized) {
    if (!row?.source_url || seen.has(row.source_url)) continue;
    seen.add(row.source_url);
    unique.push({ title: row.title || "Makale", url: row.source_url });
    if (unique.length >= limit) break;
  }
  return unique;
}

function fallbackFromSources(rows, question) {
  const related = buildRelatedArticles(rows, question);
  if (!related.length) return "Bu konuda kaynaklarda bilgi bulamadım.";
  return "Bu soru için ilgili makaleler bulundu. İstersen listedeki bir makaleyi seç, sadece onun üzerinden net bir özet çıkarayım.";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/api/articles" || url.pathname === "/api/articles/")) {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || "50")));
      try {
        const items = await listArticles(env, limit);
        return json({ items });
      } catch (err) {
        return json({ error: "Istek islenemedi", detail: String(err) }, 500);
      }
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    try {
      const { message } = await request.json();
      if (!message || !message.trim()) return json({ error: "Mesaj boş olamaz" }, 400);
      const question = message.trim();
      const topK = Number(env.TOP_K || "8");
      const retrievalCount = Math.max(16, topK * 3);

      let rows = await retrieveChunks(env, question, retrievalCount);
      const broadQuery = buildBroadQuery(question);
      if (broadQuery) {
        const broadRows = await retrieveChunks(env, broadQuery, retrievalCount);
        rows = mergeRows(rows, broadRows);
      }

      if (!rows || rows.length === 0) {
        const fallbackQuery = buildBroadQuery(question);
        if (fallbackQuery) {
          rows = await retrieveChunks(env, fallbackQuery, retrievalCount);
        }
      }
      if (!rows || rows.length === 0) {
        const shorterQuery = extractKeywords(question, 3, 8).join(" OR ");
        if (shorterQuery) {
          rows = await retrieveChunks(env, shorterQuery, retrievalCount);
        }
      }

      let rankedRows = rankRowsForQuestion(rows, question);
      if (!rankedRows.length) {
        const broadQuery2 = buildBroadQuery(question);
        if (broadQuery2) {
          const broadOnly = await retrieveChunks(env, broadQuery2, retrievalCount);
          rankedRows = rankRowsForQuestion(broadOnly, question);
        }
      }

      const answerRows = rankedRows.slice(0, Math.max(10, topK + 4));
      let reply = "";
      try {
        reply = await generateAnswer(env.GEMINI_API_KEY, question, answerRows);
      } catch (llmErr) {
        reply = fallbackFromSources(answerRows, question);
      }

      const relatedArticles = buildRelatedArticles(rankedRows, question);
      const sources = relatedArticles.map((item) => item.url);
      return json({ reply, sources, relatedArticles });
    } catch (err) {
      return json({ error: "İstek işlenemedi", detail: String(err) }, 500);
    }
  }
};
