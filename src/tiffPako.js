// UTIF.js finds its inflate (Deflate/ZIP-compressed TIFF) through require() where there is one and through self.pako elsewhere: in the
// page's worker (src/tiffWorker.js) there is no require, so it is put there before the decoder loads (this module is imported first).
import pako from 'pako'

self.pako = pako
