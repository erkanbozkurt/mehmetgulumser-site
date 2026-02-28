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

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
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

async function callSupabaseRpc(env, fnName, payload) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Supabase RPC ${fnName} error: ${r.status} ${detail}`);
  }
  return r.json();
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
  return callSupabaseRpc(env, "match_article_chunks_fts", {
    query_text: queryText,
    match_count: Number(matchCount || env.TOP_K || "8")
  });
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

function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp.trim();
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown-ip";
}

async function getClientHash(request) {
  const ip = getClientIp(request);
  const ua = (request.headers.get("user-agent") || "unknown-ua").slice(0, 180);
  const raw = `${ip}|${ua}`;
  const hash = await sha256Hex(raw);
  return hash.slice(0, 40);
}

function limitMessage(reason) {
  if (reason === "ip_minute_limit") {
    return "Cok hizli soru gonderildi. Lutfen kisa bir sure bekleyip tekrar deneyin.";
  }
  if (reason === "daily_request_limit") {
    return "Gunluk sohbet limiti doldu. Lutfen yarin tekrar deneyin.";
  }
  if (reason === "monthly_request_limit") {
    return "Aylik sohbet limiti doldu. Lutfen sonraki ay tekrar deneyin.";
  }
  if (reason === "daily_token_limit") {
    return "Gunluk yapay zeka butcesi doldu. Lutfen yarin tekrar deneyin.";
  }
  if (reason === "monthly_token_limit") {
    return "Aylik yapay zeka butcesi doldu. Lutfen sonraki ay tekrar deneyin.";
  }
  return "Sohbet gecici olarak limitlendi. Lutfen daha sonra tekrar deneyin.";
}

async function enforceChatGuard(env, clientHash) {
  const minuteLimit = toPositiveInt(env.MAX_REQ_PER_MINUTE_PER_IP, 6);
  const dayReqLimit = toPositiveInt(env.MAX_REQ_PER_DAY, 400);
  const monthReqLimit = toPositiveInt(env.MAX_REQ_PER_MONTH, 8000);
  const dayTokenLimit = toPositiveInt(env.MAX_TOKENS_PER_DAY, 350000);
  const monthTokenLimit = toPositiveInt(env.MAX_TOKENS_PER_MONTH, 7000000);

  const rows = await callSupabaseRpc(env, "enforce_chat_guard", {
    p_client_hash: clientHash,
    p_max_req_per_minute: minuteLimit,
    p_max_req_per_day: dayReqLimit,
    p_max_req_per_month: monthReqLimit,
    p_max_tokens_per_day: dayTokenLimit,
    p_max_tokens_per_month: monthTokenLimit
  });
  const result = Array.isArray(rows) ? rows[0] : rows;
  if (!result) return { allowed: false, reason: "guard_unknown", retryAfter: 30 };
  return {
    allowed: Boolean(result.allowed),
    reason: result.reason || "",
    retryAfter: toPositiveInt(result.retry_after_seconds, 0)
  };
}

async function recordChatTokens(env, usage) {
  const promptTokens = toPositiveInt(usage?.promptTokens, 0);
  const outputTokens = toPositiveInt(usage?.outputTokens, 0);
  const totalTokens = toPositiveInt(usage?.totalTokens, promptTokens + outputTokens);
  if (!promptTokens && !outputTokens && !totalTokens) return;

  await callSupabaseRpc(env, "record_chat_tokens", {
    p_prompt_tokens: promptTokens,
    p_output_tokens: outputTokens,
    p_total_tokens: totalTokens
  });
}

async function generateAnswer(apiKey, question, rows) {
  if (!rows || rows.length === 0) {
    return {
      text: "Bu konuda kaynaklarda bilgi bulamadım.",
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 }
    };
  }

  const topRows = (rows || []).slice(0, 6);
  const context = topRows
    .map((r, i) => {
      const snippet = (r.chunk_text || "").slice(0, 1400);
      const label = i === 0
        ? "Ana Makale"
        : (Number(r._titleHits || 0) > 0 ? "Baslik Eslesmeli Makale" : "Ilgili Makale");
      return `${label} ${i + 1}: ${r.title}\nIcerik Ozeti:\n${snippet}`;
    })
    .join("\n\n");

  const prompt = `Sen Mehmet Gulumser'in web sitesindeki dijital asistansin.

