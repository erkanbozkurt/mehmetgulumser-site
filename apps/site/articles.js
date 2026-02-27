(() => {
  const API_BASE = window.MG_CHAT_API_URL || 'https://mehmet-gulumser-chat.balaansre-dfd.workers.dev';

  const root = document.getElementById('mg-articles');
  const status = document.getElementById('mg-articles-status');
  const search = document.getElementById('mg-articles-search');

  if (!root || !status) return;

  function escapeHtml(text) {
    return (text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function siteLabel(host) {
    if ((host || '').includes('ajansbakircay')) return 'Ajans Bakircay';
    if ((host || '').includes('gazeteyenigun')) return 'Gazete Yenigun';
    return host || 'Kaynak';
  }

  function fmtDate(value) {
    if (!value) return '';
    try {
      const d = new Date(value);
      return d.toLocaleDateString('tr-TR', { year: 'numeric', month: 'short', day: '2-digit' });
    } catch {
      return '';
    }
  }

  function render(items) {
    root.innerHTML = '';

    for (const it of items) {
      const el = document.createElement('article');
      el.className = 'article-item';

      const title = escapeHtml(it.title);
      const label = escapeHtml(siteLabel(it.source_site));
      const date = escapeHtml(fmtDate(it.published_at));
      const excerpt = escapeHtml(it.excerpt || '');

      el.innerHTML = `
        <h3>${title}</h3>
        <p class="meta">${label}${date ? ' · ' + date : ''}</p>
        ${excerpt ? `<p class="meta">${excerpt}</p>` : ''}
        <a href="${it.source_url}" target="_blank" rel="noopener noreferrer">Yaziyi oku</a>
      `;

      root.appendChild(el);
    }
  }

  async function load() {
    status.textContent = 'Yazilar yukleniyor...';

    const r = await fetch(`${API_BASE}/api/articles?limit=100`, { method: 'GET' });
    if (!r.ok) throw new Error('Liste alinamadi');

    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];

    status.textContent = `${items.length} yazi bulundu.`;

    const applyFilter = () => {
      const q = (search?.value || '').trim().toLocaleLowerCase('tr-TR');
      if (!q) {
        render(items);
        return;
      }
      const filtered = items.filter((x) => (x.title || '').toLocaleLowerCase('tr-TR').includes(q));
      status.textContent = `${filtered.length} yazi bulundu.`;
      render(filtered);
    };

    if (search) search.addEventListener('input', applyFilter);
    applyFilter();
  }

  load().catch(() => {
    status.textContent = 'Yazilar yuklenemedi. Daha sonra tekrar deneyin.';
  });
})();
