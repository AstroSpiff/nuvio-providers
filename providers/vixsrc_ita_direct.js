// providers/vixsrc_ita_direct.js
//
// VixSrc (ITA • Direct) — HLS
// Evidenzia HLS per Nuvio/ExoPlayer: type:"hls", mimeType e isHls:true.
// Referer solo dove serve; niente Origin di default.

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

function hlsHeaders(referer) {
  return {
    'User-Agent': HDR_HTML['User-Agent'],
    'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
    'Referer': referer || (VIXSRC_BASE + '/')
    // NIENTE Origin: alcuni CDN lo rifiutano
  };
}

const QUALITY_ORDER = ['2160p','4K','1440p','1080p','720p','480p','360p'];
const RAPIDCLOUD_HOST_HINTS = ['rabbitstream','rapid-cloud','vizcloud','vidcloud','mzzcloud','rcp'];

function log(m){ try{ console.log('[VixSrcITA-Direct] ' + m);}catch(_){} }
function withTimeout(p,ms){ return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error('timeout '+ms+'ms')),ms); p.then(v=>{clearTimeout(t);res(v);},e=>{clearTimeout(t);rej(e);});}); }

async function getText(url, headers){
  log('GET ' + url);
  const r = await withTimeout(fetch(url,{method:'GET', headers: headers||HDR_HTML}), FETCH_TIMEOUT);
  if(!r || !r.ok) throw new Error('HTTP ' + (r?r.status:'ERR') + ' su ' + url);
  return await r.text();
}
async function getJson(url, headers){
  log('GET JSON ' + url);
  const r = await withTimeout(fetch(url,{method:'GET', headers: headers||HDR_JSON}), FETCH_TIMEOUT);
  if(!r || !r.ok) throw new Error('HTTP ' + (r?r.status:'ERR') + ' su ' + url);
  return await r.json();
}

function extractAllM3U8(text){
  if(!text) return [];
  const re=/https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi;
  const arr=[]; let m; while((m=re.exec(text))!==null) arr.push(m[0]);
  const seen={}; const uniq=[]; for(let u of arr){ if(!seen[u]){ seen[u]=true; uniq.push(u);} }
  return uniq;
}
function firstIframeSrc(html, baseUrl){
  const re=/<iframe[^>]*\s+src=["']([^"'<>]+)["'][^>]*>/i;
  const m=re.exec(html);
  if(!m||!m[1]) return null;
  try { return new URL(m[1], baseUrl).toString(); } catch { return m[1]; }
}
function containsRapidCloudHost(url){
  const u=(url||'').toLowerCase();
  return RAPIDCLOUD_HOST_HINTS.some(h=>u.includes(h));
}
function qFromText(t){
  if(!t) return 'Unknown';
  const T=String(t).toUpperCase();
  for(let q of QUALITY_ORDER){ if(T.includes(q.toUpperCase())) return q; }
  const m=T.match(/(\d{3,4})P/); return m ? (m[1]+'p') : 'Unknown';
}
function qSortVal(q){ const m=(q||'').match(/(\d{3,4})p/i); return m?parseInt(m[1],10):(String(q).toUpperCase()==='4K'?4000:0); }

function buildEmbed(mediaType, tmdbId, s, e){
  const base = VIXSRC_BASE.replace(/\/+$/,'');
  if(mediaType==='tv'){ if(!s||!e) return null; return `${base}/tv/${encodeURIComponent(String(tmdbId))}/${encodeURIComponent(String(s))}/${encodeURIComponent(String(e))}?lang=it`; }
  return `${base}/movie/${encodeURIComponent(String(tmdbId))}?lang=it`;
}

