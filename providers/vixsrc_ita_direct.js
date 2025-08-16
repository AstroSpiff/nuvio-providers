// vixsrc_ita_direct.js
//
// Scraper: "VixSrc (ITA • Direct)"
// Obiettivo: usare gli embed ufficiali VixSrc (https://vixsrc.to) con ?lang=it
// e risolvere direttamente URL .m3u8 senza proxy di terze parti.
// Fallback: se non troviamo stream diretti validi, esponiamo l'embed "external".
//
// Compatibile con React Native (Nuvio): usa fetch; nessun modulo Node nativo (no fs/path/crypto).
// Usa cheerio-without-node-native per parsing HTML.
// Tutte le funzioni sono incluse (nessuna omissione), come richiesto.
//
// NOTE IMPORTANTI:
// - Questo risolutore copre tre vie:
//   A) Ricerca .m3u8 direttamente nell'HTML dell'embed VixSrc
//   B) Se l'embed include un <iframe>, proviamo anche lì (una profondità)
//   C) Host-specific "RapidCloud/Rabbitstream/Vizcloud/Vidcloud" (pattern molto comune dietro VixSrc):
//      tentiamo la chiamata JSON "/ajax/embed-4/getSources?id=..." o "/ajax/embed/getSources?id=..."
// - Se in futuro VixSrc cambia markup o host, si estende la funzione resolveRapidCloud() aggiungendo casi.
// - Il provider privilegia contenuti italiani passando `?lang=it` sugli URL embed di VixSrc.
//
// Riferimenti utili su come vanno strutturati i provider e il manifest nel repo:
// - README del repo Nuvio (struttura, manifest, test).
//
// Dipendenze (solo per test locale Node): npm i cheerio-without-node-native
const cheerio = require('cheerio-without-node-native');

// =====================
// Config
// =====================
const VIXSRC_BASE = 'https://vixsrc.to';
const FETCH_TIMEOUT = 15000;

const COMMON_HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive'
};

const COMMON_HEADERS_JSON = {
  'User-Agent': COMMON_HEADERS_HTML['User-Agent'],
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': COMMON_HEADERS_HTML['Accept-Language']
};

const QUALITY_ORDER = ['2160p', '4K', '1440p', '1080p', '720p', '480p', '360p'];

// Host "tipo RapidCloud" spesso usati dietro VixSrc (nomi possono variare nel tempo)
const RAPIDCLOUD_HOST_HINTS = [
  'rabbitstream', 'rapid-cloud', 'vizcloud', 'vidcloud', 'mzzcloud', 'rcp'
];

// =====================
// Utils
// =====================
function log(msg) { try { console.log('[VixSrcITA-Direct] ' + msg); } catch(_){} }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + ms + 'ms')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function makeText(url, headers) {
  log('GET ' + url);
  const resp = await withTimeout(fetch(url, { method: 'GET', headers: headers || COMMON_HEADERS_HTML }), FETCH_TIMEOUT);
  if (!resp || !resp.ok) throw new Error('HTTP ' + (resp ? resp.status : 'ERR') + ' su ' + url);
  return await resp.text();
}

async function makeJson(url, headers) {
  log('GET JSON ' + url);
  const resp = await withTimeout(fetch(url, { method: 'GET', headers: headers || COMMON_HEADERS_JSON }), FETCH_TIMEOUT);
  if (!resp || !resp.ok) throw new Error('HTTP ' + (resp ? resp.status : 'ERR') + ' su ' + url);
  return await resp.json();
}

async function headOk(url, headers) {
  try {
    const resp = await fetch(url, { method: 'HEAD', headers: headers || {} });
    return !!(resp && (resp.ok || resp.status === 206));
  } catch {
    return false;
  }
}

function extractAllM3U8(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  const seen = {};
  const uniq = [];
  for (let i=0;i<out.length;i++) { const u = out[i]; if (!seen[u]) { seen[u]=true; uniq.push(u); } }
  return uniq;
}

