(() => {
  const el = document.getElementById('mg-phone');
  if (!el) return;

  const parts = ['p0', 'p1', 'p2', 'p3', 'p4'].map((k) => (el.dataset[k] || '').trim());
  const pretty = `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]} ${parts[4]}`.replace(/\s+/g, ' ').trim();
  const tel = (parts.join('')).replace(/\s+/g, '');

  const a = document.createElement('a');
  a.href = `tel:${tel}`;
  a.textContent = pretty;
  a.rel = 'nofollow';
  el.appendChild(a);
})();
