// providers/vixsrc_ita_direct.js
//
// VixSrc (ITA • Direct) — RISOLUZIONE NATIVA VIXCLOUD
// Implementa in JS la logica del tuo vixcloud.py (MediaFlow-Proxy):
// - se l'URL contiene /iframe, recupera la "version" (X-Inertia) dalla pagina /request-a-title
//   e poi segue l'iframe con gli header x-inertia per ottenere la pagina effettiva
// - se l'URL è /movie o /tv, scarica direttamente la pagina
// - estrae da <script> i campi: token, expires, server_url e (opz.) canPlayFHD -> &h=1
// - costruisce l'URL HLS finale ?token=...&expires=... [&h=1], con gestione ?b=1 (usa &token)
// - restituisce stream HLS con headers (Referer) corretti
//
// Output stream per Nuvio/ExoPlayer: type:"hls" + mimeType + isHls:true
// Verifica reale HLS (#EXTM3U) per evitare HTML/403.

const VIXSRC_BASE = 'https://vixsrc.to';
const FETCH_TIMEOUT = 15000;

const HDR_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive'
};

const HDR_JSON = {
  'User-Agent': HDR_HTML['User-Agent'],
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': HDR_HTML['Accept-Language']
};

const QUALITY_ORDER = ['2160p','4K','1440p','1080p','720p','480p','360p'];

function log(m){ try{ console.log('[VixSrcITA-Direct] ' + m);}catch(_){} }
function withTimeout(p,ms){ return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error('timeout '+ms+'ms')),ms); p.then(v=>{clearTimeout(t);res(v);},e=>{clearTimeout(t);rej(e);});}); }

async function getText(url, headers){
  log('GET ' + url);
  const r = await withTimeout(fetch(url,{method:'GET', headers: headers||HDR_HTML}), FETCH_TIMEOUT);
  if(!r || !r.ok) throw new Error('HTTP ' + (r?r.status:'ERR') + ' su ' + url);
  return await r.text();
}

function qFromText(t){
  if(!t) return 'Unknown';
  const T=String(t).toUpperCase();
  for(let q of QUALITY_ORDER){ if(T.includes(q.toUpperCase())) return q; }
  const m=T.match(/(\d{3,4})P/); return m ? (m[1]+'p') : 'Unknown';
}
function qSortVal(q){ const m=(q||'').match(/(\d{3,4})p/i); return m?parseInt(m[1],10):(String(q).toUpperCase()==='4K'?4000:0); }

// ---- Costruzione URL embed VixSrc (ITA) ----
function buildEmbed(mediaType, tmdbId, s, e){
  const base = VIXSRC_BASE.replace(/\/+$/,'');
  if(mediaType==='tv'){ if(!s||!e) return null; return `${base}/tv/${encodeURIComponent(String(tmdbId))}/${encodeURIComponent(String(s))}/${encodeURIComponent(String(e))}?lang=it`; }
  return `${base}/movie/${encodeURIComponent(String(tmdbId))}?lang=it`;
}

// ---- Utilità parsing ----
function firstIframeSrc(html, baseUrl){
  const re=/<iframe[^>]*\s+src=["']([^"'<>]+)["'][^>]*>/i;
  const m=re.exec(html);
  if(!m||!m[1]) return null;
  try { return new URL(m[1], baseUrl).toString(); } catch { return m[1]; }
}