function firstIframeSrc(html, baseUrl) {
  const $ = cheerio.load(html);
  const el = $('iframe[src]').first();
  if (!el || !el.attr('src')) return null;
  try { return new URL(el.attr('src'), baseUrl).toString(); }
  catch { return el.attr('src'); }
}

function containsRapidCloudHost(url) {
  const u = (url || '').toLowerCase();
  return RAPIDCLOUD_HOST_HINTS.some(h => u.includes(h));
}

function extractQualityFromText(t) {
  if (!t) return 'Unknown';
  const T = String(t).toUpperCase();
  for (let i=0;i<QUALITY_ORDER.length;i++) {
    if (T.indexOf(QUALITY_ORDER[i].toUpperCase()) !== -1) return QUALITY_ORDER[i];
  }
  const m = T.match(/(\d{3,4})P/);
  return m ? (m[1] + 'p') : 'Unknown';
}

function qForSort(q) {
  if (!q) return 0;
  const m = (q+'').match(/(\d{3,4})p/i);
  if (m) return parseInt(m[1], 10);
  return (String(q).toUpperCase() === '4K') ? 4000 : 0;
}

// =====================
// URL embed VixSrc (ITA)
// =====================
function buildVixsrcEmbedUrl(mediaType, tmdbId, seasonNum, episodeNum) {
  const base = VIXSRC_BASE.replace(/\/+$/, '');
  if (mediaType === 'tv') {
    if (!seasonNum || !episodeNum) return null;
    return `${base}/tv/${encodeURIComponent(String(tmdbId))}/${encodeURIComponent(String(seasonNum))}/${encodeURIComponent(String(episodeNum))}?lang=it`;
  }
  return `${base}/movie/${encodeURIComponent(String(tmdbId))}?lang=it`;
}

// =====================
// Risoluzione diretta
// =====================

// A) pagina embed
async function resolveFromEmbed(embedUrl) {
  const html = await makeText(embedUrl, COMMON_HEADERS_HTML);
  const m3u8s = extractAllM3U8(html);
  const iframe = firstIframeSrc(html, embedUrl);
  return { m3u8s, iframe, html };
}

// B) primo iframe
async function resolveFromIframe(iframeUrl) {
  if (!iframeUrl) return [];
  const html = await makeText(iframeUrl, { ...COMMON_HEADERS_HTML, Referer: iframeUrl });
  return extractAllM3U8(html);
}

