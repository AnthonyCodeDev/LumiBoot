import { systems, getSystemById } from './catalog.js';

const STORAGE_KEY = 'osdeck:favorite-system-ids:v1';
const state = { family: 'all', mode: 'all', query: '', favorites: readFavorites(), selected: null };
const $ = (selector) => document.querySelector(selector);
const cards = $('#cards');
const filterButtons = [...document.querySelectorAll('.filter')];
const drawer = $('#detail-drawer');
const drawerScrim = $('#drawer-scrim');
let toastTimer;
let previousFocus;

const labels = {
    linux: 'Linux', windows: 'Windows', macos: 'macOS',
    browser: 'DANS LE NAVIGATEUR',
    v86: 'v86 / WebAssembly', 'wasm-x86': 'WASM x86', 'wasm-x86_64': 'WASM x86-64', 'wasm-arm': 'WASM ARM'
};

function readFavorites() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        return new Set(Array.isArray(saved) ? saved.filter((v) => typeof v === 'string') : []);
    } catch {
        return new Set();
    }
}
function saveFavorites() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.favorites])); }
    catch { toast('Stockage local indisponible : les favoris ne seront pas conservés.'); }
}
function escaped(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function normalize(value) {
    return value.toLocaleLowerCase('fr').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function filteredSystems() {
    return systems.filter((sys) => {
        const matchesFamily = state.family === 'all' || (state.family === 'favorites' ? state.favorites.has(sys.id) : state.family === sys.family);
        const matchesMode = state.mode === 'all' || state.mode === sys.execution;
        const haystack = normalize(`${sys.name} ${sys.version} ${sys.arch} ${sys.family} ${sys.engine}`);
        return matchesFamily && matchesMode && haystack.includes(normalize(state.query.trim()));
    });
}
function cardMarkup(sys) {
    const favorite = state.favorites.has(sys.id);
    return `<article class="os-card" style="--accent:${escaped(sys.accent)};--accent-rgb:${escaped(sys.accentRGB)}" data-id="${escaped(sys.id)}">
    <div class="card-cover">
      <span class="card-grid" aria-hidden="true"></span>
      <div class="card-top"><span class="card-category">${escaped(labels[sys.family])}</span><button class="favorite-button ${favorite ? 'is-favorite' : ''}" type="button" data-action="favorite" data-id="${escaped(sys.id)}" aria-label="${favorite ? 'Retirer des' : 'Ajouter aux'} favoris" aria-pressed="${favorite}">${favorite ? '★' : '☆'}</button></div>
      <img class="os-logo ${sys.family === 'macos' ? 'logo-macos' : ''}" src="./assets/${escaped(sys.icon)}" alt="" loading="lazy">
      <div class="cover-bottom"><span class="cover-line"></span><span>OS / ${escaped(sys.arch.toUpperCase())}</span></div>
    </div>
    <div class="card-info"><div class="card-title-row"><div><h3>${escaped(sys.name)}</h3><p>${escaped(sys.version)}</p></div><span class="small-arrow" aria-hidden="true">↗</span></div>
    <div class="card-meta"><span><span class="mini-circle"></span>Local · WASM</span><span>Prévu</span></div>
    <div class="card-actions"><button type="button" class="card-view" data-action="details" data-id="${escaped(sys.id)}">Découvrir <span aria-hidden="true">↗</span></button></div></div>
  </article>`;
}
function render() {
    const visible = filteredSystems();
    cards.innerHTML = visible.map(cardMarkup).join('');
    $('#visible-count').textContent = String(visible.length).padStart(2, '0');
    $('#favorite-count').textContent = state.favorites.size;
    $('#empty-state').hidden = visible.length !== 0;
    filterButtons.forEach((b) => {
        const active = b.dataset.filter === state.family;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
    });
}
function setFamily(family) {
    state.family = family;
    render();
}
function toggleFavorite(id) {
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    saveFavorites();
    render();
    if (state.selected === id) {
        const current = getSystemById(id);
        if (current) renderDrawer(current);
    }
}
function renderDrawer(sys) {
    const favorite = state.favorites.has(sys.id);
    $('#drawer-content').innerHTML = `
    <div class="drawer-cover" style="--accent:${escaped(sys.accent)};--accent-rgb:${escaped(sys.accentRGB)}"><img src="./assets/${escaped(sys.icon)}" alt=""><span>${escaped(labels[sys.family])} / ${escaped(sys.arch.toUpperCase())}</span></div>
    <div class="drawer-overview"><span class="drawer-family">${escaped(labels[sys.family])} <span>·</span> ENVIRONNEMENT VIRTUEL</span><h2 id="drawer-title">${escaped(sys.name)}</h2><p class="drawer-version">${escaped(sys.version)}</p><p class="drawer-description">${escaped(sys.description)}</p>
    <div class="spec-box"><div><span>Architecture</span><strong>${escaped(sys.arch)}</strong></div><div><span>Mode d'exécution</span><strong>Dans le navigateur</strong></div><div><span>Moteur envisagé</span><strong>${escaped(labels[sys.engine])}</strong></div><div><span>État actuel</span><strong class="planned-label">En préparation</strong></div></div>
    <h3>Pré-requis</h3><p class="drawer-bodytext">${escaped(sys.requirements)}</p><h3>État de l'intégration</h3><p class="drawer-bodytext">${escaped(sys.note)}</p>
    <div class="drawer-actions"><button class="btn btn-primary" type="button" data-action="launch" data-id="${escaped(sys.id)}">${sys.featured ? 'Préparer le lancement' : 'Voir la disponibilité'}</button><button class="btn btn-outline drawer-fav" data-action="favorite" data-id="${escaped(sys.id)}">${favorite ? '★ En favoris' : '☆ Ajouter aux favoris'}</button></div>
    </div>`;
}
function openDetails(id) {
    const sys = getSystemById(id);
    if (!sys) return;
    previousFocus = document.activeElement;
    state.selected = id;
    renderDrawer(sys);
    drawerScrim.hidden = false;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    $('#close-drawer').focus();
}
function closeDetails() {
    if (!drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawerScrim.hidden = true;
    document.body.classList.remove('drawer-open');
    state.selected = null;
    if (previousFocus?.isConnected) previousFocus.focus();
}
function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 4600);
}
/** Emplacement explicite du futur SessionController : aucune fausse VM. */
function requestLaunch(id) {
    const sys = getSystemById(id);
    if (!sys) return;
    toast(`${sys.name} ${sys.version} : le moteur ${labels[sys.engine]} n'est pas encore intégré. Aucun système n'a été démarré.`);
}

cards.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
        const { action: type, id } = action.dataset;
        if (type === 'favorite') toggleFavorite(id);
        if (type === 'details') openDetails(id);
        return;
    }
    const card = event.target.closest('.os-card');
    if (card) openDetails(card.dataset.id);
});
$('#drawer-content').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'favorite') toggleFavorite(action.dataset.id);
    if (action.dataset.action === 'launch') requestLaunch(action.dataset.id);
});
filterButtons.forEach((button) => button.addEventListener('click', () => setFamily(button.dataset.filter)));
$('#sidebar-favorites').addEventListener('click', () => { setFamily('favorites'); $('#catalogue').scrollIntoView({ behavior: 'smooth' }); });
$('#search-input').addEventListener('input', (event) => { state.query = event.target.value; render(); });
$('#mode-filter').addEventListener('change', (event) => { state.mode = event.target.value; render(); });
$('#clear-filters').addEventListener('click', () => {
    state.family = 'all'; state.mode = 'all'; state.query = '';
    $('#mode-filter').value = 'all'; $('#search-input').value = '';
    render();
});
$('#featured-details').addEventListener('click', () => openDetails('debian-12-i386'));
$('#featured-launch').addEventListener('click', () => requestLaunch('debian-12-i386'));
$('#help-btn').addEventListener('click', () => toast('OS Deck : prototype d’interface HTML/CSS/JS. Aucun moteur de virtualisation n’est encore branché.'));
$('#close-drawer').addEventListener('click', closeDetails);
drawerScrim.addEventListener('click', closeDetails);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeDetails(); return; }
    if (drawer.classList.contains('open') && event.key === 'Tab') {
        const focusable = [...drawer.querySelectorAll('button:not([disabled]), a[href], input:not([disabled])')];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (drawer.classList.contains('open')) return;
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if ((event.key === '/' && !typing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
        event.preventDefault(); $('#search-input').focus();
    }
});
function updateClock() {
    $('#clock').textContent = new Intl.DateTimeFormat('fr-BE', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}
updateClock(); setInterval(updateClock, 30000); render();