// Estrae "version" dal JSON nel div#app data-page (come in vixcloud.py)
async function fetchVixVersion(siteUrl){
  const url = siteUrl.replace(/\/+$/,'') + '/request-a-title';
  const txt = await getText(url, {
    ...HDR_HTML,
    Referer: siteUrl.replace(/\/+$/,'') + '/',
    Origin: siteUrl.replace(/\/+$/,'')
  });
  // Cerca <div id="app" data-page="...json...">
  const m = txt.match(/<div[^>]+id=["']app["'][^>]+data-page=["']([^"']+)["']/i);
  if(!m || !m[1]) throw new Error('VixCloud version: div#app data-page non trovato');
  try {
    const data = JSON.parse(m[1]);
    if (!data || !data.version) throw new Error('version non presente');
    return String(data.version);
  } catch(e) {
    throw new Error('VixCloud version parse error: ' + e.message);
  }
}

// Implementazione JS del flusso di vixcloud.py
// Ritorna { hlsUrl, referer }
async function resolveVixCloudLike(url){
  let responseHtml = '';
  if (url.includes('/iframe')) {
    // 1) prendi site_url prima di /iframe
    const siteUrl = url.split('/iframe')[0];
    const version = await fetchVixVersion(siteUrl);

    // 2) GET dell'URL /iframe con header inertia per ottenere la pagina con <iframe src=...>
    const txtIframeWrap = await getText(url, { ...HDR_HTML, 'x-inertia':'true', 'x-inertia-version': version });
    const innerIframe = firstIframeSrc(txtIframeWrap, url);
    if (!innerIframe) throw new Error('iframe interno non trovato');
    // 3) GET dell'iframe interno con inertia headers
    responseHtml = await getText(innerIframe, { ...HDR_HTML, 'x-inertia':'true', 'x-inertia-version': version });
  } else if (url.includes('/movie') || url.includes('/tv')) {
    // pagina embed diretta
    responseHtml = await getText(url, HDR_HTML);
  } else {
    // fallback: scarica comunque
    responseHtml = await getText(url, HDR_HTML);
  }

  // Nel body/script sono presenti: 'token':'xxx', 'expires':'123456', url:'https://...m3u8...'
  const scriptTextMatch = responseHtml.match(/<body[^>]*>[\s\S]*?<script[^>]*>([\s\S]*?)<\/script>/i);
  const scriptText = scriptTextMatch ? scriptTextMatch[1] : responseHtml;

  const tokenM = scriptText.match(/'token'\s*:\s*'([A-Za-z0-9_]+)'/i);
  const expM   = scriptText.match(/'expires'\s*:\s*'(\d+)'/i);
  const urlM   = scriptText.match(/url\s*:\s*'([^']+)'/i);

  if (!tokenM || !expM || !urlM) throw new Error('Parametri mancanti (token/expires/url)');

  const token   = tokenM[1];
  const expires = expM[1];
  let   server  = urlM[1];

  // Se "window.canPlayFHD = true" -> aggiungi &h=1
  const fhd = /window\.canPlayFHD\s*=\s*true/i.test(scriptText);

  // Se server_url contiene ?b=1 allora aggiungiamo i parametri con "&", altrimenti con "?"
  const sep = server.includes('?') ? '&' : '?';
  let finalUrl = `${server}${sep}token=${encodeURIComponent(token)}&expires=${encodeURIComponent(expires)}`;
  if (fhd) finalUrl += '&h=1';

  // Referer: la pagina che abbiamo usato (preferisci l'URL passato alla funzione)
  const referer = url;
  log("DEBUG HLS URL => " + finalUrl);
  return { hlsUrl: finalUrl, referer };
}

// Verifica che sia davvero una playlist HLS (#EXTM3U)
async function verifyIsHls(url, referer){
  try{
    const r = await withTimeout(fetch(url,{ method:'GET', headers: {
      'User-Agent': HDR_HTML['User-Agent'],
      'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      'Referer': referer
    }}), 12000);
    if(!r || !r.ok) return false;
    const txt = await r.text();
    return /^#EXTM3U/.test(txt.trim().slice(0,1024));
  }catch(_){ return false; }
}

function buildHlsStream(url, label, referer){
  const q = qFromText(label||url);
  return {
    name: 'VixSrc (ITA • Direct)',
    title: (q && q!=='Unknown') ? (q + ' • ITA') : 'Stream • ITA',
    url,
    quality: q || 'Unknown',
    type: 'hls',
    mimeType: 'application/vnd.apple.mpegurl',
    isHls: true,
    headers: {
      'User-Agent': HDR_HTML['User-Agent'],
      'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      'Referer': referer
      // niente Origin: alcuni CDN lo rifiutano
    }
  };
}

function buildExternal(embedUrl){
  return {
    name: 'VixSrc (Embed ITA)',
    title: 'Apri Player VixSrc (ITA)',
    url: embedUrl,
    quality: 'Unknown',
    type: 'external',
    headers: { 'Referer': VIXSRC_BASE + '/', 'User-Agent': HDR_HTML['User-Agent'] }
  };
}

// =====================
// API principale
// =====================
async function getStreams(tmdbId, mediaType='movie', seasonNum=null, episodeNum=null){
  try{
    const embed = buildEmbed(mediaType, tmdbId, seasonNum, episodeNum);
    if(!embed) return [];

    // 1) Se l'embed ha un iframe VixCloud, risolviamo direttamente con la logica vixcloud.py
    //    Altrimenti, proviamo prima a vederlo come /movie|/tv (il resolver gestisce entrambi i casi)
    //    NB: preferiamo passare prima l'URL embed (che spesso contiene /movie|/tv)
    let targetUrl = embed;

    // Piccolo tentativo per catturare subito l'iframe (così usiamo quello come referer):
    try {
      const html = await getText(embed, HDR_HTML);
      const iframe = firstIframeSrc(html, embed);
      if (iframe) targetUrl = iframe; // più vicino alla sorgente reale (referer corretto)
    } catch(_) {}

    const { hlsUrl, referer } = await resolveVixCloudLike(targetUrl);

    const ok = await verifyIsHls(hlsUrl, referer);
    if (!ok) {
      // fallback: apri comunque l'embed
      return [buildExternal(embed)];
    }

    const streams = [ buildHlsStream(hlsUrl, 'HLS (VixCloud)', referer) ];
    return streams;

  }catch(e){
    log('Errore: ' + e.message);
    const embed = buildEmbed(mediaType, tmdbId, seasonNum, episodeNum);
    return embed ? [buildExternal(embed)] : [];
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
