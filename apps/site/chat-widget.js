(() => {
  const API_URL = window.MG_CHAT_API_URL || 'https://mehmet-gulumser-chat.balaansre-dfd.workers.dev';

  const panel = document.createElement('div');
  panel.id = 'mg-chat-panel';
  panel.innerHTML = `
    <div id="mg-chat-head">
      <strong>Sohbet</strong>
      <button id="mg-chat-close" aria-label="Kapat" title="Kapat">✕</button>
    </div>
    <div id="mg-chat-log"><div class="msg bot">Merhaba, Mehmet Gülümser yazıları hakkında soru sorabilirsiniz.</div></div>
    <div id="mg-chat-input-row">
      <input id="mg-chat-input" placeholder="Bir soru yazın..." />
      <button id="mg-chat-send" aria-label="Gönder" title="Gönder">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M3 20.5l18-8.5L3 3.5v6l12 2.5-12 2.5z"></path>
        </svg>
      </button>
    </div>
  `;
  const btn = document.createElement('button');
  btn.id = 'mg-chat-btn';
  btn.textContent = 'CHAT';

  document.body.append(panel, btn);

  const log = panel.querySelector('#mg-chat-log');
  const input = panel.querySelector('#mg-chat-input');
  const send = panel.querySelector('#mg-chat-send');
  const closeBtn = panel.querySelector('#mg-chat-close');
  let pending = false;

  function setOpen(open) {
    panel.classList.toggle('open', open);
  }

  btn.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
  closeBtn.addEventListener('click', () => setOpen(false));

  function escapeHtml(text) {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function formatBotText(text) {
    let html = escapeHtml(text || '');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function add(text, who) {
    const d = document.createElement('div');
    d.className = `msg ${who}`;
    if (who === 'bot') {
      d.innerHTML = formatBotText(text);
    } else {
      d.textContent = text;
    }
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  async function typeBotMessage(text) {
    const container = add('', 'bot');
    const source = text || '';
    const chunkSize = 3;
    const delayMs = 14;
    for (let i = 0; i < source.length; i += chunkSize) {
      const partial = source.slice(0, i + chunkSize);
      container.innerHTML = formatBotText(partial);
      log.scrollTop = log.scrollHeight;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  function addThinking() {
    const d = document.createElement('div');
    d.className = 'msg bot thinking';
    d.innerHTML = 'Düşünüyor<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function addRelatedArticles(items) {
    if (!Array.isArray(items) || items.length === 0) return;

    const links = [];
    for (const item of items) {
      if (!item?.url) continue;
      const title = escapeHtml(item.title || 'Makale');
      const href = escapeHtml(item.url);
      links.push(`- <a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`);
    }
    if (!links.length) return;

    const d = document.createElement('div');
    d.className = 'msg bot';
    d.innerHTML = ['İlgili makaleler', ...links].join('<br>');
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  async function ask() {
    if (pending) return;
    const message = input.value.trim();
    if (!message) return;
    add(message, 'user');
    input.value = '';
    pending = true;
    send.disabled = true;
    const thinking = addThinking();

    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const data = await r.json();
      thinking.remove();
      await typeBotMessage(data.reply || data.error || 'Yanıt alınamadı.');
      addRelatedArticles(data.relatedArticles || []);
    } catch {
      thinking.remove();
      add('Servise ulaşılamadı.', 'bot');
    } finally {
      pending = false;
      send.disabled = false;
    }
  }

  send.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask();
  });
})();
