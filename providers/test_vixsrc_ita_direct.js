// test_vixsrc_ita_direct.js
// Test locale opzionale (Node).
// Richiede: npm i cheerio-without-node-native
const { getStreams } = require('./vixsrc_ita_direct.js');

async function run() {
  console.log('=== Test VixSrc (ITA • Direct) ===');

  // Sostituisci con TMDB ID reali presenti su VixSrc
  const movie = await getStreams('786892', 'movie', null, null);
  console.log('FILM streams:', movie.length);
  console.log(movie);

  const tv = await getStreams('1396', 'tv', 1, 1);
  console.log('TV S1E1 streams:', tv.length);
  console.log(tv);
}

run().catch(console.error);