async function resolveFromEmbed(embedUrl){
  const html = await getText(embedUrl, HDR_HTML);
  return { m3u8s: extractAllM3U8(html), iframe: firstIframeSrc(html, embedUrl), html };
}
async function resolveFromIframe(iframeUrl){
  if(!iframeUrl) return [];
  const html = await getText(iframeUrl, { ...HDR_HTML, Referer: iframeUrl });
  return extractAllM3U8(html);
}
async function resolveRapidCloud(iframeUrl){
  try{
    const u = new URL(iframeUrl);
    const origin = u.origin;
    const html = await getText(iframeUrl, { ...HDR_HTML, Referer: iframeUrl });

    let id=null, m=null;
    m=html.match(/data-id=["']([A-Za-z0-9_-]{6,})["']/i); if(m&&m[1]) id=m[1];
    if(!id){ m=html.match(/\sid=["']([A-Za-z0-9_-]{6,})["']/i); if(m&&m[1]) id=m[1]; }
    if(!id){ m=html.match(/id["'\s=:]+([A-Za-z0-9_-]{6,})/i) || html.match(/getSources\?id=([A-Za-z0-9_-]{6,})/i); if(m&&m[1]) id=m[1]; }
    if(!id) return [];

    const endpoints=[ `${origin}/ajax/embed-4/getSources?id=${encodeURIComponent(id)}`, `${origin}/ajax/embed/getSources?id=${encodeURIComponent(id)}` ];
    const headers={ ...HDR_JSON, 'X-Requested-With':'XMLHttpRequest', 'Referer': iframeUrl };

    for(let ep of endpoints){
      try{
        const j = await getJson(ep, headers);
        const out = collectRapidJson(j);
        if(out.length) return out.map(o=>({ ...o, _referer: iframeUrl }));
      }catch(_){}
    }

    const inner = firstIframeSrc(html, iframeUrl);
    if(inner){
      const more = await resolveFromIframe(inner);
      return more.map(u=>({ url:u, label:'Stream', _referer: iframeUrl }));
    }
  }catch(_){}
  return [];
}
function collectRapidJson(j){
  const out=[]; const push=(url,label)=>{ if(url && /\.m3u8(\?|$)/i.test(url)) out.push({url,label:label||'Stream'}); };
  if(!j) return out;
  if(typeof j==='string'){ push(j,'Stream'); return out; }
  if(j.hls) push(j.hls,'HLS');
  const arr1 = Array.isArray(j.sources)? j.sources : null;
  const arr2 = j.data && Array.isArray(j.data.sources) ? j.data.sources : null;
  const arr = arr1 || arr2 || [];
  for(let it of arr){ push(it && (it.file||it.url), it && (it.label||it.quality)); }
  return out;
}

// Verifica che risponda davvero una playlist HLS (#EXTM3U)
async function verifyIsHls(url, referer){
  try{
    const r = await withTimeout(fetch(url,{ method:'GET', headers: hlsHeaders(referer) }), 12000);
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
    // *** Segnala HLS in tutti i modi ***
    type: 'hls',
    mimeType: 'application/vnd.apple.mpegurl',
    isHls: true,
    headers: hlsHeaders(referer)
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

async function getStreams(tmdbId, mediaType='movie', seasonNum=null, episodeNum=null){
  try{
    const embed = buildEmbed(mediaType, tmdbId, seasonNum, episodeNum);
    if(!embed) return [];

    const resA = await resolveFromEmbed(embed);
    let pool = (resA.m3u8s||[]).map(u=>({url:u,label:'Stream',_referer:embed}));

    const iframeUrl = resA.iframe || null;
    if(iframeUrl){
      const more = await resolveFromIframe(iframeUrl);
      pool = pool.concat(more.map(u=>({url:u,label:'Stream',_referer:iframeUrl})));
    }
    if(iframeUrl && containsRapidCloudHost(iframeUrl)){
      const rc = await resolveRapidCloud(iframeUrl);
      pool = pool.concat(rc||[]);
    }

    // dedup
    const seen={}, uniq=[];
    for(const c of pool){ if(c && c.url && !seen[c.url]){ seen[c.url]=true; uniq.push(c); } }

    // verifica HLS reale
    const checked=[];
    for(const c of uniq){
      const ok = await verifyIsHls(c.url, c._referer || embed);
      if(ok) checked.push(c);
    }

    if(!checked.length) return [buildExternal(embed)];

    const streams = checked.map(c=>buildHlsStream(c.url, c.label, c._referer || embed));
    streams.sort((a,b)=> qSortVal(b.quality) - qSortVal(a.quality));
    return streams;

  }catch(e){
    log('Errore: '+e.message);
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