Kurallar:
- Sadece verilen kaynaklara dayan.
- Bilgi yoksa net olarak "Bu konuda kaynaklarda bilgi bulamadim." de.
- Cevap Turkce, derli toplu ve anlasilir olsun.
- Gerekliyse 3-6 maddede ozetle.
- Cevapta once "Ana Makale" bilgisini temel al, sonra diger ilgili makalelerle destekle.
- Markdown isaretleri kullanma (**, __, ##, * gibi).
- Duz metin yaz; maddeleme icin sadece "-" kullan.
- URL paylasma.
- "Kaynaklar", "Ilgili makaleler" gibi bir baslik ekleme.

Soru: ${question}

Kaynaklar:
${context}

Cevap formati:
1) Kisa yanit
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
    throw new Error("RATE_LIMIT");
  }
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Gemini API error: ${r.status} ${detail}`);
  }

  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Yanit uretilemedi.";
  const usageMeta = data?.usageMetadata || {};
  const promptTokens = toPositiveInt(
    usageMeta.promptTokenCount ?? usageMeta.inputTokenCount,
    0
  );
  const outputTokens = toPositiveInt(
    usageMeta.candidatesTokenCount ?? usageMeta.outputTokenCount,
    0
  );
  const totalTokens = toPositiveInt(
    usageMeta.totalTokenCount,
    promptTokens + outputTokens
  );

  return {
    text,
    usage: { promptTokens, outputTokens, totalTokens }
  };
}

function sentenceSplit(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 35 && s.length <= 320);
}

function buildExtractiveAnswer(question, rows) {
  if (!rows || rows.length === 0) return "Bu konuda kaynaklarda bilgi bulamadım.";

  const keywords = extractKeywords(question, 3, 8);
  const scored = [];
  const seen = new Set();

  for (const row of rows.slice(0, 8)) {
    const sim = Number(row.similarity || 0);
    const sentences = sentenceSplit(row.chunk_text);
    for (const sentence of sentences) {
      const norm = normalizeForMatch(sentence);
      if (seen.has(norm)) continue;
      seen.add(norm);
      const hits = countKeywordHits(norm, keywords);
      const score = (hits * 2) + sim;
      if (hits > 0 || scored.length < 8) {
        scored.push({ sentence, score });
      }
    }
  }

  const best = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => `- ${x.sentence}`);

  if (!best.length) {
    return "Bu konuda kaynaklarda net bilgi bulamadım.";
  }

  return [
    "Gemini kotasi dolu oldugu icin kaynaklardan hizli ozet modunda cevap veriyorum:",
    ...best
  ].join("\n");
}

function buildRelatedArticles(rows, question, limit = 5) {
  const ranked = rankRowsForQuestion(rows, question);
  const withTitleMatch = ranked.filter((row) => row._titleHits > 0);
  const withoutTitleMatch = ranked.filter((row) => row._titleHits === 0);
  const bestSimilarity = Number(ranked?.[0]?.similarity || 0);
  const strictFloor = bestSimilarity > 0 ? bestSimilarity * 0.82 : 0;
  const baseFloor = bestSimilarity > 0 ? bestSimilarity * 0.58 : 0;

  let prioritized = ranked;
  if (withTitleMatch.length > 0) {
    const strongSupport = withoutTitleMatch.filter(
      (row) =>
        Number(row.similarity || 0) >= strictFloor &&
        Number(row._chunkHitCount || 0) >= 2
    );
    prioritized = [...withTitleMatch, ...strongSupport.slice(0, 2)];
  } else {
    prioritized = ranked.filter(
      (row) => Number(row.similarity || 0) >= baseFloor && Number(row._chunkHitCount || 0) >= 1
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
  return "Bu soru için ilgili makaleler bulundu. Istersen listedeki bir makaleyi sec, sadece onun uzerinden net bir ozet cikarayim.";
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
      if (!message || !message.trim()) return json({ error: "Mesaj bos olamaz" }, 400);
      const question = message.trim();

      const clientHash = await getClientHash(request);
      const guard = await enforceChatGuard(env, clientHash);
      if (!guard.allowed) {
        return json({
          error: limitMessage(guard.reason),
          code: guard.reason || "guard_rejected",
          retryAfter: guard.retryAfter || 0
        }, 429);
      }

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

      const answerRows = rankedRows.slice(0, Math.max(8, topK + 2));
      let reply = "";
      let usage = null;
      try {
        const llm = await generateAnswer(env.GEMINI_API_KEY, question, answerRows);
        reply = llm.text;
        usage = llm.usage;
      } catch (llmErr) {
        const msg = String(llmErr || "");
        if (msg.includes("RATE_LIMIT")) {
          reply = buildExtractiveAnswer(question, answerRows);
        } else {
          reply = fallbackFromSources(answerRows, question);
        }
      }

      if (usage) {
        try {
          await recordChatTokens(env, usage);
        } catch {
          // Token kaydi basarisiz olsa da ana yaniti engelleme.
        }
      }

      const relatedArticles = buildRelatedArticles(rankedRows, question);
      const sources = relatedArticles.map((item) => item.url);
      return json({ reply, sources, relatedArticles });
    } catch (err) {
      return json({ error: "Istek islenemedi", detail: String(err) }, 500);
    }
  }
};