// C) host-specific RapidCloud/Rabbitstream/Vizcloud/Vidcloud
async function resolveRapidCloud(iframeUrl) {
  try {
    const u = new URL(iframeUrl);
    const origin = u.origin;
    const html = await makeText(iframeUrl, { ...COMMON_HEADERS_HTML, Referer: iframeUrl });
    const $ = cheerio.load(html);
    let id = $('[data-id]').attr('data-id') || $('*[id]').attr('id') || null;

    if (!id) {
      const m = html.match(/(?:id["'\\s=:]+)([A-Za-z0-9_-]{6,})/i) || html.match(/getSources\\?id=([A-Za-z0-9_-]{6,})/i);
      if (m && m[1]) id = m[1];
    }

    if (!id) {
      log('RapidCloud: id non trovato.');
      return [];
    }

    const urlsToTry = [
      `${origin}/ajax/embed-4/getSources?id=${encodeURIComponent(id)}`,
      `${origin}/ajax/embed/getSources?id=${encodeURIComponent(id)}`
    ];

    const headers = {
      ...COMMON_HEADERS_JSON,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': iframeUrl,
      'Origin': origin
    };

    for (let i=0;i<urlsToTry.length;i++) {
      try {
        const j = await makeJson(urlsToTry[i], headers);
        const candidates = collectM3u8FromRapidJson(j);
        if (candidates.length) return candidates;
      } catch (e) { /* prova il prossimo */ }
    }

    const innerIframe = firstIframeSrc(html, iframeUrl);
    if (innerIframe) {
      const more = await resolveFromIframe(innerIframe);
      return more;
    }
  } catch (e) { /* ignore */ }
  return [];
}

function collectM3u8FromRapidJson(j) {
  const out = [];
  function pushItem(url, label) {
    if (url && /\\.m3u8(\\?|$)/i.test(url)) out.push({ url, label: label || 'Stream' });
  }
  if (!j) return out;

  if (typeof j === 'string') { pushItem(j, 'Stream'); return out; }
  if (j.hls) pushItem(j.hls, 'HLS');

  const arr1 = Array.isArray(j.sources) ? j.sources : null;
  const arr2 = j.data && Array.isArray(j.data.sources) ? j.data.sources : null;
  const arr = arr1 || arr2 || [];
  for (let i=0;i<arr.length;i++) {
    const it = arr[i] || {};
    pushItem(it.file || it.url, it.label || it.quality);
  }
  return out;
}

// =====================
// Conversione in stream Nuvio
// =====================
function toDirectStream(url, label) {
  const q = extractQualityFromText(label || url);
  let origin;
  try { origin = new URL(url).origin; } catch { origin = VIXSRC_BASE; }
  return {
    name: 'VixSrc (ITA • Direct)',
    title: (q && q !== 'Unknown') ? (q + ' • ITA') : 'Stream • ITA',
    url: url,
    quality: q || 'Unknown',
    type: 'direct',
    headers: {
      'Referer': origin + '/',
      'User-Agent': COMMON_HEADERS_HTML['User-Agent'],
      'Origin': origin
    }
  };
}

function toExternalEmbed(embedUrl) {
  return {
    name: 'VixSrc (Embed ITA)',
    title: 'Apri Player VixSrc (ITA)',
    url: embedUrl,
    quality: 'Unknown',
    type: 'external',
    headers: {
      'Referer': VIXSRC_BASE + '/',
      'User-Agent': COMMON_HEADERS_HTML['User-Agent'],
      'Origin': VIXSRC_BASE
    }
  };
}

// =====================
// API principale (Nuvio)
// =====================
async function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null /*, _title, _year */) {
  try {
    const embed = buildVixsrcEmbedUrl(mediaType, tmdbId, seasonNum, episodeNum);
    if (!embed) {
      log('Parametri insufficienti per costruire l’embed.');
      return [];
    }

    // A) pagina embed
    const resA = await resolveFromEmbed(embed);
    let pool = [...(resA.m3u8s || [])];

    // B) primo iframe
    const iframeUrl = resA.iframe || null;
    if (iframeUrl) {
      const more = await resolveFromIframe(iframeUrl);
      pool = pool.concat(more || []);
    }

    // C) host-specific RapidCloud
    if (iframeUrl && containsRapidCloudHost(iframeUrl)) {
      const rc = await resolveRapidCloud(iframeUrl);
      pool = pool.concat(rc || []);
    }

    // Deduplica
    const seen = {};
    const uniq = [];
    for (let i=0;i<pool.length;i++) {
      const u = pool[i];
      if (!seen[u]) { seen[u] = true; uniq.push(u); }
    }

    // Validazione HEAD -> streams diretti
    const validations = await Promise.all(uniq.map(async (u) => {
      const st = toDirectStream(u, u);
      const ok = await headOk(st.url, st.headers);
      return ok ? st : null;
    }));

    const streams = validations.filter(Boolean);

    if (!streams.length) {
      // Niente diretti: offriamo l'embed
      return [toExternalEmbed(embed)];
    }

    // Ordina per qualità
    streams.sort((a, b) => qForSort(b.quality) - qForSort(a.quality));
    return streams;

  } catch (e) {
    log('Errore: ' + e.message);
    const embed = buildVixsrcEmbedUrl(mediaType, tmdbId, seasonNum, episodeNum);
    return embed ? [toExternalEmbed(embed)] : [];
  }
}

// =====================
// Export per Nuvio (RN)
// =====================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
