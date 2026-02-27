(() => {
  const API_URL = window.MG_CHAT_API_URL || 'https://mehmet-gulumser-chat.<YOUR_SUBDOMAIN>.workers.dev';

  const panel = document.createElement('div');
  panel.id = 'mg-chat-panel';
  panel.innerHTML = `
    <div id="mg-chat-log"><div class="msg bot">Merhaba, Mehmet Gülümser yazıları hakkında soru sorabilirsiniz.</div></div>
    <div id="mg-chat-input-row">
      <input id="mg-chat-input" placeholder="Bir soru yazın..." />
      <button id="mg-chat-send">Gönder</button>
    </div>
  `;
  const btn = document.createElement('button');
  btn.id = 'mg-chat-btn';
  btn.textContent = '💬';

  document.body.append(panel, btn);

  const log = panel.querySelector('#mg-chat-log');
  const input = panel.querySelector('#mg-chat-input');
  const send = panel.querySelector('#mg-chat-send');

  btn.addEventListener('click', () => panel.classList.toggle('open'));

  function add(text, who) {
    const d = document.createElement('div');
    d.className = `msg ${who}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  async function ask() {
    const message = input.value.trim();
    if (!message) return;
    add(message, 'user');
    input.value = '';

    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const data = await r.json();
      add(data.reply || data.error || 'Yanıt alınamadı.', 'bot');
    } catch {
      add('Servise ulaşılamadı.', 'bot');
    }
  }

  send.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask();
  });
})();
