// providers/vixsrc_ita_direct.js
//
// Scraper: "VixSrc (ITA • Direct)"
// Obiettivo: usare gli embed ufficiali VixSrc (https://vixsrc.to) con ?lang=it
// e risolvere direttamente URL .m3u8 senza proxy di terze parti.
// Fallback: se non troviamo stream diretti validi, esponiamo l'embed "external".
//
// Compatibile con Nuvio/React Native: solo fetch + regex (nessuna dipendenza esterna).
// Tutte le funzioni sono incluse (nessuna omissione).

// =====================
// Config
// =====================
const VIXSRC_BASE = 'https://vixsrc.to';
const FETCH_TIMEOUT = 15000;

// Se alcune CDN bloccano HEAD, metti a false per non scartare link validi
const ENABLE_HEAD_VALIDATION = false;

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

// Host "tipo RapidCloud" spesso usati dietro VixSrc
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
  if (!ENABLE_HEAD_VALIDATION) return true; // disabilitata per evitare falsi negativi
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
  const re = /<iframe[^>]*\s+src=["']([^"'<>]+)["'][^>]*>/i;
  const m = re.exec(html);
  if (!m || !m[1]) return null;
  try { return new URL(m[1], baseUrl).toString(); }
  catch { return m[1]; }
}

function secondIframeSrc(html, baseUrl) {
  // Prende il 2º iframe se presente
  const re = /<iframe[^>]*\s+src=["']([^"'<>]+)["'][^>]*>/ig;
  let m, count = 0, last = null;
  while ((m = re.exec(html)) !== null) {
    count++;
    if (count === 2) {
      last = m[1];
      break;
    }
  }
  if (!last) return null;
  try { return new URL(last, baseUrl).toString(); }
  catch { return last; }
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
// URL embed VixSrc (ITA / fallback)
// =====================
function buildEmbedCandidates(mediaType, tmdbId, seasonNum, episodeNum) {
  const base = VIXSRC_BASE.replace(/\/+$/, '');
  const list = [];
  if (mediaType === 'tv') {
    if (!seasonNum || !episodeNum) return [];
    list.push(`${base}/tv/${encodeURIComponent(String(tmdbId))}/${encodeURIComponent(String(seasonNum))}/${encodeURIComponent(String(episodeNum))}?lang=it`);
    list.push(`${base}/tv/${encodeURIComponent(String(tmdbId))}/${encodeURIComponent(String(seasonNum))}/${encodeURIComponent(String(episodeNum))}`); // fallback senza lang
    return list;
  }
  list.push(`${base}/movie/${encodeURIComponent(String(tmdbId))}?lang=it`);
  list.push(`${base}/movie/${encodeURIComponent(String(tmdbId))}`); // fallback senza lang
  return list;
}

// =====================
// Risoluzione diretta
// =====================

async function resolveFromEmbed(embedUrl) {
  const html = await makeText(embedUrl, COMMON_HEADERS_HTML);
  const m3u8s = extractAllM3U8(html);
  const iframe1 = firstIframeSrc(html, embedUrl);
  const iframe2 = secondIframeSrc(html, embedUrl);
  return { m3u8s, iframe1, iframe2, html };
}

async function resolveFromIframe(iframeUrl) {
  if (!iframeUrl) return { m3u8s: [], innerIframe: null, html: '' };
  const html = await makeText(iframeUrl, { ...COMMON_HEADERS_HTML, Referer: iframeUrl });
  return {
    m3u8s: extractAllM3U8(html),
    innerIframe: firstIframeSrc(html, iframeUrl) || null,
    html
  };
}

// RapidCloud / Rabbitstream / Vizcloud / Vidcloud
async function resolveRapidCloud(iframeUrl) {
  try {
    const u = new URL(iframeUrl);
    const origin = u.origin;
    const html = await makeText(iframeUrl, { ...COMMON_HEADERS_HTML, Referer: iframeUrl });

    // Estrai id
    let id = null;
    let m = html.match(/data-id=["']([A-Za-z0-9_-]{6,})["']/i);
    if (m && m[1]) id = m[1];
    if (!id) { m = html.match(/\sid=["']([A-Za-z0-9_-]{6,})["']/i); if (m && m[1]) id = m[1]; }
    if (!id) { m = html.match(/id["'\s=:]+([A-Za-z0-9_-]{6,})/i) || html.match(/getSources\?id=([A-Za-z0-9_-]{6,})/i); if (m && m[1]) id = m[1]; }

    if (!id) {
      log('RapidCloud: id non trovato.');
      // prova a cercare direttamente m3u8 nell'html come fallback
      const direct = extractAllM3U8(html);
      return direct.map(u => ({ url: u, label: 'Stream' }));
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
      } catch (e) { /* next */ }
    }

    // fallback: cerca inner iframe
    const inner = firstIframeSrc(html, iframeUrl);
    const more = inner ? extractAllM3U8(await makeText(inner, { ...COMMON_HEADERS_HTML, Referer: iframeUrl })) : [];
    return more.map(u => ({ url: u, label: 'Stream' }));

  } catch (e) { /* ignore */ }
  return [];
}

function collectM3u8FromRapidJson(j) {
  const out = [];
  function pushItem(url, label) {
    if (url && /\.m3u8(\?|$)/i.test(url)) out.push({ url, label: label || 'Stream' });
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
    const candidates = buildEmbedCandidates(mediaType, tmdbId, seasonNum, episodeNum);
    if (!candidates.length) {
      log('Parametri insufficienti per costruire l’embed.');
      return [];
    }

    // prova prima l'embed con lang=it, poi quello senza lang
    for (let c = 0; c < candidates.length; c++) {
      const embed = candidates[c];

      // A) pagina embed
      const resA = await resolveFromEmbed(embed);
      let pool = [...(resA.m3u8s || [])];

      // B) primo iframe
      const iframe1 = resA.iframe1 || null;
      if (iframe1) {
        const r1 = await resolveFromIframe(iframe1);
        pool = pool.concat(r1.m3u8s || []);

        // C) secondo iframe (generico)
        if (r1.innerIframe) {
          const r2 = await resolveFromIframe(r1.innerIframe);
          pool = pool.concat(r2.m3u8s || []);
        }
      }

      // D) host-specific RapidCloud
      if (iframe1 && containsRapidCloudHost(iframe1)) {
        const rc = await resolveRapidCloud(iframe1);
        (rc || []).forEach(x => { if (x && x.url) pool.push(x.url); });
      }

      // Deduplica
      const seen = {};
      const uniq = [];
      for (let i=0;i<pool.length;i++) {
        const u = pool[i];
        if (!seen[u]) { seen[u] = true; uniq.push(u); }
      }

      // Validazione (opzionale)
      const validated = [];
      for (let i=0;i<uniq.length;i++) {
        const st = toDirectStream(uniq[i], uniq[i]);
        const ok = await headOk(st.url, st.headers);
        if (ok) validated.push(st);
      }

      // Se validazione disabilitata o nessuno passato, accetta comunque i link
      let streams = validated;
      if (!streams.length && uniq.length) {
        streams = uniq.map(u => toDirectStream(u, u));
      }

      if (streams.length) {
        // Ordina per qualità
        streams.sort((a, b) => qForSort(b.quality) - qForSort(a.quality));
        return streams;
      }

      // se questo candidate non ha dato niente, passa al prossimo (es. senza lang)
    }

    // Nessun candidate ha dato stream → almeno l'embed (senza lang se esiste)
    const lastEmbed = candidates[candidates.length - 1];
    return lastEmbed ? [toExternalEmbed(lastEmbed)] : [];

  } catch (e) {
    log('Errore: ' + e.message);
    const fallback = buildEmbedCandidates(mediaType, tmdbId, seasonNum, episodeNum).pop();
    return fallback ? [toExternalEmbed(fallback)] : [];
  }
}

// =====================
// Export per Nuvio
// =====================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
