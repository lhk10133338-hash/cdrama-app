/* CDRAMA — 중국 드라마 PWA
 * 데이터: data/dramas.json (scripts/fetch_dramas.py 가 생성)
 */
(() => {
  'use strict';

  const DATA_URL = 'data/dramas.json';
  const LS = {
    progress: 'cdrama.progress.v1',
    fav: 'cdrama.fav.v1',
    history: 'cdrama.history.v1',
    seen: 'cdrama.seen.v1'
  };
  const YT_PARAMS = {
    cc_load_policy: 1,
    cc_lang_pref: 'ko',
    hl: 'ko',
    playsinline: 1,
    controls: 0,
    fs: 0,
    disablekb: 1,
    rel: 0,
    modestbranding: 1,
    iv_load_policy: 3,
    enablejsapi: 1
  };
  const GENRE_LABEL = {
    '사극': '사극·무협', '판타지': '판타지', '미스터리': '미스터리', '액션': '액션',
    '로맨스': '로맨스', '코미디': '코미디', '의학': '의학', '법정': '법정', '가족': '가족',
    '현대극': '현대극'
  };

  const state = {
    data: null,
    route: { name: 'home', params: {} },
    explore: { q: '', genre: 'all', channel: 'all' },
    libTab: 'continue',
    hero: { index: 0, timer: null, count: 0 },
    player: null,
    progressTimer: null,
    uiTimer: null,
    ccOn: true,
    ccLang: 'ko',
    ccSize: 0,
    quality: 'highres',
    rate: 1,
    seeking: false,
    ytPromise: null,
    current: { drama: null, ep: null }
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------------- 저장소 ---------------- */
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 실패 무시 */ }
  }
  const store = {
    progress: () => read(LS.progress, {}),
    setProgress(map) { write(LS.progress, map); },
    fav: () => read(LS.fav, []),
    setFav(list) { write(LS.fav, list); },
    seen: () => read(LS.seen, {}),
    setSeen(map) { write(LS.seen, map); },
    history: () => read(LS.history, []),
    setHistory(list) { write(LS.history, list.slice(0, 40)); }
  };

  /* ---------------- 유틸 ---------------- */
  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDur(sec) {
    if (!sec || sec < 60) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
  }
  function timecode(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function agoText(sec) {
    if (sec == null) return '';
    const d = Math.floor(sec / 86400);
    if (d < 1) return '오늘';
    if (d < 7) return `${d}일 전`;
    if (d < 30) return `${Math.floor(d / 7)}주 전`;
    if (d < 365) return `${Math.floor(d / 30)}개월 전`;
    return `${Math.floor(d / 365)}년 전`;
  }
  const ytThumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
  function posterOf(d, big) {
    return big ? (d.thumbnail || ytThumb(d.posterVideoId, 'maxresdefault')) : ytThumb(d.posterVideoId, 'mqdefault');
  }
  window.imgFallback = function (img) {
    const id = img.dataset.vid;
    const step = img.dataset.step || '';
    if (!id) { img.onerror = null; img.style.visibility = 'hidden'; return; }
    if (step === '') {
      img.dataset.step = '1';
      img.src = ytThumb(id, 'hqdefault');
      return;
    }
    if (step === '1') {
      img.dataset.step = '2';
      img.src = ytThumb(id, 'default');
      return;
    }
    img.onerror = null;
    img.style.visibility = 'hidden';
  };
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 1900);
  }
  function dramaById(id) {
    return state.data ? state.data.dramas.find(d => d.id === id) : null;
  }
  function percentWatched(dramaId, epN) {
    const p = store.progress()[dramaId];
    if (!p || p.ep !== epN || !p.dur) return 0;
    return Math.min(100, Math.round((p.time / p.dur) * 100));
  }
  function isSeen(dramaId, epN) {
    const seen = store.seen()[dramaId];
    return !!(seen && seen[epN]);
  }
  function watchedCount(drama) {
    const seen = store.seen()[drama.id] || {};
    return drama.episodes.filter(e => seen[e.n]).length;
  }
  function channelCaptions(d) {
    if (!state.data || !state.data.channels) return null;
    const ch = state.data.channels.find(c => c.key === d.channelKey);
    return ch ? ch.captionsKoDefault : null;
  }
  function koBadge(d) {
    const v = d.verified || {};
    if (v.captionsKo === true) return '<span class="badge ko">한국어 자막</span>';
    if (v.captionsAny === true && v.captionsKo !== false) return '<span class="badge ko">자막 지원</span>';
    if (v.captionsAny === false) return '<span class="badge">자막 없음</span>';
    if (channelCaptions(d) === true) return '<span class="badge ko">한국어 자막</span>';
    return '';
  }
  function primaryGenre(d) {
    return (d.genres && d.genres[0]) || '드라마';
  }

  /* ---------------- 라우터 ---------------- */
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    if (!parts.length) return { name: 'home', params: {} };
    if (parts[0] === 'drama' && parts[1]) return { name: 'detail', params: { id: decodeURIComponent(parts[1]) } };
    if (parts[0] === 'watch' && parts[1]) {
      return { name: 'watch', params: { id: decodeURIComponent(parts[1]), ep: parts[2] ? Number(parts[2]) : null } };
    }
    if (['explore', 'library', 'home'].includes(parts[0])) return { name: parts[0], params: {} };
    return { name: 'home', params: {} };
  }

  function go(hash) {
    if (location.hash === hash) { render(); return; }
    location.hash = hash;
  }

  function onRoute() {
    const prev = state.route;
    state.route = parseHash();
    if (prev.name === 'watch' && state.route.name !== 'watch') destroyPlayer();
    render();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* ---------------- 공통 조각 ---------------- */
  function cardHTML(d, opts = {}) {
    const p = store.progress()[d.id];
    const pct = p && p.dur ? Math.min(100, Math.round((p.time / p.dur) * 100)) : 0;
    const seenCount = watchedCount(d);
    const badge = koBadge(d);
    return `
      <a class="card" href="#/drama/${encodeURIComponent(d.id)}">
        <div class="card-thumb">
          <img src="${posterOf(d)}" alt="${esc(d.title)}" loading="lazy" data-vid="${d.posterVideoId}" onerror="imgFallback(this)">
          <span class="epcount">${d.episodeCount}화</span>
          <span class="dur">${esc(fmtDur(d.avgDurationSec) || '')}</span>
          ${pct ? `<span class="progress"><i style="width:${pct}%"></i></span>` : ''}
        </div>
        <p class="card-title">${esc(d.title)}</p>
        <div class="card-meta">
          ${badge || `<span>${esc(primaryGenre(d))}</span>`}
          ${seenCount ? `<span>· ${seenCount}화 시청</span>` : ''}
        </div>
      </a>`;
  }

  function rowHTML(title, sub, items, moreHash) {
    if (!items.length) return '';
    return `
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">${esc(title)}</h2>
          ${moreHash ? `<a class="section-more" href="${moreHash}">전체보기 ›</a>` : (sub ? `<span class="section-sub">${esc(sub)}</span>` : '')}
        </div>
        <div class="row">${items.map(d => cardHTML(d)).join('')}</div>
      </section>`;
  }

  function platformRows(dramas) {
    const channels = Array.from(new Set(dramas.map(d => d.channel)));
    return channels.map(ch => {
      const items = dramas.filter(d => d.channel === ch).slice(0, 12);
      if (items.length < 3) return '';
      const handle = (items[0].channelHandle || '').replace('@', '');
      return rowHTML(ch, handle ? '@' + handle : '', items, '#/explore');
    }).join('');
  }

  function gridHTML(items) {
    if (!items.length) {
      return `<div class="empty"><div class="big">🍿</div><p>조건에 맞는 작품이 없어요.</p><p>다른 장르나 검색어로 찾아보세요.</p></div>`;
    }
    return `<div class="grid">${items.map(d => cardHTML(d)).join('')}</div>`;
  }

  /* ---------------- 홈 ---------------- */
  function renderHome() {
    const dramas = state.data.dramas;
    const heroItems = dramas.slice(0, 5);
    const continueList = continueWatching();
    const fresh = dramas.filter(d => d.updatedAgoSec != null)
      .sort((a, b) => (a.updatedAgoSec || 1e12) - (b.updatedAgoSec || 1e12))
      .slice(0, 12);
    const korean = dramas.filter(d => /korea/.test(d.channelKey || '')).slice(0, 12);
    const long = [...dramas].sort((a, b) => b.episodeCount - a.episodeCount).slice(0, 12);
    const genreRows = ['사극', '로맨스', '미스터리', '판타지', '현대극', '액션']
      .map(g => ({ g, items: dramas.filter(d => (d.genres || []).includes(g)).slice(0, 12) }))
      .filter(x => x.items.length >= 3);

    const view = $('#view');
    view.innerHTML = `
      <div class="screen">
        <div class="hero" id="hero">
          <div class="hero-track" id="heroTrack">
            ${heroItems.map(d => `
              <div class="hero-slide">
                <img src="${posterOf(d, true)}" alt="${esc(d.title)}" data-vid="${d.posterVideoId}" onerror="imgFallback(this)">
                <div class="hero-body">
                  <div class="hero-badges">
                    ${koBadge(d)}
                    <span class="badge update">${esc(d.updatedText || '신작')}</span>
                    <span class="badge genre">${esc(primaryGenre(d))}</span>
                  </div>
                  <h3 class="hero-title">${esc(d.title)}</h3>
                  <div class="hero-meta">
                    <span>${d.episodeCount}화 공개</span>
                    <span>·</span>
                    <span>${esc(d.channel)}</span>
                  </div>
                  <div class="hero-cta">
                    <a class="btn btn-primary" href="#/watch/${encodeURIComponent(d.id)}/${firstEp(d)}">
                      <svg viewBox="0 0 24 24" width="17" height="17"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
                      재생
                    </a>
                    <a class="btn btn-ghost" href="#/drama/${encodeURIComponent(d.id)}">상세보기</a>
                  </div>
                </div>
              </div>`).join('')}
          </div>
          <div class="hero-dots" id="heroDots">
            ${heroItems.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}
          </div>
        </div>

        ${continueList.length ? `
        <section class="section">
          <div class="section-head"><h2 class="section-title">계속 시청하기</h2><a class="section-more" href="#/library">전체보기 ›</a></div>
          <div class="row">
            ${continueList.map(({ drama, ep, pct, time }) => `
              <a class="card" href="#/watch/${encodeURIComponent(drama.id)}/${ep.n}">
                <div class="card-thumb">
                  <img src="${ytThumb(ep.videoId)}" alt="${esc(drama.title)}" loading="lazy" data-vid="${ep.videoId}" onerror="imgFallback(this)">
                  <span class="epcount">${ep.n}화</span>
                  <span class="dur">${esc(timecode(time))} / ${esc(ep.duration || '')}</span>
                  <span class="progress"><i style="width:${pct}%"></i></span>
                </div>
                <p class="card-title">${esc(drama.title)}</p>
                <div class="card-meta"><span>${pct}% 시청</span></div>
              </a>`).join('')}
          </div>
        </section>` : ''}

        ${rowHTML('최신 업데이트', '새 회차가 올라온 작품', fresh, '#/explore')}
        ${rowHTML('한국어 자막 추천', 'iQIYI Korea · WeTV Korea · YOUKU Korea', korean, '#/explore')}
        ${rowHTML('정주행 추천', '회차가 많은 작품', long, '#/explore')}
        ${genreRows.map(({ g, items }) => rowHTML(GENRE_LABEL[g] || g, '', items, '#/explore')).join('')}
        ${platformRows(dramas)}

        <p class="section-sub" style="padding:18px 16px 0;font-size:11.5px;color:var(--muted-2)">
          데이터 갱신 ${esc((state.data.generatedAt || '').slice(0, 10))} · ${dramas.length}개 작품 · YouTube 공식 채널
        </p>
      </div>`;

    startHero(heroItems.length);
    bindHeroSwipe();
  }

  function firstEp(d) {
    const p = store.progress()[d.id];
    if (p && p.ep) return p.ep;
    if (d.episodes && d.episodes.length) return d.episodes[0].n;
    return 1;
  }

  function continueWatching() {
    const progress = store.progress();
    const out = [];
    Object.keys(progress).forEach(id => {
      const drama = dramaById(id);
      const p = progress[id];
      if (!drama || !p) return;
      const ep = drama.episodes.find(e => e.n === p.ep);
      if (!ep) return;
      const dur = p.dur || ep.durationSec || 0;
      const pct = dur ? Math.round((p.time / dur) * 100) : 0;
      if (pct >= 96) return;
      out.push({ drama, ep, pct, time: p.time, at: p.at || 0 });
    });
    return out.sort((a, b) => b.at - a.at).slice(0, 10);
  }

  function startHero(count) {
    stopHero();
    state.hero.count = count;
    state.hero.index = 0;
    if (count < 2) return;
    state.hero.timer = setInterval(() => {
      const next = (state.hero.index + 1) % state.hero.count;
      moveHero(next);
    }, 5200);
  }
  function bindHeroSwipe() {
    const hero = $('#hero');
    if (!hero) return;
    let startX = 0;
    let startY = 0;
    let moved = false;
    hero.addEventListener('touchstart', (ev) => {
      const t = ev.touches[0];
      startX = t.clientX; startY = t.clientY; moved = false;
      stopHero();
    }, { passive: true });
    hero.addEventListener('touchmove', (ev) => {
      const t = ev.touches[0];
      if (Math.abs(t.clientX - startX) > 12 && Math.abs(t.clientX - startX) > Math.abs(t.clientY - startY)) {
        moved = true;
      }
    }, { passive: true });
    hero.addEventListener('touchend', (ev) => {
      const t = ev.changedTouches[0];
      const dx = t.clientX - startX;
      if (moved && Math.abs(dx) > 40 && state.hero.count) {
        const next = dx < 0
          ? Math.min(state.hero.index + 1, state.hero.count - 1)
          : Math.max(state.hero.index - 1, 0);
        moveHero(next);
      }
      startHero(state.hero.count);
    }, { passive: true });
  }

  function stopHero() {
    if (state.hero.timer) clearInterval(state.hero.timer);
    state.hero.timer = null;
  }
  function moveHero(index) {
    const track = $('#heroTrack');
    if (!track) return;
    state.hero.index = index;
    track.style.transform = `translateX(-${index * 100}%)`;
    const dots = $$('#heroDots i');
    dots.forEach((dot, i) => dot.classList.toggle('on', i === index));
  }

  /* ---------------- 탐색 ---------------- */
  function renderExplore() {
    const dramas = state.data.dramas;
    const genres = ['all', ...(state.data.genres || [])];
    const channels = ['all', ...Array.from(new Set(dramas.map(d => d.channel)))];
    const filtered = filterDramas();
    $('#view').innerHTML = `
      <div class="screen with-search">
        <div class="searchbar">
          <label class="search-input">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
            <input id="q" type="search" inputmode="search" placeholder="작품·배우·채널 검색" value="${esc(state.explore.q)}" autocomplete="off">
            <button class="clear" id="qClear" aria-label="지우기" ${state.explore.q ? '' : 'hidden'}>×</button>
          </label>
        </div>
        <div class="chips" id="genreChips">
          ${genres.map(g => `<button class="chip ${state.explore.genre === g ? 'on' : ''}" data-genre="${esc(g)}">${g === 'all' ? '전체' : esc(GENRE_LABEL[g] || g)}</button>`).join('')}
        </div>
        <div class="chips" id="channelChips" style="padding-top:2px">
          ${channels.map(c => `<button class="chip ${state.explore.channel === c ? 'on' : ''}" data-channel="${esc(c)}">${c === 'all' ? '모든 채널' : esc(c)}</button>`).join('')}
        </div>
        <div class="section-head" style="margin-top:14px">
          <h2 class="section-title" style="font-size:14.5px">${state.explore.q ? `'${esc(state.explore.q)}' 검색결과` : '작품'}</h2>
          <span class="section-sub">${filtered.length}개</span>
        </div>
        ${gridHTML(filtered)}
      </div>`;

    const input = $('#q');
    if (!input) return;
    input.addEventListener('input', () => {
      state.explore.q = input.value.trim();
      const list = filterDramas();
      const grid = $('.grid') || $('.empty');
      const holder = document.createElement('div');
      holder.innerHTML = gridHTML(list);
      if (grid) grid.replaceWith(holder.firstElementChild);
      const countEl = $('.section-sub');
      if (countEl) countEl.textContent = `${list.length}개`;
      const cb = $('#qClear');
      if (cb) cb.hidden = !state.explore.q;
    });
    const clearBtn = $('#qClear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      state.explore.q = '';
      renderExplore();
      setTimeout(() => $('#q') && $('#q').focus(), 30);
    });
    const genreChips = $('#genreChips');
    if (genreChips) genreChips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-genre]');
      if (!btn) return;
      state.explore.genre = btn.dataset.genre;
      renderExplore();
    });
    const channelChips = $('#channelChips');
    if (channelChips) channelChips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-channel]');
      if (!btn) return;
      state.explore.channel = btn.dataset.channel;
      renderExplore();
    });
  }

  function filterDramas() {
    const { q, genre, channel } = state.explore;
    const needle = q.toLowerCase();
    return state.data.dramas.filter(d => {
      if (genre !== 'all' && !(d.genres || []).includes(genre)) return false;
      if (channel !== 'all' && d.channel !== channel) return false;
      if (!needle) return true;
      const hay = [d.title, d.titleEn, d.titleZh, d.channel, d.synopsis, (d.genres || []).join(' ')]
        .join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }

  /* ---------------- 보관함 ---------------- */
  function renderLibrary() {
    const favs = store.fav().map(id => dramaById(id)).filter(Boolean);
    const history = continueWatching();
    const seenAll = store.seen();
    const tab = state.libTab;
    $('#view').innerHTML = `
      <div class="screen">
        <div style="padding:16px 16px 0"><h1 class="section-title" style="font-size:20px">내 보관함</h1></div>
        <div class="lib-tabs">
          <button class="seg ${tab === 'continue' ? 'on' : ''}" data-lib="continue">이어보기 ${history.length ? `(${history.length})` : ''}</button>
          <button class="seg ${tab === 'fav' ? 'on' : ''}" data-lib="fav">찜한 작품 ${favs.length ? `(${favs.length})` : ''}</button>
        </div>
        ${tab === 'continue' ? `
          ${history.length ? history.map(({ drama, ep, pct, time }) => `
            <a class="continue-card" href="#/watch/${encodeURIComponent(drama.id)}/${ep.n}">
              <div class="thumb">
                <img src="${ytThumb(ep.videoId)}" alt="" loading="lazy" data-vid="${ep.videoId}" onerror="imgFallback(this)">
                <span class="progress"><i style="width:${pct}%"></i></span>
              </div>
              <div class="info">
                <div class="name">${esc(drama.title)}</div>
                <div class="meta">${ep.n}화 · ${esc(timecode(time))} / ${esc(ep.duration || '')} · ${pct}%</div>
              </div>
            </a>`).join('') : emptyBlock('⏱️', '아직 시청 기록이 없어요', '작품을 재생하면 이어볼 수 있게 저장됩니다.')}
        ` : `
          ${favs.length ? gridHTML(favs) : emptyBlock('🤍', '찜한 작품이 없어요', '상세 화면에서 하트를 눌러 저장해 보세요.')}
        `}
        ${Object.keys(seenAll).length ? `
          <div class="section-head" style="margin-top:20px"><h2 class="section-title" style="font-size:15px">시청 완료</h2></div>
          <div class="row">
            ${Object.keys(seenAll).map(id => dramaById(id)).filter(Boolean).slice(0, 12).map(d => cardHTML(d)).join('')}
          </div>` : ''}
      </div>`;
    $$('[data-lib]').forEach(btn => btn.addEventListener('click', () => {
      state.libTab = btn.dataset.lib;
      renderLibrary();
    }));
  }

  function emptyBlock(icon, title, desc) {
    return `<div class="empty"><div class="big">${icon}</div><p style="color:#dfe3e7;font-weight:700">${esc(title)}</p><p>${esc(desc)}</p></div>`;
  }

  /* ---------------- 상세 ---------------- */
  function renderDetail() {
    const drama = dramaById(state.route.params.id);
    if (!drama) { $('#view').innerHTML = emptyBlock('😢', '작품을 찾을 수 없어요', '목록에서 다시 선택해 주세요.'); return; }
    const fav = store.fav().includes(drama.id);
    const prog = store.progress()[drama.id];
    const resumeEp = prog ? drama.episodes.find(e => e.n === prog.ep) : null;
    const targetEp = resumeEp ? resumeEp.n : firstEp(drama);
    const playLabel = resumeEp && percentWatched(drama.id, resumeEp.n) > 2 ? `${resumeEp.n}화 이어보기` : '재생하기';
    const seenCount = watchedCount(drama);
    const latest = drama.episodes.slice(-6).reverse();

    $('#view').innerHTML = `
      <div class="screen">
        <div class="detail-hero">
          <img class="backdrop" src="${posterOf(drama, true)}" alt="" data-vid="${drama.posterVideoId}" onerror="imgFallback(this)">
        </div>
        <div class="detail-head">
          <h1 class="detail-title">${esc(drama.title)}</h1>
          <div class="detail-sub">
            ${koBadge(drama) || ''}
            <span class="badge genre">${esc(primaryGenre(drama))}</span>
            <span>총 ${drama.episodeCount}화 수록</span>
            <span class="dot"></span>
            <span>${esc(drama.channel)}</span>
            ${drama.updatedText ? `<span class="dot"></span><span>${esc(drama.updatedText)} 업데이트</span>` : ''}
          </div>
          ${drama.titleZh || drama.titleEn ? `<div class="detail-sub" style="margin-top:-4px;color:var(--muted)">${esc([drama.titleEn, drama.titleZh].filter(Boolean).join(' · '))}</div>` : ''}
          <div class="detail-actions">
            <a class="btn btn-primary" href="#/watch/${encodeURIComponent(drama.id)}/${targetEp}">
              <svg viewBox="0 0 24 24" width="17" height="17"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
              ${esc(playLabel)}
            </a>
            <button class="btn icon ${fav ? 'on' : ''}" data-fav="${drama.id}" aria-label="찜하기">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.9"><path d="M12 20.5s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 3.3c0 5-7.5 9.6-7.5 9.6z"/></svg>
            </button>
            <a class="btn icon" href="https://www.youtube.com/playlist?list=${encodeURIComponent(drama.playlistId)}" target="_blank" rel="noopener" aria-label="YouTube에서 보기">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2C2 8.9 2 12 2 12s0 3.1.4 4.8a2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2C22 15.1 22 12 22 12s0-3.1-.4-4.8zM10 15.5v-7l6 3.5z"/></svg>
            </a>
          </div>
        </div>

        ${drama.synopsis ? `
          <p class="synopsis clamp" id="syn">${esc(drama.synopsis)}</p>
          <button class="synopsis-more" id="synMore">줄거리 더보기</button>` : ''}

        <section class="section">
          <div class="section-head">
            <h2 class="section-title">회차</h2>
            <span class="section-sub">${seenCount}/${drama.episodeCount}화 시청</span>
          </div>
          <div class="ep-grid">
            ${drama.episodes.map(e => `
              <a class="ep-cell ${seenCount && isSeen(drama.id, e.n) ? 'seen' : ''} ${resumeEp && resumeEp.n === e.n ? 'on' : ''}"
                 href="#/watch/${encodeURIComponent(drama.id)}/${e.n}">${e.n}</a>`).join('')}
          </div>
        </section>

        <section class="section" style="margin-top:4px">
          <div class="section-head"><h2 class="section-title" style="font-size:15px">최근 회차</h2><a class="section-more" href="#/watch/${encodeURIComponent(drama.id)}/${targetEp}">시청하기 ›</a></div>
          <div class="ep-list">
            ${latest.map(e => `
              <a class="ep-row" href="#/watch/${encodeURIComponent(drama.id)}/${e.n}">
                <div class="thumb">
                  <img src="${e.thumb}" alt="" loading="lazy" data-vid="${e.videoId}" onerror="imgFallback(this)">
                  <span class="dur">${esc(e.duration || '')}</span>
                </div>
                <div class="info">
                  <div class="name">${e.n}화</div>
                  <div class="meta">${esc(e.publishedText || '')} ${isSeen(drama.id, e.n) ? '· <span class="state">시청 완료</span>' : ''}</div>
                </div>
              </a>`).join('')}
          </div>
        </section>

        <p class="section-sub" style="padding:14px 16px 0;font-size:11.5px;color:var(--muted-2)">
          ${esc(drama.channel)} · YouTube 재생 · 자막은 플레이어 설정에서 바꿀 수 있어요.
        </p>
      </div>`;

    const favBtn = $('[data-fav]');
    if (favBtn) favBtn.addEventListener('click', () => toggleFav(drama.id));
    const more = $('#synMore');
    if (more) more.addEventListener('click', () => {
      const syn = $('#syn');
      syn.classList.toggle('clamp');
      more.textContent = syn.classList.contains('clamp') ? '줄거리 더보기' : '접기';
    });
  }

  function toggleFav(id) {
    const favs = store.fav();
    const idx = favs.indexOf(id);
    if (idx >= 0) { favs.splice(idx, 1); toast('찜 목록에서 삭제했어요'); }
    else { favs.unshift(id); toast('찜 목록에 담았어요'); }
    store.setFav(favs);
    if (state.route.name === 'detail') renderDetail();
    else if (state.route.name === 'library') renderLibrary();
  }

  /* ---------------- 플레이어 ---------------- */
  function loadYT() {
    if (state.ytPromise) return state.ytPromise;
    state.ytPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      document.head.appendChild(tag);
    });
    return state.ytPromise;
  }

  function renderWatch() {
    if (state.player) destroyPlayer();
    const drama = dramaById(state.route.params.id);
    if (!drama) { $('#view').innerHTML = emptyBlock('😢', '작품을 찾을 수 없어요', ''); return; }
    const epN = state.route.params.ep || firstEp(drama);
    const ep = drama.episodes.find(e => e.n === epN) || drama.episodes[0];
    if (!ep) { go(`#/drama/${encodeURIComponent(drama.id)}`); return; }
    state.current = { drama, ep };

    const idx = drama.episodes.findIndex(e => e.n === ep.n);
    const next = drama.episodes[idx + 1];
    const prev = drama.episodes[idx - 1];
    const resume = store.progress()[drama.id];
    const startSec = resume && resume.ep === ep.n && resume.time > 5 ? resume.time : 0;
    const fav = store.fav().includes(drama.id);

    $('#view').innerHTML = `
      <div class="player-screen" id="playerScreen">
        <div class="player-stage show-ui" id="playerStage">
          <div id="ytplayer"></div>
          <div class="player-tap" id="playerTap" aria-label="플레이어 제어"></div>
          <div class="player-ui" id="playerUi">
            <div class="player-top">
              <button class="icon-btn" id="closePlayer" aria-label="닫기">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
              </button>
              <span class="t">${esc(drama.title)} · ${ep.n}화</span>
              <button class="cc-btn on" id="btnCC" type="button" aria-label="자막 설정">자막</button>
              <button class="cc-btn" id="btnQ" type="button" aria-label="화질 및 속도 설정">화질</button>
            </div>
            <div class="player-center">
              <button class="ctrl-btn" id="btnBack10" type="button" aria-label="10초 뒤로">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg>
                <span>10</span>
              </button>
              <button class="ctrl-btn play" id="btnPlayPause" type="button" aria-label="재생/일시정지">
                <svg id="icoPlay" viewBox="0 0 24 24" width="30" height="30"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
                <svg id="icoPause" viewBox="0 0 24 24" width="30" height="30" style="display:none"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>
              </button>
              <button class="ctrl-btn" id="btnFwd10" type="button" aria-label="10초 앞으로">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/></svg>
                <span>10</span>
              </button>
            </div>
            <div class="player-bar">
              <span class="ptime" id="pCur">0:00</span>
              <input class="seek" id="pSeek" type="range" min="0" max="1000" value="0" aria-label="재생 위치" />
              <span class="ptime" id="pDur">${esc(ep.duration || fmtDur(ep.durationSec) || '0:00')}</span>
              <button class="icon-btn fs-btn" id="btnFS" type="button" aria-label="전체화면">
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
              </button>
            </div>
          </div>
          <div class="player-sheet" id="playerSheet" hidden></div>
          <div class="player-error" id="playerError" hidden>
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#ffb4b4" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.2"/></svg>
            <strong>이 영상은 앱에서 재생할 수 없어요</strong>
            <p>제작자가 외부 사이트 재생을 막아둔 경우입니다. YouTube에서 바로 볼 수 있어요.</p>
            <a class="btn btn-primary" href="https://www.youtube.com/watch?v=${ep.videoId}" target="_blank" rel="noopener">YouTube에서 보기</a>
          </div>
        </div>
        <div class="player-body">
          <div class="player-head">
            <h1 class="player-title">${ep.n}화</h1>
            <div class="player-sub">
              <span>${esc(drama.title)}</span><span class="dot">·</span>
              <span>${esc(ep.duration || fmtDur(ep.durationSec))}</span>
              ${koBadge(drama) ? `<span class="dot">·</span>${koBadge(drama)}` : ''}
            </div>
          </div>
          <div class="player-actions">
            ${prev ? `<a class="btn btn-ghost" href="#/watch/${encodeURIComponent(drama.id)}/${prev.n}">← 이전화</a>` : ''}
            ${next ? `<a class="btn btn-primary" href="#/watch/${encodeURIComponent(drama.id)}/${next.n}">다음화 →</a>` : ''}
            <button class="btn btn-ghost" data-fav="${drama.id}" style="flex:0 0 48px">${fav ? '♥' : '♡'}</button>
          </div>
          <div class="player-note">
            한국어 자막이 기본으로 켜집니다. 자막이 보이지 않으면 플레이어의 <b>CC</b> 버튼을 눌러 주세요.
          </div>
          <div class="section">
            <div class="section-head"><h2 class="section-title" style="font-size:15px">회차 선택</h2><a class="section-more" href="#/drama/${encodeURIComponent(drama.id)}">상세 ›</a></div>
            <div class="ep-grid">
              ${drama.episodes.map(e => `<a class="ep-cell ${e.n === ep.n ? 'on' : ''} ${isSeen(drama.id, e.n) ? 'seen' : ''}" href="#/watch/${encodeURIComponent(drama.id)}/${e.n}">${e.n}</a>`).join('')}
            </div>
          </div>
        </div>
      </div>`;

    const closeBtn = $('#closePlayer');
    if (closeBtn) closeBtn.addEventListener('click', () => go(`#/drama/${encodeURIComponent(drama.id)}`));
    const favBtn = $('[data-fav]');
    if (favBtn) favBtn.addEventListener('click', () => {
      toggleFav(drama.id);
      renderWatch();
    });

    bindCustomPlayerUI();
    mountPlayer(ep, startSec);
  }

  function showPlayerUI(autoHide) {
    const stage = $('#playerStage');
    if (!stage) return;
    stage.classList.add('show-ui');
    clearTimeout(state.uiTimer);
    if (autoHide) {
      state.uiTimer = setTimeout(() => {
        const s = $('#playerStage');
        if (s && state.player && state.player.getPlayerState && state.player.getPlayerState() === 1) {
          s.classList.remove('show-ui');
        }
      }, 3200);
    }
  }

  function setPlayIcon(playing) {
    const p = $('#icoPlay'), pa = $('#icoPause');
    if (p) p.style.display = playing ? 'none' : '';
    if (pa) pa.style.display = playing ? '' : 'none';
  }

  function bindCustomPlayerUI() {
    state.ccOn = true;
    const tap = $('#playerTap');
    const stage = $('#playerStage');
    if (tap && stage) {
      tap.addEventListener('click', () => {
        const ps = state.player && state.player.getPlayerState ? state.player.getPlayerState() : -1;
        if (ps === -1 || ps === 5) {
          if (state.player && state.player.playVideo) state.player.playVideo();
          showPlayerUI(true);
          return;
        }
        if (stage.classList.contains('show-ui')) {
          stage.classList.remove('show-ui');
          clearTimeout(state.uiTimer);
        } else {
          showPlayerUI(true);
        }
      });
    }
    const playBtn = $('#btnPlayPause');
    if (playBtn) playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.player || !state.player.getPlayerState) return;
      const ps = state.player.getPlayerState();
      if (ps === 1) {
        state.player.pauseVideo();
        showPlayerUI(false);
      } else {
        state.player.playVideo();
        showPlayerUI(true);
      }
    });
    const back10 = $('#btnBack10');
    if (back10) back10.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.player || !state.player.seekTo) return;
      state.player.seekTo(Math.max(0, currentTime() - 10), true);
      updateSeekUI();
      showPlayerUI(true);
    });
    const fwd10 = $('#btnFwd10');
    if (fwd10) fwd10.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.player || !state.player.seekTo) return;
      const dur = currentDuration() || 99999;
      state.player.seekTo(Math.min(dur, currentTime() + 10), true);
      updateSeekUI();
      showPlayerUI(true);
    });
    const ccBtn = $('#btnCC');
    if (ccBtn) ccBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlayerSheet('cc');
    });
    const qBtn = $('#btnQ');
    if (qBtn) qBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlayerSheet('quality');
    });
    const seek = $('#pSeek');
    if (seek) {
      seek.addEventListener('input', () => {
        state.seeking = true;
        const dur = currentDuration() || (state.current.ep && state.current.ep.durationSec) || 0;
        const t = (Number(seek.value) / 1000) * dur;
        const cur = $('#pCur');
        if (cur) cur.textContent = fmtDur(Math.floor(t));
        showPlayerUI(false);
      });
      seek.addEventListener('change', () => {
        const dur = currentDuration() || (state.current.ep && state.current.ep.durationSec) || 0;
        const t = (Number(seek.value) / 1000) * dur;
        if (state.player && state.player.seekTo) state.player.seekTo(t, true);
        state.seeking = false;
        showPlayerUI(true);
      });
    }
    const fsBtn = $('#btnFS');
    if (fsBtn && stage) fsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (stage.requestFullscreen) {
        stage.requestFullscreen().catch(() => stage.classList.toggle('is-fs'));
      } else {
        stage.classList.toggle('is-fs');
      }
      showPlayerUI(true);
    });
  }

  const QUALITY_LABEL = {
    highres: '최고화질 (4K+)', hd2160: '2160p (4K)', hd1440: '1440p (QHD)',
    hd1080: '1080p (FHD)', hd720: '720p (HD)', large: '480p', medium: '360p',
    small: '240p', tiny: '144p', auto: '자동'
  };

  function applyBestQuality(player) {
    try {
      const levels = player.getAvailableQualityLevels ? player.getAvailableQualityLevels() : [];
      const pick = state.quality === 'highres'
        ? (levels && levels.length ? levels[0] : 'hd1080')
        : state.quality;
      if (player.setPlaybackQuality) player.setPlaybackQuality(pick);
      updateQualityBtn(pick);
    } catch (e) { /* noop */ }
  }

  function updateQualityBtn(q) {
    const b = $('#btnQ');
    if (!b) return;
    const short = q === 'highres' || q === 'hd2160' ? '4K' : q === 'hd1440' ? '1440p' : q === 'hd1080' ? '1080p' : q === 'hd720' ? '720p' : q === 'large' ? '480p' : q === 'medium' ? '360p' : '화질';
    b.textContent = short;
  }

  function closePlayerSheet() {
    const sheet = $('#playerSheet');
    if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; }
  }

  function openPlayerSheet(kind) {
    const sheet = $('#playerSheet');
    if (!sheet) return;
    if (!sheet.hidden && sheet.dataset.kind === kind) { closePlayerSheet(); return; }
    sheet.dataset.kind = kind;
    clearTimeout(state.uiTimer);

    if (kind === 'cc') {
      let tracks = [];
      try { tracks = (state.player && state.player.getOption && state.player.getOption('captions', 'tracklist')) || []; } catch (e) { tracks = []; }
      const trackHtml = tracks.length
        ? tracks.map(t => `<button class="sheet-opt ${state.ccOn && state.ccLang === t.languageCode ? 'on' : ''}" data-cc-lang="${esc(t.languageCode)}">${esc(t.displayName || t.languageName || t.languageCode)}</button>`).join('')
        : `<button class="sheet-opt ${state.ccOn && state.ccLang === 'ko' ? 'on' : ''}" data-cc-lang="ko">한국어 (기본)</button>`;

      sheet.innerHTML = `
        <div class="sheet-box" id="sheetBox">
          <div class="sheet-head"><strong>자막 설정</strong><button class="sheet-close" id="sheetClose" type="button">닫기</button></div>
          <div class="sheet-label">자막 언어</div>
          <div class="sheet-list">
            <button class="sheet-opt ${!state.ccOn ? 'on' : ''}" data-cc-lang="off">자막 끄기</button>
            ${trackHtml}
          </div>
          <div class="sheet-label">자막 크기</div>
          <div class="sheet-row">
            ${[[-1, '작게'], [0, '보통'], [1, '크게'], [2, '매우 크게']].map(([sz, lb]) => `<button class="sheet-pill ${state.ccSize === sz ? 'on' : ''}" data-cc-size="${sz}">${lb}</button>`).join('')}
          </div>
        </div>`;
      sheet.hidden = false;
      sheet.querySelectorAll('[data-cc-lang]').forEach(btn => btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const lang = btn.dataset.ccLang;
        const ccBtn = $('#btnCC');
        if (lang === 'off') {
          state.ccOn = false;
          try { state.player.setOption('captions', 'track', {}); } catch (e) {}
          if (ccBtn) ccBtn.classList.remove('on');
          toast('자막 꺼짐');
        } else {
          state.ccOn = true;
          state.ccLang = lang;
          try { state.player.setOption('captions', 'track', { languageCode: lang }); } catch (e) {}
          if (ccBtn) ccBtn.classList.add('on');
          toast(`${btn.textContent} 자막 선택`);
        }
        closePlayerSheet();
        showPlayerUI(true);
      }));
      sheet.querySelectorAll('[data-cc-size]').forEach(btn => btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const sz = Number(btn.dataset.ccSize);
        state.ccSize = sz;
        try { state.player.setOption('captions', 'fontSize', sz); } catch (e) {}
        toast(`자막 크기: ${btn.textContent}`);
        openPlayerSheet('cc');
      }));
    } else {
      let levels = [];
      try { levels = (state.player && state.player.getAvailableQualityLevels && state.player.getAvailableQualityLevels()) || []; } catch (e) { levels = []; }
      if (!levels.length) levels = ['hd1080', 'hd720', 'large', 'medium', 'auto'];
      let curQ = state.quality;
      try { if (state.player && state.player.getPlaybackQuality) curQ = state.player.getPlaybackQuality() || state.quality; } catch (e) {}
      const rates = [0.75, 1, 1.25, 1.5, 2];

      sheet.innerHTML = `
        <div class="sheet-box" id="sheetBox">
          <div class="sheet-head"><strong>화질 · 재생 속도</strong><button class="sheet-close" id="sheetClose" type="button">닫기</button></div>
          <div class="sheet-label">화질 (기본: 최고화질 우선)</div>
          <div class="sheet-list">
            ${levels.map(q => `<button class="sheet-opt ${curQ === q ? 'on' : ''}" data-q="${esc(q)}">${esc(QUALITY_LABEL[q] || q)}</button>`).join('')}
          </div>
          <div class="sheet-label">재생 속도</div>
          <div class="sheet-row">
            ${rates.map(r => `<button class="sheet-pill ${state.rate === r ? 'on' : ''}" data-rate="${r}">${r}x</button>`).join('')}
          </div>
        </div>`;
      sheet.hidden = false;
      sheet.querySelectorAll('[data-q]').forEach(btn => btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const q = btn.dataset.q;
        state.quality = q;
        try { if (state.player && state.player.setPlaybackQuality) state.player.setPlaybackQuality(q); } catch (e) {}
        updateQualityBtn(q);
        toast(`화질: ${QUALITY_LABEL[q] || q}`);
        closePlayerSheet();
        showPlayerUI(true);
      }));
      sheet.querySelectorAll('[data-rate]').forEach(btn => btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const r = Number(btn.dataset.rate);
        state.rate = r;
        try { if (state.player && state.player.setPlaybackRate) state.player.setPlaybackRate(r); } catch (e) {}
        toast(`재생 속도 ${r}x`);
        openPlayerSheet('quality');
      }));
    }
    const close = $('#sheetClose');
    if (close) close.addEventListener('click', (ev) => { ev.stopPropagation(); closePlayerSheet(); showPlayerUI(true); });
    sheet.onclick = (ev) => { if (ev.target === sheet) { closePlayerSheet(); showPlayerUI(true); } };
  }

  function updateSeekUI() {
    if (state.seeking) return;
    const t = currentTime();
    const dur = currentDuration() || (state.current.ep && state.current.ep.durationSec) || 0;
    const curEl = $('#pCur'), durEl = $('#pDur'), seekEl = $('#pSeek');
    if (curEl) curEl.textContent = fmtDur(Math.floor(t));
    if (durEl && dur) durEl.textContent = fmtDur(Math.floor(dur));
    if (seekEl && dur) {
      const pct = Math.min(1000, Math.max(0, Math.round((t / dur) * 1000)));
      seekEl.value = String(pct);
      seekEl.style.setProperty('--pct', `${(pct / 10).toFixed(1)}%`);
    }
  }

  function mountPlayer(ep, startSec) {
    loadYT().then((YT) => {
      const holder = document.getElementById('ytplayer');
      if (!holder) return;
      try {
        state.player = new YT.Player('ytplayer', {
          videoId: ep.videoId,
          host: 'https://www.youtube.com',
          playerVars: { ...YT_PARAMS, origin: location.origin, start: Math.floor(startSec) },
          events: {
            onReady: (e) => {
              try { e.target.setOption('captions', 'track', { languageCode: state.ccOn ? state.ccLang : '' }); } catch (err) { /* 자막 트랙 없음 */ }
              applyBestQuality(e.target);
              if (startSec > 5) e.target.seekTo(startSec, true);
              updateSeekUI();
              startProgressTimer();
            },
            onPlaybackQualityChange: (e) => {
              if (e && e.data) updateQualityBtn(e.data);
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.PLAYING) {
                hidePlayerError();
                applyBestQuality(e.target);
                setPlayIcon(true);
                showPlayerUI(true);
                startProgressTimer();
              } else if (e.data === YT.PlayerState.PAUSED) {
                setPlayIcon(false);
                showPlayerUI(false);
                saveProgress();
              } else if (e.data === YT.PlayerState.ENDED) {
                setPlayIcon(false);
                showPlayerUI(false);
                markSeen();
                saveProgress(true);
                showNextHint();
              }
            },
            onError: () => showPlayerError()
          }
        });
      } catch (err) {
        showPlayerError();
      }
    }).catch(showPlayerError);
  }

  function startProgressTimer() {
    clearInterval(state.progressTimer);
    let tick = 0;
    state.progressTimer = setInterval(() => {
      updateSeekUI();
      tick += 1;
      if (tick % 5 === 0) saveProgress();
    }, 1000);
  }
  function currentTime() {
    try { return state.player && state.player.getCurrentTime ? state.player.getCurrentTime() : 0; }
    catch (e) { return 0; }
  }
  function currentDuration() {
    try { return state.player && state.player.getDuration ? state.player.getDuration() : 0; }
    catch (e) { return 0; }
  }
  function saveProgress(force) {
    const { drama, ep } = state.current;
    if (!drama || !ep) return;
    const time = currentTime();
    const dur = currentDuration() || ep.durationSec || 0;
    if (!time || (time < 3 && !force)) return;
    const map = store.progress();
    map[drama.id] = { ep: ep.n, time: Math.floor(time), dur: Math.floor(dur), at: Date.now() };
    store.setProgress(map);
    if (dur && time / dur > 0.92) markSeen();
    const hist = store.history().filter(h => !(h.dramaId === drama.id && h.ep === ep.n));
    hist.unshift({ dramaId: drama.id, ep: ep.n, at: Date.now() });
    store.setHistory(hist);
  }
  function markSeen() {
    const { drama, ep } = state.current;
    if (!drama || !ep) return;
    const seen = store.seen();
    seen[drama.id] = seen[drama.id] || {};
    seen[drama.id][ep.n] = true;
    store.setSeen(seen);
  }
  function showPlayerError() {
    const box = document.getElementById('playerError');
    if (box) box.hidden = false;
    clearInterval(state.progressTimer);
  }
  function hidePlayerError() {
    const box = document.getElementById('playerError');
    if (box) box.hidden = true;
  }
  function showNextHint() {
    const { drama, ep } = state.current;
    if (!drama) return;
    const idx = drama.episodes.findIndex(e => e.n === ep.n);
    const next = drama.episodes[idx + 1];
    if (!next) return;
    const existing = $('.float-next');
    if (existing) existing.remove();
    const btn = document.createElement('a');
    btn.className = 'float-next';
    btn.href = `#/watch/${encodeURIComponent(drama.id)}/${next.n}`;
    btn.innerHTML = `다음 화 · ${next.n}화 ▶`;
    document.body.appendChild(btn);
  }
  function destroyPlayer() {
    clearInterval(state.progressTimer);
    clearTimeout(state.uiTimer);
    saveProgress(true);
    try { if (state.player && state.player.destroy) state.player.destroy(); } catch (e) { /* noop */ }
    state.player = null;
    state.current = { drama: null, ep: null };
    const btn = $('.float-next');
    if (btn) btn.remove();
  }

  /* ---------------- 렌더 ---------------- */
  function render() {
    const name = state.route.name;
    stopHero();
    $$('[data-tab]').forEach(tab => {
      const isActive = tab.dataset.tab === name || (name === 'detail' && tab.dataset.tab === 'home') || (name === 'watch' && tab.dataset.tab === 'home');
      tab.classList.toggle('on', isActive);
    });
    $('#tabbar').style.display = name === 'watch' ? 'none' : '';
    $('#topbar').style.display = name === 'watch' ? 'none' : '';
    if (name === 'watch') { renderWatch(); return; }
    if (name === 'home') renderHome();
    else if (name === 'explore') renderExplore();
    else if (name === 'library') renderLibrary();
    else if (name === 'detail') renderDetail();
  }

  /* ---------------- 데이터 로드 ---------------- */
  async function loadData() {
    $('#view').innerHTML = `<div class="loading-screen"><div class="spinner"></div>작품 목록을 불러오는 중…</div>`;
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.data = await res.json();
      if (!state.data.dramas || !state.data.dramas.length) throw new Error('empty');
    } catch (err) {
      try {
        const cacheRes = await caches.match(DATA_URL);
        if (cacheRes) {
          state.data = await cacheRes.json();
        }
      } catch (e2) { /* noop */ }
      if (!state.data || !state.data.dramas) {
        $('#view').innerHTML = `<div class="empty"><div class="big">📡</div><p>작품 목록을 불러오지 못했어요.</p><p style="font-size:12px">네트워크를 확인하거나 잠시 후 다시 시도해 주세요.</p><button class="btn btn-primary" style="margin-top:14px" onclick="location.reload()">다시 시도</button></div>`;
        return;
      }
    }
    render();
  }

  /* ---------------- 시작 ---------------- */
  function boot() {
    window.addEventListener('hashchange', onRoute);
    state.route = parseHash();
    if (!location.hash) history.replaceState(null, '', '#/home');

    document.getElementById('btnSearch').addEventListener('click', () => {
      go('#/explore');
      setTimeout(() => { const el = $('#q'); if (el) el.focus(); }, 120);
    });

    // 화면 이동 시 저장
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(true); });
    window.addEventListener('pagehide', () => saveProgress(true));

    loadData();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
          reg.update().catch(() => {});
        }).catch(() => {});
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!reloaded) { reloaded = true; location.reload(); }
        });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
