(function (exports) {
  "use strict";

  const { findByProps, findByStoreName } = vendetta.metro;
  const { before, instead } = vendetta.patcher;

  const TAG = "[StickerSender]";
  const DEFAULTS = {
    stickerSize: 160,       // tamaño normal de un sticker de Discord
    emojiSize: 48,          // tamaño de emoji grande
    maskEmojiLinks: true,   // emoji dentro de texto: [nombre](url) en vez del link crudo
    animatedStickers: true, // false = manda siempre PNG estatico
    apngFormat: "png",      // como mandar stickers APNG animados: png | webp | gif (experimental)
    apngAsGif: true,        // APNG animados: convertirlos a GIF y subirlos como archivo (si falla, se manda el link)
    gifPad: 2,              // ancho del lienzo del GIF / ancho del sticker (mas alto = sticker mas chico en el chat)
    pickerCols: 4,          // columnas del selector (3 a 6)
    animatedPreview: true,  // el selector propio muestra los animados animados
    scrollMode: "gh",       // lista del selector: gh (gestos nativos) | rn (normal) | sheet (la hoja se desliza)
    nativeSheet: true,      // selector dentro del ActionSheet nativo (cierra bien). Apagar = modo de respaldo
    keepOpen: false,        // dejar el selector abierto despues de mandar (para mandar varios)
    nativeUnlock: true,     // intentar desbloquear los selectores nativos de Discord
    debugReport: false,     // copiar reporte al portapapeles en cada inicio
  };
  const cfg = (k) => {
    try { const v = vendetta.plugin.storage[k]; if (v !== undefined && v !== null) return v; } catch (_) {}
    return DEFAULTS[k];
  };
  const size = (k) => Math.min(512, Math.max(32, Math.round(Number(cfg(k))) || DEFAULTS[k]));

  const EMOJI_RE = /<(a?):(\w+):(\d+)>/g;
  const patches = [];
  const timers = [];
  let scanTimer = null;
  const unsubs = [];
  const S = {}; // stores y modulos de Discord (se llenan en onLoad)
  const state = {
    report: { patched: [], missing: [], similar: [] },
    spy: { sendMessage: 0, sendStickers: 0, last: "", lastResult: "", converted: 0, shape: 0, shapeLog: "", fnCalls: {}, lastUrl: "" },
  };
  const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).join("|") : String(o));

  const safe = (label, fn) => {
    try { return fn(); } catch (e) { console.error(TAG, label, "fallo:", e); }
  };
  const toast = (msg) => safe("toast", () => vendetta.ui.toasts.showToast(msg));
  const fmt = (s) => s.format_type ?? s.formatType;
  // Busqueda sin acentos ni mayusculas ("camaron" encuentra "Camarón")
  const norm = (x) => {
    try { return String(x ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
    catch (_) { return String(x ?? "").toLowerCase(); }
  };
  // Listas guardadas (favoritos y recientes)
  const getList = (k) => {
    try { const v = vendetta.plugin.storage[k]; return Array.isArray(v) ? [...v] : []; } catch (_) { return []; }
  };
  const setList = (k, v) => safe("guardar", () => { vendetta.plugin.storage[k] = v; });
  // Contador de usos (para el grupo "Mas usados"); objeto { clave: veces }, se poda para no crecer sin limite
  const getUses = () => {
    try { const v = vendetta.plugin.storage.uses; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
  };
  const pushRecent = (key) => {
    setList("recents", [key, ...getList("recents").filter((x) => x !== key)].slice(0, 40));
    safe("usos", () => {
      const u = { ...getUses() };
      u[key] = (u[key] || 0) + 1;
      const ks = Object.keys(u);
      if (ks.length > 300) {
        ks.sort((a, b) => u[a] - u[b]);
        for (const k of ks.slice(0, ks.length - 250)) delete u[k];
      }
      setList("uses", u);
    });
  };
  function toggleFav(key) {
    const f = getList("favs");
    const i = f.indexOf(key);
    if (i >= 0) f.splice(i, 1); else f.unshift(key);
    setList("favs", f);
    return i < 0;
  }

  // ---------- URLs ----------
  // format_type: 1 PNG, 2 APNG, 3 Lottie, 4 GIF
  function stickerUrl(s, szOverride) {
    const base = "https://media.discordapp.net/stickers/" + s.id;
    const sz = szOverride || size("stickerSize");
    const type = fmt(s);
    if (type === 3) return null; // Lottie: no existe como imagen
    // Igual que el cliente oficial: los animados llevan passthrough=true; sin eso el proxy manda un solo cuadro
    if (type === 4 && cfg("animatedStickers")) return base + ".gif?size=" + sz + "&passthrough=true";
    if (type === 2 && cfg("animatedStickers")) {
      const f = cfg("apngFormat");
      if (f === "webp") return base + ".webp?size=" + sz + "&animated=true&passthrough=true";
      if (f === "gif") return base + ".gif?size=" + sz + "&passthrough=true";
      return base + ".png?size=" + sz + "&passthrough=true";
    }
    return base + ".png?size=" + sz + "&passthrough=false";
  }
  function emojiUrl(id, animated) {
    return (
      "https://cdn.discordapp.com/emojis/" + id +
      (animated && cfg("animatedStickers") ? ".gif" : ".webp") +
      "?size=" + size("emojiSize") + "&quality=lossless"
    );
  }
  // Vista previa del selector: animada (GIF/APNG) si "animatedPreview" esta activo
  const previewUrl = (it) => {
    if (it.local) { // importado de la galeria: la imagen va dentro del propio plugin
      const L = it.lib;
      // un importado viejo guardado sin achicar (foto grande) tumba la app al dibujarse: se muestra un bloque gris (borralo y vuelve a importarlo)
      if (L.raw && ((L.bytes || 0) > 400 * 1024 || (L.w || 0) * (L.h || 0) > 1.2e6)) return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOIior6DwAELgIOn9bg+wAAAABJRU5ErkJggg==";
      return localUri(L);
    }
    if (it.kind === "sticker") {
      if (cfg("animatedPreview") && it.raw && fmt(it.raw) !== 3) {
        const u = stickerUrl(it.raw, 96);
        if (u) return u;
      }
      return "https://media.discordapp.net/stickers/" + it.id + ".png?size=96&passthrough=false";
    }
    return "https://cdn.discordapp.com/emojis/" + it.id +
      (it.animated && cfg("animatedPreview") ? ".gif" : ".webp") + "?size=64&quality=lossless";
  };

  // ---------- Envio ----------
  // Si estas respondiendo a un mensaje, mantiene la respuesta
  function pendingReply(channelId) {
    return safe("reply", () => {
      const p = S.PendingReplyStore?.getPendingReply?.(channelId);
      if (!p?.message?.id) return null;
      return {
        extra: {
          messageReference: {
            guild_id: p.channel?.guild_id,
            channel_id: p.channel?.id ?? channelId,
            message_id: p.message.id,
          },
          allowedMentions: { parse: ["users", "roles", "everyone"], replied_user: !!p.shouldMention },
        },
        clear: () => S.FluxDispatcher?.dispatch?.({ type: "DELETE_PENDING_REPLY", channelId }),
      };
    });
  }
  function makeNonce() {
    try { return String((BigInt(Date.now()) - 1420070400000n) << 22n); } catch (_) { return undefined; }
  }
  // El sendMessage de cada version de Discord pide los argumentos de forma distinta
  // (en la tuya fallaba con "nonce of undefined"). Se prueban varias formas y se recuerda la que sirve.
  const SHAPES = [
    (m, x) => [m, undefined, x],                         // (canal, mensaje, undefined, extra={})
    (m, x) => [m, undefined, { ...x, nonce: m.nonce }],  // extra con nonce
    (m, x) => [m, true, x],                              // esperando canal listo
    (m) => [m],                                          // solo mensaje
  ];
  const retryable = (e) => /undefined|null|not a function|nonce/i.test(String(e?.message ?? e));

  async function trySend(channelId, msg, extra) {
    let lastErr;
    for (let k = 0; k < SHAPES.length; k++) {
      const i = (state.spy.shape + k) % SHAPES.length;
      for (const mod of S.msgModules?.length ? S.msgModules : [S.MessageActions]) {
        try {
          const res = await mod.sendMessage(channelId, ...SHAPES[i](msg, { ...extra }));
          state.spy.shape = i;
          return res;
        } catch (e) {
          lastErr = e;
          state.spy.shapeLog += "forma" + i + ": " + String(e?.message ?? e).slice(0, 60) + " | ";
          if (!retryable(e)) throw e; // error real de Discord/red: no reintentar (evita duplicados)
        }
      }
    }
    throw lastErr;
  }

  function sendContent(channelId, content) {
    if (!channelId) channelId = S.SelectedChannelStore?.getChannelId?.();
    if (!channelId || !S.MessageActions) { toast("No hay canal abierto"); return; }
    state.spy.lastUrl = String(content).slice(0, 200);
    const reply = pendingReply(channelId);
    const msg = { content, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] };
    const nonce = makeNonce();
    if (nonce) msg.nonce = nonce;
    const p = trySend(channelId, msg, reply ? reply.extra : {});
    p.then(
      (r) => {
        state.spy.lastResult = r && typeof r === "object" ? "ok=" + r.ok + " status=" + r.status : String(r);
        if (r && r.ok === false) toast("Discord rechazo el mensaje: " + String(r.body?.message ?? r.status).slice(0, 100));
        else if (reply) safe("clear reply", reply.clear);
      },
      (e) => {
        state.spy.lastResult = "rechazo: " + String(e?.message ?? JSON.stringify(e)) + " @ " + String(e?.stack ?? "").split("\n").slice(0, 3).join(" / ");
        toast("Error al enviar: " + String(e?.message ?? e?.body?.message ?? "desconocido").slice(0, 100));
      }
    );
    return p;
  }

  // ---------- APNG -> GIF (JS puro: Hermes no trae zlib ni canvas) ----------
  // Lee el APNG cuadro por cuadro y lo reescribe como GIF. Solo se usa para stickers APNG.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  // Tabla de Huffman: indexada por los proximos "m" bits (LSB primero) -> (simbolo << 4) | largo
  function huff(lengths, n) {
    let m = 0;
    for (let i = 0; i < n; i++) if (lengths[i] > m) m = lengths[i];
    if (!m) return { t: new Int32Array(2), m: 1 };
    const count = new Int32Array(16), next = new Int32Array(16);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    let code = 0;
    for (let b = 1; b <= 15; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
    const size = 1 << m, t = new Int32Array(size);
    for (let s = 0; s < n; s++) {
      const L = lengths[s];
      if (!L) continue;
      let c = next[L]++, r = 0;
      for (let k = 0; k < L; k++) { r = (r << 1) | (c & 1); c >>= 1; }
      const e = (s << 4) | L;
      for (let i = r; i < size; i += 1 << L) t[i] = e;
    }
    return { t, m };
  }
  let FIXED = null;
  function fixedTables() {
    if (FIXED) return FIXED;
    const l = new Int32Array(288);
    for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    const d = new Int32Array(30).fill(5);
    return (FIXED = { lit: huff(l, 288), dist: huff(d, 30) });
  }

  // zlib (cabecera de 2 bytes + deflate); no verifica el checksum
  function inflateZlib(src, expected) {
    let pos = 2, bitbuf = 0, bitcnt = 0;
    let out = new Uint8Array(expected || 65536), op = 0;
    const grow = (need) => {
      let n = out.length * 2;
      while (n < op + need) n *= 2;
      const t = new Uint8Array(n);
      t.set(out.subarray(0, op));
      out = t;
    };
    const bits = (n) => {
      while (bitcnt < n) { bitbuf |= (src[pos++] | 0) << bitcnt; bitcnt += 8; }
      const v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n; bitcnt -= n;
      return v;
    };
    const sym = (h) => {
      while (bitcnt < h.m) { bitbuf |= (src[pos++] | 0) << bitcnt; bitcnt += 8; }
      const e = h.t[bitbuf & ((1 << h.m) - 1)];
      if (!e) throw new Error("inflate: codigo invalido");
      const L = e & 15;
      bitbuf >>>= L; bitcnt -= L;
      return e >> 4;
    };
    let last;
    do {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        const drop = bitcnt & 7;
        bitbuf >>>= drop; bitcnt -= drop;
        pos -= bitcnt >> 3;
        bitbuf = 0; bitcnt = 0;
        const len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        if (op + len > out.length) grow(len);
        for (let i = 0; i < len; i++) out[op++] = src[pos++];
        continue;
      }
      let lit, dist;
      if (type === 1) {
        const f = fixedTables(); lit = f.lit; dist = f.dist;
      } else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const cl = new Int32Array(19);
        for (let i = 0; i < hclen; i++) cl[CLORD[i]] = bits(3);
        const clh = huff(cl, 19);
        const lens = new Int32Array(hlit + hdist);
        let i = 0;
        while (i < hlit + hdist) {
          const s = sym(clh);
          if (s < 16) { lens[i++] = s; continue; }
          let rep, val = 0;
          if (s === 16) { val = lens[i - 1]; rep = 3 + bits(2); }
          else if (s === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          while (rep-- > 0) lens[i++] = val;
        }
        lit = huff(lens.subarray(0, hlit), hlit);
        dist = huff(lens.subarray(hlit), hdist);
      } else throw new Error("inflate: bloque invalido");
      for (;;) {
        const s = sym(lit);
        if (s < 256) { if (op >= out.length) grow(1); out[op++] = s; }
        else if (s === 256) break;
        else {
          const li = s - 257;
          const len = LBASE[li] + bits(LEXT[li]);
          const ds = sym(dist);
          const d = DBASE[ds] + bits(DEXT[ds]);
          if (d > op) throw new Error("inflate: distancia invalida");
          if (op + len > out.length) grow(len);
          for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
        }
      }
    } while (!last);
    return out.subarray(0, op);
  }

  const PNG_CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  // Datos de imagen de un cuadro (IDAT/fdAT juntos) -> RGBA de 8 bits
  function decodePngData(parts, w, h, ctype, depth, plte, trns) {
    const ch = PNG_CH[ctype];
    if (!ch) throw new Error("tipo de color PNG no soportado");
    const stride = Math.ceil((w * ch * depth) / 8);
    let total = 0;
    for (const p of parts) total += p.length;
    const z = new Uint8Array(total);
    let zo = 0;
    for (const p of parts) { z.set(p, zo); zo += p.length; }
    const raw = inflateZlib(z, h * (stride + 1));
    if (raw.length < h * (stride + 1)) throw new Error("datos de imagen incompletos");
    const bpp = Math.max(1, (ch * depth) >> 3);
    const data = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
      const ft = raw[y * (stride + 1)], rs = y * (stride + 1) + 1, ds = y * stride, up = ds - stride;
      if (ft === 0) { for (let i = 0; i < stride; i++) data[ds + i] = raw[rs + i]; }
      else if (ft === 1) { for (let i = 0; i < stride; i++) data[ds + i] = raw[rs + i] + (i >= bpp ? data[ds + i - bpp] : 0); }
      else if (ft === 2) { for (let i = 0; i < stride; i++) data[ds + i] = raw[rs + i] + (y ? data[up + i] : 0); }
      else if (ft === 3) {
        for (let i = 0; i < stride; i++) {
          const l = i >= bpp ? data[ds + i - bpp] : 0, u = y ? data[up + i] : 0;
          data[ds + i] = raw[rs + i] + ((l + u) >> 1);
        }
      } else if (ft === 4) {
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? data[ds + i - bpp] : 0, b = y ? data[up + i] : 0, c = i >= bpp && y ? data[up + i - bpp] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          data[ds + i] = raw[rs + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      } else throw new Error("filtro PNG invalido");
    }
    const out = new Uint8Array(w * h * 4);
    if (depth === 8 && ctype === 6) {
      out.set(data);
    } else if (depth === 8 && ctype === 2) {
      const key = trns && trns.length >= 6 ? [trns[1], trns[3], trns[5]] : null;
      for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      }
    } else if (depth === 8 && ctype === 3) {
      if (!plte) throw new Error("falta la paleta");
      for (let i = 0, o = 0; i < data.length; i++, o += 4) {
        const k = data[i];
        out[o] = plte[k * 3]; out[o + 1] = plte[k * 3 + 1]; out[o + 2] = plte[k * 3 + 2];
        out[o + 3] = trns && k < trns.length ? trns[k] : 255;
      }
    } else {
      const smp = (rs, idx) => {
        if (depth === 8) return data[rs + idx];
        if (depth === 16) return (data[rs + 2 * idx] << 8) | data[rs + 2 * idx + 1];
        const bp = idx * depth;
        return (data[rs + (bp >> 3)] >> (8 - depth - (bp & 7))) & ((1 << depth) - 1);
      };
      const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
      const tk = (i) => (trns && trns.length >= i * 2 + 2 ? (trns[i * 2] << 8) | trns[i * 2 + 1] : -1);
      for (let y = 0; y < h; y++) {
        const rs = y * stride;
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          let r, g, b, a = 255;
          if (ctype === 0) {
            const v = smp(rs, x);
            r = g = b = to8(v);
            if (v === tk(0)) a = 0;
          } else if (ctype === 2) {
            const vr = smp(rs, x * 3), vg = smp(rs, x * 3 + 1), vb = smp(rs, x * 3 + 2);
            r = to8(vr); g = to8(vg); b = to8(vb);
            if (vr === tk(0) && vg === tk(1) && vb === tk(2)) a = 0;
          } else if (ctype === 3) {
            if (!plte) throw new Error("falta la paleta");
            const k = smp(rs, x);
            r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2];
            a = trns && k < trns.length ? trns[k] : 255;
          } else if (ctype === 4) {
            r = g = b = to8(smp(rs, x * 2)); a = to8(smp(rs, x * 2 + 1));
          } else {
            r = to8(smp(rs, x * 4)); g = to8(smp(rs, x * 4 + 1)); b = to8(smp(rs, x * 4 + 2)); a = to8(smp(rs, x * 4 + 3));
          }
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
      }
    }
    return out;
  }

  // Trozos del archivo APNG -> lista de cuadros (cada uno con sus datos comprimidos)
  function parseApng(b) {
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error("no es un PNG");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 8, ihdr = null, plte = null, trns = null, actl = null, cur = null;
    const frames = [];
    while (p + 8 <= b.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      const d = b.subarray(p + 8, p + 8 + len);
      if (type === "IHDR") ihdr = { w: dv.getUint32(p + 8), h: dv.getUint32(p + 12), depth: d[8], ctype: d[9], interlace: d[12] };
      else if (type === "PLTE") plte = d;
      else if (type === "tRNS") trns = d;
      else if (type === "acTL") actl = { n: dv.getUint32(p + 8), plays: dv.getUint32(p + 12) };
      else if (type === "fcTL") {
        cur = {
          w: dv.getUint32(p + 12), h: dv.getUint32(p + 16), x: dv.getUint32(p + 20), y: dv.getUint32(p + 24),
          dn: dv.getUint16(p + 28), dd: dv.getUint16(p + 30), dispose: d[24], blend: d[25], parts: [],
        };
        frames.push(cur);
      } else if (type === "IDAT") { if (cur && frames.length === 1) cur.parts.push(d); } // sin fcTL antes = imagen por defecto, no es parte de la animacion
      else if (type === "fdAT") { if (cur) cur.parts.push(d.subarray(4)); }
      else if (type === "IEND") break;
      p += 12 + len;
    }
    if (!ihdr) throw new Error("PNG sin cabecera");
    if (!actl || frames.length < 2) throw new Error("no es un APNG animado");
    if (ihdr.interlace) throw new Error("PNG entrelazado no soportado");
    return { w: ihdr.w, h: ihdr.h, depth: ihdr.depth, ctype: ihdr.ctype, plte, trns, plays: actl.plays, frames };
  }

  // Promedio por cajas (con el alfa como peso) para achicar el cuadro al tamano del sticker
  function scaleRGBA(src, W, H, ow, oh) {
    if (ow === W && oh === H) return src.slice();
    const out = new Uint8Array(ow * oh * 4);
    for (let oy = 0; oy < oh; oy++) {
      const y0 = Math.floor((oy * H) / oh), y1 = Math.max(y0 + 1, Math.ceil(((oy + 1) * H) / oh));
      for (let ox = 0; ox < ow; ox++) {
        const x0 = Math.floor((ox * W) / ow), x1 = Math.max(x0 + 1, Math.ceil(((ox + 1) * W) / ow));
        let sa = 0, sr = 0, sg = 0, sb = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < H; yy++)
          for (let xx = x0; xx < x1 && xx < W; xx++) {
            const i = (yy * W + xx) * 4, a = src[i + 3];
            sa += a; sr += src[i] * a; sg += src[i + 1] * a; sb += src[i + 2] * a; n++;
          }
        const o = (oy * ow + ox) * 4;
        if (sa > 0) {
          out[o] = Math.round(sr / sa); out[o + 1] = Math.round(sg / sa); out[o + 2] = Math.round(sb / sa);
          out[o + 3] = Math.round(sa / n);
        }
      }
    }
    return out;
  }

  // Arma cada cuadro completo (dispose/blend de APNG) y lo achica a "target" px como maximo
  async function apngFrames(info, target) {
    const W = info.w, H = info.h;
    const sc = Math.min(1, target / Math.max(W, H));
    const ow = Math.max(1, Math.round(W * sc)), oh = Math.max(1, Math.round(H * sc));
    let canvas = new Uint8Array(W * H * 4);
    const res = [];
    for (let fi = 0; fi < info.frames.length; fi++) {
      const fr = info.frames[fi];
      const px = decodePngData(fr.parts, fr.w, fr.h, info.ctype, info.depth, info.plte, info.trns);
      const disp = fr.dispose === 2 && fi === 0 ? 1 : fr.dispose;
      const prev = disp === 2 ? canvas.slice() : null;
      for (let y = 0; y < fr.h; y++) {
        const cy = fr.y + y;
        if (cy >= H) break;
        for (let x = 0; x < fr.w; x++) {
          const cx = fr.x + x;
          if (cx >= W) break;
          const si = (y * fr.w + x) * 4, di = (cy * W + cx) * 4, sa = px[si + 3];
          if (fr.blend === 0 || sa === 255 || canvas[di + 3] === 0) {
            canvas[di] = px[si]; canvas[di + 1] = px[si + 1]; canvas[di + 2] = px[si + 2]; canvas[di + 3] = sa;
          } else if (sa !== 0) {
            const da = canvas[di + 3], k = (da * (255 - sa)) / 255, oa = sa + k;
            canvas[di] = Math.round((px[si] * sa + canvas[di] * k) / oa);
            canvas[di + 1] = Math.round((px[si + 1] * sa + canvas[di + 1] * k) / oa);
            canvas[di + 2] = Math.round((px[si + 2] * sa + canvas[di + 2] * k) / oa);
            canvas[di + 3] = Math.round(oa);
          }
        }
      }
      const cs = fr.dn === 0 ? 10 : Math.max(2, Math.round((fr.dn / (fr.dd || 100)) * 100));
      res.push({ rgba: scaleRGBA(canvas, W, H, ow, oh), cs });
      if (disp === 1) {
        for (let y = 0; y < fr.h && fr.y + y < H; y++)
          for (let x = 0; x < fr.w && fr.x + x < W; x++) {
            const di = ((fr.y + y) * W + fr.x + x) * 4;
            canvas[di] = canvas[di + 1] = canvas[di + 2] = canvas[di + 3] = 0;
          }
      } else if (disp === 2 && prev) canvas = prev;
      if (fi % 4 === 3) await tick();
    }
    return { w: ow, h: oh, frames: res };
  }

  // Paleta global de 255 colores (median cut sobre un histograma de 15 bits); el indice 255 es el transparente
  function buildPalette(frames) {
    const cnt = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    for (const f of frames) {
      const d = f.rgba;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
        cnt[k]++; sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2];
      }
    }
    const ids = [];
    for (let k = 0; k < 32768; k++) if (cnt[k] > 0) ids.push(k);
    const arr = Int32Array.from(ids), lut = new Uint8Array(32768);
    if (!arr.length) return { pal: [[0, 0, 0]], lut };
    const stat = (b) => {
      let r0 = 31, r1 = 0, g0 = 31, g1 = 0, b0 = 31, b1 = 0, pop = 0;
      for (let i = b.lo; i < b.hi; i++) {
        const id = arr[i], r = id >> 10, g = (id >> 5) & 31, bl = id & 31;
        if (r < r0) r0 = r; if (r > r1) r1 = r;
        if (g < g0) g0 = g; if (g > g1) g1 = g;
        if (bl < b0) b0 = bl; if (bl > b1) b1 = bl;
        pop += cnt[id];
      }
      const rr = r1 - r0, gr = g1 - g0, br = b1 - b0;
      b.pop = pop;
      b.ch = rr >= gr && rr >= br ? 0 : gr >= br ? 1 : 2;
      b.range = Math.max(rr, gr, br);
      b.score = b.range * Math.sqrt(pop);
    };
    const boxes = [{ lo: 0, hi: arr.length }];
    stat(boxes[0]);
    while (boxes.length < 255) {
      let bi = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.hi - b.lo > 1 && b.range > 0 && b.score > best) { best = b.score; bi = i; }
      }
      if (bi < 0) break;
      const b = boxes[bi], shift = b.ch === 0 ? 10 : b.ch === 1 ? 5 : 0;
      const tmp = Array.from(arr.subarray(b.lo, b.hi));
      tmp.sort((p, q) => ((p >> shift) & 31) - ((q >> shift) & 31));
      arr.set(tmp, b.lo);
      const half = b.pop / 2;
      let acc = 0, mid = b.lo + 1;
      for (let i = b.lo; i < b.hi - 1; i++) { acc += cnt[arr[i]]; mid = i + 1; if (acc >= half) break; }
      const nb = { lo: mid, hi: b.hi };
      b.hi = mid;
      stat(b); stat(nb);
      boxes.push(nb);
    }
    const pal = [];
    boxes.forEach((b, bi) => {
      let R = 0, G = 0, B = 0, N = 0;
      for (let i = b.lo; i < b.hi; i++) { const id = arr[i]; R += sr[id]; G += sg[id]; B += sb[id]; N += cnt[id]; lut[id] = bi; }
      pal.push([Math.round(R / N), Math.round(G / N), Math.round(B / N)]);
    });
    return { pal, lut };
  }

  // LZW de GIF. "table" (Int32Array de 1<<20) se reutiliza entre cuadros
  function lzwEncode(idx, minCode, table) {
    const clear = 1 << minCode, eoi = clear + 1;
    let out = new Uint8Array(((idx.length * 3) >> 1) + 1024), op = 0, cur = 0, curBits = 0;
    const emit = (code, size) => {
      cur |= code << curBits;
      curBits += size;
      while (curBits >= 8) {
        if (op >= out.length) { const t = new Uint8Array(out.length * 2); t.set(out); out = t; }
        out[op++] = cur & 255;
        cur >>>= 8; curBits -= 8;
      }
    };
    table.fill(0);
    let size = minCode + 1, next = eoi + 1;
    emit(clear, size);
    let c = idx[0];
    for (let i = 1; i < idx.length; i++) {
      const k = idx[i], key = (c << 8) | k, hit = table[key];
      if (hit) { c = hit; continue; }
      emit(c, size);
      if (next === 4096) { emit(clear, size); table.fill(0); size = minCode + 1; next = eoi + 1; }
      else { if (next >= 1 << size) size++; table[key] = next++; }
      c = k;
    }
    emit(c, size);
    emit(eoi, size);
    if (curBits > 0) { if (op >= out.length) { const t = new Uint8Array(out.length + 1); t.set(out); out = t; } out[op++] = cur & 255; }
    return out.subarray(0, op);
  }

  async function gifEncode(anim) {
    const { w, h, frames } = anim;
    const { pal, lut } = buildPalette(frames);
    const parts = [];
    parts.push(new Uint8Array([71, 73, 70, 56, 57, 97, w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0]));
    const gct = new Uint8Array(768);
    pal.forEach((c, i) => { gct[i * 3] = c[0]; gct[i * 3 + 1] = c[1]; gct[i * 3 + 2] = c[2]; });
    parts.push(gct);
    // bucle infinito
    parts.push(new Uint8Array([0x21, 0xff, 0x0b, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0]));
    const table = new Int32Array(1 << 20);
    for (let fi = 0; fi < frames.length; fi++) {
      const f = frames[fi], d = f.rgba, idx = new Uint8Array(w * h);
      for (let i = 0, j = 0; j < idx.length; i += 4, j++) {
        idx[j] = d[i + 3] < 128 ? 255 : lut[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)];
      }
      // disposal 2 (volver al fondo) + transparencia 255: cada cuadro reemplaza al anterior
      parts.push(new Uint8Array([0x21, 0xf9, 4, (2 << 2) | 1, f.cs & 255, f.cs >> 8, 255, 0]));
      parts.push(new Uint8Array([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 8]));
      const data = lzwEncode(idx, 8, table);
      for (let o = 0; o < data.length; o += 255) {
        const n = Math.min(255, data.length - o);
        const blk = new Uint8Array(n + 1);
        blk[0] = n;
        blk.set(data.subarray(o, o + n), 1);
        parts.push(blk);
      }
      parts.push(new Uint8Array([0]));
      if (fi % 3 === 2) await tick();
    }
    parts.push(new Uint8Array([0x3b]));
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Discord (movil) agranda los archivos chicos hasta llenar el ancho del chat, asi que un GIF de 160 px
  // se ve enorme. Solucion: lienzo transparente mas ANCHO (no mas alto) con el sticker pegado a la izquierda.
  // Discord agranda el lienzo al ancho del chat y el sticker queda con tamano normal, sin espacio vertical
  // de sobra y alineado a la izquierda como un sticker de verdad. "gifPad" = ancho del lienzo / ancho del
  // sticker (ajustable en Ajustes). 1 = sin margen.
  const gifPad = () => { const n = Number(cfg("gifPad")); return n >= 1 && n <= 6 ? n : 2; };
  function padFrames(anim, k) {
    if (!(k > 1)) return anim;
    const W = Math.round(anim.w * k), rowBytes = anim.w * 4;
    for (const f of anim.frames) {
      const out = new Uint8Array(W * anim.h * 4); // todo transparente
      for (let y = 0; y < anim.h; y++)
        out.set(f.rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * W * 4);
      f.rgba = out; // el cuadro original se libera
    }
    anim.w = W;
    return anim;
  }

  // Bytes del APNG -> bytes del GIF (a "target" px como maximo)
  async function apngToGif(bytes, target) {
    const info = parseApng(bytes);
    const anim = padFrames(await apngFrames(info, target), gifPad());
    return gifEncode(anim);
  }

  // ---------- APNG -> GIF: descarga y subida ----------
  const gifState = { last: "", ok: 0, fail: 0 };
  const gifCache = new Map(); // id|tamano|margen -> bytes del GIF (ultimos 8)
  const gifBusy = new Set();  // canal:sticker que se estan convirtiendo ahora
  const getToken = () => {
    for (const f of [
      () => findByStoreName("AuthenticationStore")?.getToken?.(),
      () => findByProps("getToken")?.getToken?.(),
    ]) {
      const t = safe("token", f);
      if (typeof t === "string" && t.length > 20) return t;
    }
    return null;
  };
  // APNG animado y todo lo necesario para convertirlo
  const wantGif = (st) => !!st && fmt(st) === 2 && !!cfg("apngAsGif") && !!cfg("animatedStickers") && !!getToken();

  const asciiBytes = (s) => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    return b;
  };
  // JSON solo ASCII (los caracteres raros van como \uXXXX) para poder armar el multipart a mano
  const jsonAscii = (o) => JSON.stringify(o).replace(/[\u0080-\uffff]/g, (c) => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));

  function buildMultipart(boundary, payload, filename, fileBytes, mime) {
    const head = asciiBytes(
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n" +
      jsonAscii(payload) + "\r\n--" + boundary +
      "\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"" + filename + "\"\r\nContent-Type: " + (mime || "image/gif") + "\r\n\r\n"
    );
    const tail = asciiBytes("\r\n--" + boundary + "--\r\n");
    const out = new Uint8Array(head.length + fileBytes.length + tail.length);
    out.set(head, 0);
    out.set(fileBytes, head.length);
    out.set(tail, head.length + fileBytes.length);
    return out;
  }

  function xhrGetBytes(url) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", url);
      x.responseType = "arraybuffer";
      x.timeout = 25000;
      x.onload = () => {
        if (x.status >= 200 && x.status < 300 && x.response) resolve(new Uint8Array(x.response));
        else reject(new Error("HTTP " + x.status));
      };
      x.onerror = () => reject(new Error("sin red"));
      x.ontimeout = () => reject(new Error("tiempo agotado"));
      x.send();
    });
  }
  // El APNG original (con passthrough el proxy no lo toca); si no, el CDN
  async function downloadApng(id) {
    let lastErr;
    for (const url of [
      "https://media.discordapp.net/stickers/" + id + ".png?size=320&passthrough=true",
      "https://cdn.discordapp.com/stickers/" + id + ".png",
    ]) {
      try {
        const b = await xhrGetBytes(url);
        if (b.length > 8 && b[1] === 80 && b[2] === 78) return b;
        lastErr = new Error("respuesta no es PNG");
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("no se pudo bajar el sticker");
  }

  function postMultipart(url, token, boundary, body) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", url);
      x.setRequestHeader("Authorization", token);
      x.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
      x.timeout = 60000;
      x.onload = () => resolve({ status: x.status, text: String(x.responseText || "") });
      x.onerror = () => reject(new Error("sin red"));
      x.ontimeout = () => reject(new Error("tiempo agotado"));
      x.send(body);
    });
  }

  // Manda el GIF como archivo adjunto en el canal (respeta la respuesta pendiente)
  async function uploadGif(channelId, gif, name, text, mime) {
    const token = getToken();
    if (!token) throw new Error("no hay sesion");
    const reply = pendingReply(channelId);
    const payload = { content: text || "", tts: false, flags: 0, attachments: [{ id: 0, filename: name }] };
    const nonce = makeNonce();
    if (nonce) payload.nonce = nonce;
    if (reply) {
      payload.message_reference = reply.extra.messageReference;
      payload.allowed_mentions = reply.extra.allowedMentions;
    }
    const boundary = "----StickerSender" + Date.now().toString(16);
    const res = await postMultipart(
      "https://discord.com/api/v9/channels/" + channelId + "/messages",
      token, boundary, buildMultipart(boundary, payload, name, gif, mime)
    );
    if (res.status < 200 || res.status >= 300) {
      let msg = res.text.slice(0, 120);
      try { msg = JSON.parse(res.text).message || msg; } catch (_) {}
      throw new Error("Discord " + res.status + ": " + msg);
    }
    if (reply) safe("clear reply", reply.clear);
  }

  // Sticker APNG -> GIF -> archivo. Si algo falla, se manda el link como antes.
  async function sendApngGif(channelId, st, text, fallbackUrl) {
    if (!channelId) channelId = S.SelectedChannelStore?.getChannelId?.();
    const fallback = (why) => {
      gifState.fail++;
      gifState.last = "fallo: " + why;
      console.warn(TAG, "APNG->GIF fallo:", why);
      toast("No se pudo mandar como GIF (" + String(why).slice(0, 60) + "). Mando el link.");
      sendContent(channelId, (text ? text + "\n" : "") + fallbackUrl);
    };
    if (!channelId) return fallback("sin canal");
    // Si ese mismo sticker ya se esta convirtiendo/subiendo en este canal, un toque repetido se ignora (evita duplicados)
    const busyKey = channelId + ":" + st.id;
    if (gifBusy.has(busyKey)) return;
    gifBusy.add(busyKey);
    try {
      const t0 = Date.now();
      // Los ultimos GIF convertidos se recuerdan: mandar de nuevo el mismo sticker es casi instantaneo
      const ck = st.id + "|" + size("stickerSize") + "|" + gifPad();
      let gif = gifCache.get(ck);
      if (gif) { gifCache.delete(ck); gifCache.set(ck, gif); }
      else {
        toast("Convirtiendo sticker a GIF...");
        const bytes = await downloadApng(st.id);
        gif = await apngToGif(bytes, size("stickerSize"));
        if (gif.length > 9 * 1024 * 1024) throw new Error("GIF demasiado grande");
        gifCache.set(ck, gif);
        // maximo 8 GIF y 6 MB en total (los mas viejos se descartan primero)
        let tot = 0;
        for (const g of gifCache.values()) tot += g.length;
        while (gifCache.size > 1 && (gifCache.size > 8 || tot > 6 * 1024 * 1024)) {
          const k = gifCache.keys().next().value;
          tot -= gifCache.get(k).length;
          gifCache.delete(k);
        }
      }
      const name = (String(st.name || "sticker").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "sticker") + ".gif";
      await uploadGif(channelId, gif, name, text);
      gifState.ok++;
      gifState.last = "ok " + gif.length + " bytes en " + (Date.now() - t0) + " ms";
    } catch (e) {
      fallback(String(e?.message ?? e));
    } finally {
      gifBusy.delete(busyKey);
    }
  }

  // ======================================================================================
  // ---------- Importar imagenes de la galeria (stickers / emojis propios) ----------
  // ======================================================================================
  // Codecs en JS puro (Hermes no trae canvas ni zlib): base64, PNG (leer y escribir) y GIF (leer).
  const B64S = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let B64R = null, B64E = null;
  function b64decode(str) {
    if (!B64R) {
      B64R = new Int16Array(256).fill(-1);
      for (let i = 0; i < 64; i++) B64R[B64S.charCodeAt(i)] = i;
      B64R[45] = 62; B64R[95] = 63; // variante url-safe
    }
    const s = String(str), len = s.length;
    const out = new Uint8Array(Math.floor((len * 3) / 4) + 3);
    let acc = 0, bits = 0, op = 0;
    for (let i = 0; i < len; i++) {
      const c = s.charCodeAt(i), v = c < 256 ? B64R[c] : -1;
      if (v < 0) continue; // "=", espacios y saltos de linea
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[op++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
    }
    return out.subarray(0, op);
  }
  function b64encode(u8) {
    if (!B64E) { B64E = new Uint8Array(64); for (let i = 0; i < 64; i++) B64E[i] = B64S.charCodeAt(i); }
    const n = u8.length, olen = Math.ceil(n / 3) * 4, o = new Uint8Array(olen);
    let op = 0;
    for (let i = 0; i < n; i += 3) {
      const a = u8[i], b = i + 1 < n ? u8[i + 1] : 0, c = i + 2 < n ? u8[i + 2] : 0;
      o[op++] = B64E[a >> 2];
      o[op++] = B64E[((a & 3) << 4) | (b >> 4)];
      o[op++] = i + 1 < n ? B64E[((b & 15) << 2) | (c >> 6)] : 61;
      o[op++] = i + 2 < n ? B64E[c & 63] : 61;
    }
    const parts = [];
    for (let i = 0; i < olen; i += 8192) parts.push(String.fromCharCode.apply(null, o.subarray(i, Math.min(olen, i + 8192))));
    return parts.join("");
  }

  // Tipo de imagen por sus primeros bytes
  function sniffImage(b) {
    if (!b || b.length < 16) return null;
    if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return "png";
    if (b[0] === 71 && b[1] === 73 && b[2] === 70) return "gif";
    if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
    if (b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) return "webp";
    return null;
  }
  // Medidas y si es animado, sin decodificar (para JPG/WebP y para el aviso previo)
  function quickInfo(b, type) {
    let w = 0, h = 0, animated = false;
    try {
      if (type === "png") {
        w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
        h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
        let p = 8;
        while (p + 8 <= b.length) {
          const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
          const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
          if (t === "acTL") { animated = true; break; }
          if (t === "IDAT" || t === "IEND") break;
          p += 12 + len;
        }
      } else if (type === "gif") {
        w = b[6] | (b[7] << 8); h = b[8] | (b[9] << 8);
        animated = true; // se confirma al decodificar
      } else if (type === "jpg") {
        let p = 2;
        while (p + 9 < b.length && b[p] === 255) {
          const m = b[p + 1];
          if (m === 255) { p++; continue; }
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = (b[p + 5] << 8) | b[p + 6]; w = (b[p + 7] << 8) | b[p + 8]; break; }
          p += 2 + ((b[p + 2] << 8) | b[p + 3]);
        }
      } else if (type === "webp") {
        const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (t === "VP8X") { animated = !!(b[20] & 2); w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); }
        else if (t === "VP8L") { const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0; w = (v & 0x3fff) + 1; h = ((v >>> 14) & 0x3fff) + 1; }
        else if (t === "VP8 ") { w = (b[26] | (b[27] << 8)) & 0x3fff; h = (b[28] | (b[29] << 8)) & 0x3fff; }
      }
    } catch (_) {}
    return { w, h, animated };
  }

  // PNG normal (no animado): una sola imagen -> RGBA
  function parsePngStatic(b) {
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error("no es un PNG");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 8, ihdr = null, plte = null, trns = null;
    const parts = [];
    while (p + 8 <= b.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      const d = b.subarray(p + 8, p + 8 + len);
      if (type === "IHDR") ihdr = { w: dv.getUint32(p + 8), h: dv.getUint32(p + 12), depth: d[8], ctype: d[9], interlace: d[12] };
      else if (type === "PLTE") plte = d;
      else if (type === "tRNS") trns = d;
      else if (type === "IDAT") parts.push(d);
      else if (type === "IEND") break;
      p += 12 + len;
    }
    if (!ihdr || !parts.length) throw new Error("PNG incompleto");
    if (ihdr.interlace) throw new Error("PNG entrelazado no soportado");
    if (!ihdr.w || !ihdr.h || ihdr.w * ihdr.h > 36e6) throw new Error("imagen demasiado grande");
    return { w: ihdr.w, h: ihdr.h, rgba: decodePngData(parts, ihdr.w, ihdr.h, ihdr.ctype, ihdr.depth, plte, trns) };
  }

  // LZW de GIF (lectura)
  function lzwDecode(data, minCode, npix) {
    const clear = 1 << minCode, eoi = clear + 1;
    const out = new Uint8Array(npix), prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) suffix[i] = i;
    let size = minCode + 1, next = eoi + 1, mask = (1 << size) - 1, bits = 0, nb = 0, pos = 0, op = 0, prev = -1, first = 0;
    while (op < npix) {
      while (nb < size && pos < data.length) { bits |= data[pos++] << nb; nb += 8; }
      if (nb < size) break;
      const code = bits & mask;
      bits >>>= size; nb -= size;
      if (code === clear) { size = minCode + 1; next = eoi + 1; mask = (1 << size) - 1; prev = -1; continue; }
      if (code === eoi) break;
      if (prev === -1) { first = suffix[code]; out[op++] = first; prev = code; continue; }
      let sp = 0, cur;
      if (code >= next) { stack[sp++] = first; cur = prev; } else cur = code;
      while (cur >= clear) { stack[sp++] = suffix[cur]; cur = prefix[cur]; }
      first = suffix[cur];
      stack[sp++] = first;
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first; next++;
        if (next > mask && size < 12) { size++; mask = (1 << size) - 1; }
      }
      prev = code;
      while (sp > 0 && op < npix) out[op++] = stack[--sp];
    }
    return out;
  }

  // GIF -> cuadros RGBA completos (con disposal y transparencia), ya achicados a "target" px como maximo.
  // Si tiene mas de "maxFrames" cuadros se saltan algunos (sumando sus tiempos) para no gastar memoria.
  async function decodeGif(b, target, maxFrames) {
    if (b[0] !== 71 || b[1] !== 73 || b[2] !== 70) throw new Error("no es un GIF");
    const W = b[6] | (b[7] << 8), H = b[8] | (b[9] << 8);
    if (!W || !H || W * H > 16e6) throw new Error("GIF demasiado grande");
    let p = 10;
    const pk = b[p++];
    p += 2;
    let gct = null;
    if (pk & 0x80) { const n = 3 << ((pk & 7) + 1); gct = b.subarray(p, p + n); p += n; }
    // 1) recorrer los bloques sin decodificar
    const imgs = [];
    let gce = null;
    while (p < b.length) {
      const t = b[p++];
      if (t === 0x3b) break;
      if (t === 0x21) {
        const label = b[p++];
        if (label === 0xf9) {
          const f = b[p + 1];
          gce = { disposal: (f >> 2) & 7, transp: f & 1 ? b[p + 4] : -1, delay: b[p + 2] | (b[p + 3] << 8) };
        }
        let n;
        while (p < b.length && (n = b[p++])) p += n;
        continue;
      }
      if (t !== 0x2c) throw new Error("GIF danado");
      const im = { x: b[p] | (b[p + 1] << 8), y: b[p + 2] | (b[p + 3] << 8), w: b[p + 4] | (b[p + 5] << 8), h: b[p + 6] | (b[p + 7] << 8), gce };
      const fl = b[p + 8];
      p += 9;
      im.ct = gct;
      if (fl & 0x80) { const n = 3 << ((fl & 7) + 1); im.ct = b.subarray(p, p + n); p += n; }
      im.interlaced = !!(fl & 0x40);
      im.minCode = b[p++];
      im.chunks = [];
      let n, total = 0;
      while (p < b.length && (n = b[p++])) { im.chunks.push(b.subarray(p, p + n)); total += n; p += n; }
      im.total = total;
      imgs.push(im);
      gce = null;
    }
    if (!imgs.length) throw new Error("GIF sin cuadros");
    // 2) componer
    const step = Math.max(1, Math.ceil(imgs.length / (maxFrames || 90)));
    const sc = Math.min(1, target / Math.max(W, H));
    const ow = Math.max(1, Math.round(W * sc)), oh = Math.max(1, Math.round(H * sc));
    let canvas = new Uint8Array(W * H * 4);
    const frames = [];
    for (let fi = 0; fi < imgs.length; fi++) {
      const im = imgs[fi], ct = im.ct;
      if (!ct) throw new Error("GIF sin paleta");
      const raw = new Uint8Array(im.total);
      let o = 0;
      for (const c of im.chunks) { raw.set(c, o); o += c.length; }
      const idx = lzwDecode(raw, im.minCode, im.w * im.h);
      const g = im.gce, disposal = g ? g.disposal : 0, tr = g ? g.transp : -1;
      const prev = disposal === 3 ? canvas.slice() : null;
      for (let y = 0; y < im.h; y++) {
        let sy = y;
        if (im.interlaced) { // las filas vienen en 4 pasadas
          const q = im.h, p1 = (q + 7) >> 3, p2 = (q + 3) >> 3, p3 = (q + 1) >> 2;
          sy = y < p1 ? y * 8 : y < p1 + p2 ? (y - p1) * 8 + 4 : y < p1 + p2 + p3 ? (y - p1 - p2) * 4 + 2 : (y - p1 - p2 - p3) * 2 + 1;
        }
        const cy = im.y + sy;
        if (cy >= H) continue;
        for (let x = 0; x < im.w; x++) {
          const cx = im.x + x;
          if (cx >= W) break;
          const k = idx[y * im.w + x];
          if (k === tr) continue;
          const di = (cy * W + cx) * 4;
          canvas[di] = ct[k * 3]; canvas[di + 1] = ct[k * 3 + 1]; canvas[di + 2] = ct[k * 3 + 2]; canvas[di + 3] = 255;
        }
      }
      const cs = g && g.delay > 1 ? g.delay : 10;
      if (fi % step === 0) frames.push({ rgba: scaleRGBA(canvas, W, H, ow, oh), cs });
      else frames[frames.length - 1].cs += cs;
      if (disposal === 2) {
        for (let y = 0; y < im.h && im.y + y < H; y++)
          for (let x = 0; x < im.w && im.x + x < W; x++) {
            const di = ((im.y + y) * W + im.x + x) * 4;
            canvas[di] = canvas[di + 1] = canvas[di + 2] = canvas[di + 3] = 0;
          }
      } else if (disposal === 3 && prev) canvas = prev;
      if (fi % 4 === 3) await tick();
    }
    for (const f of frames) f.cs = Math.min(f.cs, 65535);
    return { w: ow, h: oh, frames };
  }

  // Achica cuadros sueltos (PNG normal) a "target" px como maximo
  async function scaleFrames(frames, W, H, target) {
    const sc = Math.min(1, target / Math.max(W, H));
    const ow = Math.max(1, Math.round(W * sc)), oh = Math.max(1, Math.round(H * sc));
    for (let i = 0; i < frames.length; i++) {
      frames[i].rgba = scaleRGBA(frames[i].rgba, W, H, ow, oh);
      if (i % 4 === 3) await tick();
    }
    return { w: ow, h: oh, frames };
  }
  // Quita cuadros de sobra (sumando sus tiempos) para que el GIF no pese demasiado
  function decimate(frames, max) {
    if (frames.length <= max) return frames;
    const step = Math.ceil(frames.length / max), out = [];
    for (let i = 0; i < frames.length; i += step) {
      let cs = 0;
      for (let j = i; j < Math.min(i + step, frames.length); j++) cs += frames[j].cs;
      out.push({ rgba: frames[i].rgba, cs: Math.min(cs, 65535) });
    }
    return out;
  }

  // PNG (escritura): deflate con codigos fijos + LZ77 sencillo. Los margenes transparentes casi no pesan.
  let CRCT = null, LCODE = null, DCODE = null;
  function crc32(u8) {
    if (!CRCT) {
      CRCT = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRCT[n] = c; }
    }
    let c = -1;
    for (let i = 0; i < u8.length; i++) c = CRCT[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function adler32(u8) {
    let a = 1, b = 0;
    for (let i = 0; i < u8.length;) {
      const e = Math.min(u8.length, i + 5552);
      for (; i < e; i++) { a += u8[i]; b += a; }
      a %= 65521; b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
  }
  function deflateFixed(src) {
    if (!LCODE) {
      LCODE = new Uint8Array(259);
      for (let c = 0; c < 29; c++) {
        const hi = c === 28 ? 258 : LBASE[c] + (1 << LEXT[c]) - 1;
        for (let l = LBASE[c]; l <= hi; l++) LCODE[l] = c;
      }
      DCODE = new Uint8Array(32769);
      for (let c = 0; c < 30; c++) {
        const hi = DBASE[c] + (1 << DEXT[c]) - 1;
        for (let d = DBASE[c]; d <= hi && d <= 32768; d++) DCODE[d] = c;
      }
    }
    let out = new Uint8Array(Math.max(1024, (src.length >> 1) + 1024)), op = 0, bb = 0, bc = 0;
    const put = (v, n) => {
      bb |= v << bc; bc += n;
      while (bc >= 8) {
        if (op >= out.length) { const t = new Uint8Array(out.length * 2); t.set(out); out = t; }
        out[op++] = bb & 255; bb >>>= 8; bc -= 8;
      }
    };
    const rev = (v, n) => { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (v & 1); v >>= 1; } return r; };
    const lit = (s) => {
      if (s < 144) put(rev(0x30 + s, 8), 8);
      else if (s < 256) put(rev(0x190 + s - 144, 9), 9);
      else if (s < 280) put(rev(s - 256, 7), 7);
      else put(rev(0xc0 + s - 280, 8), 8);
    };
    put(1, 1); put(1, 2); // ultimo bloque, codigos fijos
    const n = src.length, head = new Int32Array(1 << 15).fill(-1), prevp = new Int32Array(Math.max(1, n));
    const hash = (i) => ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & 32767;
    const insert = (p) => { if (p + 2 < n) { const h = hash(p); prevp[p] = head[h]; head[h] = p; } };
    let i = 0;
    while (i < n) {
      let bestLen = 0, bestDist = 0;
      if (i + 2 < n) {
        let cand = head[hash(i)], chain = 0;
        const max = Math.min(258, n - i);
        while (cand >= 0 && i - cand <= 32768 && chain++ < 16) {
          let l = 0;
          while (l < max && src[cand + l] === src[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = i - cand; if (l === max) break; }
          cand = prevp[cand];
        }
      }
      if (bestLen >= 3) {
        const lc = LCODE[bestLen], dc = DCODE[bestDist];
        lit(257 + lc);
        if (LEXT[lc]) put(bestLen - LBASE[lc], LEXT[lc]);
        put(rev(dc, 5), 5);
        if (DEXT[dc]) put(bestDist - DBASE[dc], DEXT[dc]);
        for (let k = 0; k < bestLen; k++) insert(i + k);
        i += bestLen;
      } else { lit(src[i]); insert(i); i++; }
    }
    lit(256);
    if (bc > 0) put(0, 8 - bc);
    return out.subarray(0, op);
  }
  function pngEncode(w, h, rgba) {
    const stride = w * 4, raw = new Uint8Array(h * (stride + 1));
    for (let y = 0; y < h; y++) { // filtro "Sub": deja casi todo en ceros
      const o = y * (stride + 1), s = y * stride;
      raw[o] = 1;
      for (let i = 0; i < stride; i++) raw[o + 1 + i] = (rgba[s + i] - (i >= 4 ? rgba[s + i - 4] : 0)) & 255;
    }
    const def = deflateFixed(raw), ad = adler32(raw);
    const z = new Uint8Array(def.length + 6);
    z[0] = 0x78; z[1] = 0x01; z.set(def, 2);
    z[z.length - 4] = ad >>> 24; z[z.length - 3] = (ad >>> 16) & 255; z[z.length - 2] = (ad >>> 8) & 255; z[z.length - 1] = ad & 255;
    const chunk = (type, data) => {
      const c = new Uint8Array(12 + data.length), dv = new DataView(c.buffer);
      dv.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
      c.set(data, 8);
      dv.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
      return c;
    };
    const ihdr = new Uint8Array(13), idv = new DataView(ihdr.buffer);
    idv.setUint32(0, w); idv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
    let total = 0;
    for (const x of parts) total += x.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }

  // ---------- JPEG (lectura) ----------
  // Decodificador propio en JS puro (baseline y progresivo). Si la foto es grande solo se decodifica el valor medio de
  // cada bloque de 8x8 (la imagen a 1/8), que es justo lo que hace falta para un sticker y casi no gasta memoria.
  const JZZ = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
  let JIDCT = null;
  function jpgHuff(counts, vals) {
    const look = new Int16Array(256), maxcode = new Int32Array(18), mincode = new Int32Array(18), valptr = new Int32Array(18);
    let code = 0, k = 0;
    for (let l = 1; l <= 16; l++) {
      const cnt = counts[l - 1];
      valptr[l] = k; mincode[l] = code; maxcode[l] = cnt ? code + cnt - 1 : -1;
      for (let i = 0; i < cnt; i++) {
        if (l <= 8) { const base = code << (8 - l); for (let j = 0, m = 1 << (8 - l); j < m; j++) look[base + j] = (l << 8) | vals[k]; }
        code++; k++;
      }
      code <<= 1;
    }
    return { look, maxcode, mincode, valptr, vals };
  }
  // Orientacion EXIF (1 a 8) del APP1; 1 si no hay
  function jpgExifOrient(b, s, e) {
    try {
      if (!(b[s] === 69 && b[s + 1] === 120 && b[s + 2] === 105 && b[s + 3] === 102)) return 1; // "Exif"
      const t = s + 6, le = b[t] === 73;
      const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      let ifd = t + u32(t + 4);
      const cnt = u16(ifd);
      for (let i = 0; i < cnt && ifd + 14 + i * 12 <= e; i++) {
        const o = ifd + 2 + i * 12;
        if (u16(o) === 0x0112) { const v = u16(o + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
    } catch (_) {}
    return 1;
  }
  // Gira/voltea un RGBA segun la orientacion EXIF
  function orientRGBA(rgba, w, h, o) {
    if (!o || o === 1) return { rgba, w, h };
    const swap = o >= 5, nw = swap ? h : w, nh = swap ? w : h;
    const out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sx, sy;
        switch (o) {
          case 2: sx = w - 1 - x; sy = y; break;
          case 3: sx = w - 1 - x; sy = h - 1 - y; break;
          case 4: sx = x; sy = h - 1 - y; break;
          case 5: sx = y; sy = x; break;
          case 6: sx = y; sy = h - 1 - x; break;
          case 7: sx = w - 1 - y; sy = h - 1 - x; break;
          default: sx = w - 1 - y; sy = x; // 8
        }
        const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
        out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
      }
    }
    return { rgba: out, w: nw, h: nh };
  }

  // JPG -> { w, h, rgba, orient }. "target" = tamano final aproximado (decide si basta con 1/8 de la imagen)
  async function decodeJpeg(b, target) {
    const n = b.length;
    if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error("no es un JPG");
    const qts = [], dcT = [], acT = [];
    let frame = null, ri = 0, adobe = -1, orient = 1, dcOnly = false;
    let p = 2;
    const findMarker = (q) => { // siguiente marcador de verdad (no RSTn ni relleno) a partir de q
      while (q < n - 1) {
        if (b[q] === 0xff) { const m = b[q + 1]; if (m !== 0 && m !== 0xff && !(m >= 0xd0 && m <= 0xd7)) return q; }
        q++;
      }
      return n;
    };
    while (p < n - 3) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0 || m === 1 || (m >= 0xd0 && m <= 0xd8)) { p += 2; continue; }
      if (m === 0xd9) break;
      const len = (b[p + 2] << 8) | b[p + 3];
      const s = p + 4, e = Math.min(n, p + 2 + len);
      if (m === 0xe1 && orient === 1) orient = jpgExifOrient(b, s, e);
      else if (m === 0xee && b[s] === 65 && b[s + 1] === 100 && b[s + 2] === 111 && b[s + 3] === 98 && b[s + 4] === 101) adobe = b[s + 11];
      else if (m === 0xdb) {
        for (let q = s; q < e;) {
          const pq = b[q] >> 4, tq = b[q] & 15; q++;
          const t = new Int32Array(64);
          for (let i = 0; i < 64; i++) { t[JZZ[i]] = pq ? (b[q] << 8) | b[q + 1] : b[q]; q += pq ? 2 : 1; }
          qts[tq] = t;
        }
      } else if (m === 0xc4) {
        for (let q = s; q < e;) {
          const tc = b[q] >> 4, th = b[q] & 15; q++;
          const counts = b.subarray(q, q + 16); q += 16;
          let tot = 0; for (let i = 0; i < 16; i++) tot += counts[i];
          const vals = b.subarray(q, q + tot); q += tot;
          (tc ? acT : dcT)[th] = jpgHuff(counts, vals);
        }
      } else if (m === 0xdd) ri = (b[s] << 8) | b[s + 1];
      else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
        if (frame) throw new Error("JPG con varios cuadros no soportado");
        if (b[s] !== 8) throw new Error("JPG de " + b[s] + " bits no soportado");
        const H = (b[s + 1] << 8) | b[s + 2], W = (b[s + 3] << 8) | b[s + 4], nc = b[s + 5];
        if (!W || !H) throw new Error("JPG sin tamano");
        if (W * H > 120e6) throw new Error("JPG demasiado grande (" + W + "x" + H + ")");
        if (nc !== 1 && nc !== 3) throw new Error(nc === 4 ? "JPG CMYK no soportado" : "JPG con " + nc + " canales no soportado");
        const comps = [];
        let maxH = 1, maxV = 1;
        for (let i = 0; i < nc; i++) {
          const o = s + 6 + i * 3, hh = b[o + 1] >> 4, vv = b[o + 1] & 15;
          if (!hh || !vv || hh > 4 || vv > 4) throw new Error("JPG danado (muestreo)");
          comps.push({ id: b[o], h: hh, v: vv, tq: b[o + 2], pred: 0 });
          if (hh > maxH) maxH = hh; if (vv > maxV) maxV = vv;
        }
        const mpl = Math.ceil(W / (8 * maxH)), mpc = Math.ceil(H / (8 * maxV));
        dcOnly = Math.max(W, H) / 8 >= target || W * H > 8e6;
        for (const c of comps) {
          c.bw = mpl * c.h; c.bh = mpc * c.v;
          c.rbw = Math.ceil(Math.ceil((W * c.h) / maxH) / 8); c.rbh = Math.ceil(Math.ceil((H * c.v) / maxV) / 8);
          c.cf = dcOnly ? new Int16Array(c.bw * c.bh) : new Int16Array(c.bw * c.bh * 64);
        }
        frame = { W, H, comps, maxH, maxV, mpl, mpc, prog: m === 0xc2 };
      } else if ((m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)) throw new Error("JPG aritmetico o sin perdida no soportado");
      else if (m === 0xda) {
        if (!frame) throw new Error("JPG danado (sin cabecera)");
        const ns = b[s];
        const sc = [];
        for (let i = 0; i < ns; i++) {
          const c = frame.comps.find((x) => x.id === b[s + 1 + i * 2]);
          if (!c) throw new Error("JPG danado (componente)");
          c.dc = dcT[b[s + 2 + i * 2] >> 4]; c.ac = acT[b[s + 2 + i * 2] & 15];
          sc.push(c);
        }
        const Ss = b[s + 1 + ns * 2], Se = b[s + 2 + ns * 2], Ah = b[s + 3 + ns * 2] >> 4, Al = b[s + 3 + ns * 2] & 15;
        if (dcOnly && frame.prog && Ss > 0) { p = findMarker(e); continue; } // los AC no hacen falta
        p = jpgScan(b, n, e, frame, sc, ri, Ss, Se, Ah, Al, dcOnly);
        continue;
      }
      p = e;
    }
    if (!frame) throw new Error("JPG sin imagen");
    // ---- reconstruir ----
    const { W, H, comps, maxH, maxV } = frame;
    const planes = [];
    let outW, outH;
    if (dcOnly) {
      outW = Math.ceil(W / 8); outH = Math.ceil(H / 8);
      for (const c of comps) {
        const q = qts[c.tq]; if (!q) throw new Error("JPG danado (tabla)");
        const pl = new Uint8Array(c.bw * c.bh);
        for (let i = 0; i < pl.length; i++) { const v = Math.round((c.cf[i] * q[0]) / 8 + 128); pl[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
        planes.push({ pl, pw: c.bw, ph: c.bh });
      }
    } else {
      outW = W; outH = H;
      if (!JIDCT) {
        JIDCT = new Float32Array(64);
        for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) JIDCT[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
      }
      const M = JIDCT, blk = new Float32Array(64), tmp = new Float32Array(64);
      for (const c of comps) {
        const q = qts[c.tq]; if (!q) throw new Error("JPG danado (tabla)");
        const pw = c.bw * 8, ph = c.bh * 8, pl = new Uint8Array(pw * ph), cf = c.cf;
        for (let by = 0; by < c.bh; by++) {
          for (let bx = 0; bx < c.bw; bx++) {
            const o = (by * c.bw + bx) * 64;
            let nz = false;
            for (let i = 1; i < 64; i++) if (cf[o + i]) { nz = true; break; }
            const base = by * 8 * pw + bx * 8;
            if (!nz) {
              let v = Math.round((cf[o] * q[0]) / 8 + 128); v = v < 0 ? 0 : v > 255 ? 255 : v;
              for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pl[base + y * pw + x] = v;
              continue;
            }
            for (let i = 0; i < 64; i++) blk[i] = cf[o + i] * q[i];
            for (let v = 0; v < 8; v++) for (let x = 0; x < 8; x++) {
              let sum = 0; for (let u = 0; u < 8; u++) sum += M[x * 8 + u] * blk[v * 8 + u];
              tmp[v * 8 + x] = sum;
            }
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
              let sum = 0; for (let v = 0; v < 8; v++) sum += M[y * 8 + v] * tmp[v * 8 + x];
              const r = Math.round(sum + 128);
              pl[base + y * pw + x] = r < 0 ? 0 : r > 255 ? 255 : r;
            }
          }
          if ((by & 7) === 7) await tick();
        }
        planes.push({ pl, pw, ph });
      }
    }
    // ---- a RGBA (con el muestreo de color ajustado) ----
    const rgba = new Uint8Array(outW * outH * 4);
    const nc = comps.length;
    const xm = comps.map((c, i) => { const a = new Int32Array(outW); for (let x = 0; x < outW; x++) a[x] = Math.min(planes[i].pw - 1, Math.floor((x * c.h) / maxH)); return a; });
    const ycc = nc === 3 && (adobe >= 0 ? adobe !== 0 : !(comps[0].id === 82 && comps[1].id === 71 && comps[2].id === 66));
    const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    for (let y = 0; y < outH; y++) {
      const rows = comps.map((c, i) => Math.min(planes[i].ph - 1, Math.floor((y * c.v) / maxV)) * planes[i].pw);
      for (let x = 0; x < outW; x++) {
        const o = (y * outW + x) * 4;
        if (nc === 1) { const v = planes[0].pl[rows[0] + xm[0][x]]; rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; }
        else {
          const Y = planes[0].pl[rows[0] + xm[0][x]], A = planes[1].pl[rows[1] + xm[1][x]], B = planes[2].pl[rows[2] + xm[2][x]];
          if (ycc) { rgba[o] = cl(Y + 1.402 * (B - 128)); rgba[o + 1] = cl(Y - 0.344136 * (A - 128) - 0.714136 * (B - 128)); rgba[o + 2] = cl(Y + 1.772 * (A - 128)); }
          else { rgba[o] = Y; rgba[o + 1] = A; rgba[o + 2] = B; }
        }
        rgba[o + 3] = 255;
      }
      if ((y & 63) === 63) await tick();
    }
    return { w: outW, h: outH, rgba, orient };
  }

  // Un barrido (scan) del JPG: devuelve la posicion del siguiente marcador
  function jpgScan(b, n, start, frame, sc, ri, Ss, Se, Ah, Al, dcOnly) {
    const prog = frame.prog;
    let pos = start, bb = 0, bc = 0, eobrun = 0;
    const fill = () => {
      while (bc <= 24) {
        let byte = 0;
        if (pos < n) {
          byte = b[pos];
          if (byte === 0xff) {
            const nx = b[pos + 1];
            if (nx === 0) pos += 2;
            else if (nx === 0xff) { pos++; continue; }
            else byte = 0; // marcador: se rellena con ceros sin avanzar
          } else pos++;
        }
        bb = (bb << 8) | byte; bc += 8;
      }
    };
    const bits = (k) => { if (bc < k) fill(); bc -= k; return (bb >>> bc) & ((1 << k) - 1); };
    const ext = (v, s) => (v < (1 << (s - 1)) ? v - (1 << s) + 1 : v);
    const sym = (t) => {
      if (!t) throw new Error("JPG danado (tabla Huffman)");
      if (bc < 16) fill();
      const e = t.look[(bb >>> (bc - 8)) & 255];
      if (e) { bc -= e >> 8; return e & 255; }
      for (let l = 9; l <= 16; l++) {
        const code = (bb >>> (bc - l)) & ((1 << l) - 1);
        if (code <= t.maxcode[l]) { bc -= l; return t.vals[t.valptr[l] + code - t.mincode[l]]; }
      }
      bc -= 16; return 0;
    };
    const p1 = 1 << Al, m1 = -1 << Al;
    const refineNz = (cf, idx) => { if (bits(1) && (cf[idx] & p1) === 0) cf[idx] += cf[idx] >= 0 ? p1 : m1; };
    function block(c, blk) {
      const cf = c.cf;
      if (!prog) {
        const t = sym(c.dc);
        c.pred += t ? ext(bits(t), t) : 0;
        if (dcOnly) {
          cf[blk] = c.pred;
          for (let k = 1; k < 64; k++) { const rs = sym(c.ac), s = rs & 15; if (s === 0) { if ((rs >> 4) < 15) break; k += 15; } else { k += rs >> 4; bits(s); } }
          return;
        }
        const o = blk * 64;
        cf[o] = c.pred;
        for (let k = 1; k < 64; k++) {
          const rs = sym(c.ac), s = rs & 15;
          if (s === 0) { if ((rs >> 4) < 15) break; k += 15; }
          else { k += rs >> 4; if (k > 63) break; cf[o + JZZ[k]] = ext(bits(s), s); }
        }
        return;
      }
      if (Ss === 0) { // DC
        const o = dcOnly ? blk : blk * 64;
        if (Ah === 0) { const t = sym(c.dc); c.pred += t ? ext(bits(t), t) : 0; cf[o] = c.pred << Al; }
        else if (bits(1)) cf[o] |= p1;
        return;
      }
      const o = blk * 64;
      if (Ah === 0) { // AC, primera pasada
        if (eobrun > 0) { eobrun--; return; }
        for (let k = Ss; k <= Se; k++) {
          const rs = sym(c.ac), s = rs & 15, r = rs >> 4;
          if (s) { k += r; if (k > 63) break; cf[o + JZZ[k]] = ext(bits(s), s) * (1 << Al); }
          else if (r === 15) k += 15;
          else { eobrun = (1 << r) - 1 + (r ? bits(r) : 0); break; }
        }
        return;
      }
      // AC, pasadas de refinamiento
      let k = Ss;
      if (eobrun === 0) {
        for (; k <= Se; k++) {
          const rs = sym(c.ac);
          let s = rs & 15, r = rs >> 4;
          if (s) s = bits(1) ? p1 : m1;
          else if (r !== 15) { eobrun = (1 << r) + (r ? bits(r) : 0); break; }
          do {
            const idx = o + JZZ[k];
            if (cf[idx] !== 0) refineNz(cf, idx);
            else if (--r < 0) break;
            k++;
          } while (k <= Se);
          if (s && k <= 63) cf[o + JZZ[k]] = s;
        }
      }
      if (eobrun > 0) {
        for (; k <= Se; k++) { const idx = o + JZZ[k]; if (cf[idx] !== 0) refineNz(cf, idx); }
        eobrun--;
      }
    }
    // unidades del barrido: bloques sueltos (1 componente) o MCU completos (varios)
    let total, perLine;
    if (sc.length === 1) { perLine = sc[0].rbw; total = sc[0].rbw * sc[0].rbh; }
    else { perLine = frame.mpl; total = frame.mpl * frame.mpc; }
    let cnt = 0;
    for (let u = 0; u < total; u++) {
      if (ri && cnt === ri) { // reinicio: alinear, saltar RSTn y volver a empezar las predicciones
        bb = 0; bc = 0; eobrun = 0; cnt = 0;
        let q = pos;
        while (q < n - 1 && !(b[q] === 0xff && b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7)) { if (b[q] === 0xff && b[q + 1] !== 0 && b[q + 1] !== 0xff) break; q++; }
        if (b[q] === 0xff && b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7) q += 2;
        pos = q;
        for (const c of sc) c.pred = 0;
      }
      if (u === 0) for (const c of sc) c.pred = 0;
      if (sc.length === 1) {
        const c = sc[0], row = (u / perLine) | 0, col = u % perLine;
        block(c, row * c.bw + col);
      } else {
        const mr = (u / perLine) | 0, mc = u % perLine;
        for (const c of sc) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, (mr * c.v + v) * c.bw + mc * c.h + h);
      }
      cnt++;
    }
    // siguiente marcador
    let q = pos;
    while (q < n - 1) {
      if (b[q] === 0xff) { const m = b[q + 1]; if (m !== 0 && m !== 0xff && !(m >= 0xd0 && m <= 0xd7)) return q; }
      q++;
    }
    return n;
  }

  // ---------- Biblioteca de importados ----------
  // Cada importado se guarda ya achicado (PNG si es estatico, GIF si es animado) y se manda como archivo,
  // igual que los APNG convertidos. Se guarda en un archivo propio (para no hinchar los ajustes del plugin);
  // si esta version no permite archivos, se usa el almacenamiento del plugin con un limite mas bajo.
  const LIB_MAX_ITEM = 2 * 1024 * 1024; // lo que ocupa un importado ya procesado
  const LIB_MAX_SRC = 12 * 1024 * 1024; // el archivo original que se elige
  const lib = { store: null, ready: false, mode: "", err: "" };
  const importState = { last: "", ok: 0, fail: 0, sent: 0, pickers: "" };
  let libInit = null;
  const libItems = () => {
    try { const it = lib.store && lib.store.items; return Array.isArray(it) ? it : []; } catch (_) { return []; }
  };
  const libBytes = () => libItems().reduce((n, it) => n + Math.floor(((it.b64 || "").length * 3) / 4), 0);
  const libCap = () => (lib.mode === "archivo" ? 30 : 4) * 1024 * 1024;
  function refreshCatalog() {
    catAt = 0;
    for (const f of [...catListeners]) safe("catalogo listener", f);
  }
  function ensureLib() {
    if (libInit) return libInit;
    libInit = (async () => {
      const vs = vendetta.storage;
      if (vs && typeof vs.createStorage === "function" && typeof vs.createFileBackend === "function") {
        try {
          const s = await vs.createStorage(vs.createFileBackend("StickerSenderLibrary.json"));
          if (s && typeof s === "object") {
            if (!Array.isArray(s.items)) s.items = [];
            lib.store = s; lib.mode = "archivo";
          }
        } catch (e) { lib.err = String((e && e.message) || e).slice(0, 80); }
      }
      if (!lib.store) {
        const ps = vendetta.plugin.storage;
        if (!ps.libFallback || !Array.isArray(ps.libFallback.items)) ps.libFallback = { items: [] };
        lib.store = ps.libFallback; lib.mode = "respaldo";
      } else {
        safe("migrar importados", () => { // por si antes se guardaron en el respaldo
          const fb = vendetta.plugin.storage.libFallback;
          if (fb && Array.isArray(fb.items) && fb.items.length) {
            lib.store.items = [...libItems().map((x) => ({ ...x })), ...fb.items.map((x) => ({ ...x }))];
            vendetta.plugin.storage.libFallback = { items: [] };
          }
        });
      }
      lib.ready = true;
      refreshCatalog();
    })().catch((e) => { lib.err = String((e && e.message) || e).slice(0, 80); libInit = null; });
    return libInit;
  }
  async function addToLib(rec) {
    await ensureLib();
    if (!lib.store) throw new Error("no se pudo abrir la biblioteca" + (lib.err ? " (" + lib.err + ")" : ""));
    const items = libItems();
    if (items.length >= 200) throw new Error("ya hay 200 importados; borra alguno");
    if (libBytes() + Math.floor((rec.b64.length * 3) / 4) > libCap())
      throw new Error("la biblioteca esta llena (" + Math.round(libCap() / 1048576) + " MB); borra alguno");
    lib.store.items = [...items.map((x) => ({ ...x })), rec];
  }
  async function removeFromLib(id) {
    await ensureLib();
    if (!lib.store) return;
    lib.store.items = libItems().filter((x) => x.id !== id).map((x) => ({ ...x }));
    uriCache.delete(id);
    refreshCatalog();
  }
  async function renameInLib(id, name) {
    await ensureLib();
    if (!lib.store) return;
    lib.store.items = libItems().map((x) => ({ ...x, name: x.id === id ? name : x.name }));
    refreshCatalog();
  }
  const uriCache = new Map();
  function localUri(it) {
    let u = uriCache.get(it.id);
    if (!u) {
      u = "data:" + (it.mime || (it.ext === "gif" ? "image/gif" : "image/png")) + ";base64," + it.b64;
      uriCache.set(it.id, u);
      if (uriCache.size > 80) uriCache.delete(uriCache.keys().next().value);
    }
    return u;
  }
  const cleanName = (n) => {
    let s = String(n || "").split("?")[0].split(/[\\/]/).pop();
    try { s = decodeURIComponent(s); } catch (_) {}
    s = s.replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/[^A-Za-z0-9_ À-ɏ-]/g, "").trim().slice(0, 32);
    return s || "importado";
  };
  const fileSafe = (n) => String(n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "sticker";

  // Imagen original -> registro de la biblioteca (achicado y recodificado)
  async function buildLibItem(bytes, fname, kind) {
    const type = sniffImage(bytes);
    if (!type) throw new Error("formato no reconocido (usa PNG, GIF, APNG, WebP o JPG)");
    const target = kind === "emoji" ? size("emojiSize") : size("stickerSize");
    const id = "L" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const base = { id, name: cleanName(fname), kind, at: Date.now() };
    let anim = null, why = "";
    if (type === "png") {
      try {
        if (quickInfo(bytes, "png").animated) {
          try { anim = await apngFrames(parseApng(bytes), target); } catch (_) { anim = null; } // APNG de 1 cuadro: sigue como PNG normal
        }
        if (!anim) { const p = parsePngStatic(bytes); anim = await scaleFrames([{ rgba: p.rgba, cs: 10 }], p.w, p.h, target); }
      } catch (e) { why = String((e && e.message) || e); anim = null; }
    } else if (type === "gif") {
      try { anim = await decodeGif(bytes, target, 90); } catch (e) { why = String((e && e.message) || e); anim = null; }
    } else if (type === "jpg") { // JPG: se decodifica, se achica a tamano sticker y se guarda como PNG (igual que un PNG)
      try {
        const j = await decodeJpeg(bytes, target);
        anim = await scaleFrames([{ rgba: j.rgba, cs: 10 }], j.w, j.h, target);
        if (j.orient > 1) { // fotos del celular: respetar la rotacion guardada en el archivo
          const o = orientRGBA(anim.frames[0].rgba, anim.w, anim.h, j.orient);
          anim = { w: o.w, h: o.h, frames: [{ rgba: o.rgba, cs: 10 }] };
        }
      } catch (e) { why = String((e && e.message) || e); anim = null; }
    }
    if (anim) {
      anim.frames = decimate(anim.frames, 90);
      const animated = anim.frames.length > 1;
      const data = animated ? await gifEncode(anim) : pngEncode(anim.w, anim.h, anim.frames[0].rgba);
      if (data.length > LIB_MAX_ITEM) throw new Error("quedo muy pesado (" + Math.round(data.length / 1024) + " KB); usa una mas corta o mas chica");
      return { ...base, ext: animated ? "gif" : "png", mime: animated ? "image/gif" : "image/png", raw: false, animated, w: anim.w, h: anim.h, bytes: data.length, b64: b64encode(data) };
    }
    // WebP (o un JPG/PNG/GIF raro que no se pudo leer): no se puede achicar, se guarda tal cual SOLO si es chico.
    // Una imagen grande guardada asi hacia que la app se cerrara al dibujar la vista previa.
    {
      const q0 = quickInfo(bytes, type), px = q0.w * q0.h;
      if (type === "jpg" || type === "png" || type === "gif" ? !(bytes.length <= 300 * 1024 && px > 0 && px <= 360000) : px > 2e6)
        throw new Error("no se pudo achicar " + (type === "webp" ? "(WebP muy grande en pixeles)" : "(" + (why || "formato raro") + ")") + "; pasala a PNG o GIF mas chico");
    }
    if (bytes.length > LIB_MAX_ITEM) throw new Error("pesa " + Math.round(bytes.length / 1024) + " KB y no se puede achicar" + (why ? " (" + why + ")" : "") + "; usa PNG o GIF");
    const qi = quickInfo(bytes, type);
    return {
      ...base, ext: type, mime: { jpg: "image/jpeg", webp: "image/webp", png: "image/png", gif: "image/gif" }[type], raw: true,
      animated: type === "gif" || !!qi.animated, w: qi.w, h: qi.h, bytes: bytes.length, b64: b64encode(bytes),
    };
  }

  // Importado -> bytes listos para subir (con el margen transparente que usan los demas GIF)
  async function renderLocal(it) {
    const data = b64decode(it.b64);
    if (it.raw) return { bytes: data, ext: it.ext, mime: it.mime };
    let anim;
    if (it.ext === "gif") anim = await decodeGif(data, 4096, 120);
    else { const p = parsePngStatic(data); anim = { w: p.w, h: p.h, frames: [{ rgba: p.rgba, cs: 10 }] }; }
    const k = gifPad();
    if (k > 1) { // el lienzo mide lo mismo para todos (tamano de sticker x margen): asi cada uno conserva su proporcion
      const W = Math.max(anim.w, Math.round(size("stickerSize") * k));
      padFrames(anim, W / anim.w);
    }
    return anim.frames.length > 1
      ? { bytes: await gifEncode(anim), ext: "gif", mime: "image/gif" }
      : { bytes: pngEncode(anim.w, anim.h, anim.frames[0].rgba), ext: "png", mime: "image/png" };
  }
  const localCache = new Map(); // id|tamano|margen -> {bytes, ext, mime} (ultimos 8, 6 MB)
  async function sendLocalItem(channelId, item) {
    if (!channelId) channelId = S.SelectedChannelStore?.getChannelId?.();
    if (!channelId) { toast("No hay canal abierto"); return; }
    const it = item.lib, bk = channelId + ":" + item.key;
    if (gifBusy.has(bk)) return; // toque repetido mientras se prepara
    gifBusy.add(bk);
    try {
      const ck = it.id + "|" + size("stickerSize") + "|" + gifPad();
      let r = localCache.get(ck);
      if (r) { localCache.delete(ck); localCache.set(ck, r); }
      else {
        if (!it.raw && it.animated) toast("Preparando GIF...");
        r = await renderLocal(it);
        if (r.bytes.length > 9 * 1024 * 1024) throw new Error("archivo demasiado grande");
        localCache.set(ck, r);
        let tot = 0;
        for (const v of localCache.values()) tot += v.bytes.length;
        while (localCache.size > 1 && (localCache.size > 8 || tot > 6 * 1024 * 1024)) {
          const k = localCache.keys().next().value;
          tot -= localCache.get(k).bytes.length;
          localCache.delete(k);
        }
      }
      await uploadGif(channelId, r.bytes, fileSafe(it.name) + "." + r.ext, "", r.mime);
      importState.sent++;
    } catch (e) {
      importState.fail++;
      importState.last = "envio fallo: " + String((e && e.message) || e);
      toast("No se pudo mandar: " + String((e && e.message) || e).slice(0, 90));
    } finally {
      gifBusy.delete(bk);
    }
  }

  // ---------- Elegir el archivo ----------
  // Discord no trae un selector propio documentado: se usa el primero que exista entre los que suelen venir incluidos.
  // IMPORTANTE (arreglo del cierre de la app al elegir "Galeria"):
  //  1) Antes se buscaba con findByProps, y cuando el nombre no existe eso obliga a Discord a inicializar TODOS sus
  //     modulos de golpe (puede congelar o cerrar la app). Ahora solo se miran los modulos que YA estan cargados.
  //     La busqueda a fondo (la de antes) queda como paso opcional, y si cierra la app se desactiva sola.
  //  2) Antes de entrar al codigo nativo se guarda un marcador y se espera un instante a que se escriba en disco;
  //     asi, si la app se cierra, al volver se sabe cual selector fue y se descarta (antes el marcador podia perderse).
  //  3) Se prueban primero los selectores mas simples y estandar; el de Expo (el mas delicado) va al final.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PICK_SPECS = [
    { label: "react-native-image-picker", fn: "launchImageLibrary", props: ["launchImageLibrary"] },
    { label: "document-picker", fn: "pickSingle", props: ["pickSingle"] },
    { label: "document-picker", fn: "pick", props: ["pick", "isCancel"] },
    { label: "expo-document-picker", fn: "getDocumentAsync", props: ["getDocumentAsync"] },
    { label: "expo-image-picker", fn: "launchImageLibraryAsync", props: ["launchImageLibraryAsync"] },
  ];
  // Si la app se cerro justo durante un paso riesgoso, ese paso se descarta (hasta que lo restablezcas en Ajustes)
  function settlePickCrash() {
    safe("descartar", () => {
      const st = vendetta.plugin.storage;
      const pend = st.pickPending;
      if (pend) { setList("pickBad", [...new Set([...getList("pickBad"), pend])]); setList("pickPending", ""); }
      if (st.scanPending) { setList("scanBad", true); setList("scanPending", ""); }
    });
  }
  const deepScanBad = () => { try { return !!vendetta.plugin.storage.scanBad; } catch (_) { return false; } };
  // Solo modulos ya inicializados (no fuerza ninguno): devuelve Map spec -> modulo
  function scanLoadedPickers() {
    const found = new Map();
    const mods = vendetta.metro.modules ?? globalThis.modules ?? {};
    for (const id in mods) {
      try {
        const m = mods[id];
        if (!m || m.isInitialized === false) continue;
        const exp = m.publicModule?.exports;
        if (!exp) continue;
        for (const holder of [exp, exp.default]) {
          if (!holder || (typeof holder !== "object" && typeof holder !== "function")) continue;
          for (const sp of PICK_SPECS) {
            if (found.has(sp)) continue;
            let ok = true;
            for (const pr of sp.props) { if (typeof holder[pr] !== "function") { ok = false; break; } }
            if (ok) found.set(sp, holder);
          }
        }
      } catch (_) {}
      if (found.size === PICK_SPECS.length) break;
    }
    return found;
  }
  // deep = true: ademas busca con findByProps (inicializa modulos; solo se usa con el marcador de seguridad puesto)
  function collectPickers(deep) {
    const out = [], seen = new Set();
    const add = (sp, mod) => {
      const f = mod && (typeof mod === "object" || typeof mod === "function") ? safe("fn", () => mod[sp.fn]) : null;
      if (typeof f === "function" && !seen.has(f)) { seen.add(f); out.push({ label: sp.label, mod, fn: sp.fn }); }
    };
    const loaded = safe("escaneo", scanLoadedPickers) || new Map();
    for (const sp of PICK_SPECS) {
      let mod = loaded.get(sp);
      if (!mod && deep) mod = safe("busqueda " + sp.label, () => findByProps(...sp.props));
      add(sp, mod);
    }
    // Los modulos nativos desconocidos ya NO se llaman a ciegas (un argumento equivocado cierra la app).
    const bad = getList("pickBad");
    return out.filter((c) => !bad.includes(c.label + "." + c.fn));
  }
  const findPickers = () => { settlePickCrash(); return collectPickers(false); };
  // Busqueda a fondo (opcional): con marcador guardado antes; si la app se cierra aqui, no se vuelve a ofrecer
  async function deepFindPickers() {
    settlePickCrash(); // primero se resuelve lo de la vez anterior; despues se pone el marcador nuevo
    if (deepScanBad()) return [];
    toast("Buscando selector... si la app se cierra, esta busqueda se desactiva sola");
    setList("scanPending", "1");
    await sleep(400); // tiempo para que el marcador llegue al disco
    let res = [];
    try { res = collectPickers(true); } finally { setList("scanPending", ""); }
    return res;
  }
  function pickerScan() { // nombres con pinta de selector de galeria, para el reporte
    const names = new Set();
    const re = /launchImageLibrary|openPicker|pickSingle|getDocumentAsync|openImagePicker|openMediaPicker|showImagePicker|ImagePicker|DocumentPicker|MediaPicker/;
    const mods = vendetta.metro.modules ?? globalThis.modules ?? {};
    for (const id in mods) {
      try {
        const m = mods[id];
        if (!m || m.isInitialized === false) continue;
        const exp = m.publicModule?.exports;
        if (!exp) continue;
        for (const holder of [exp, exp.default]) {
          if (!holder || (typeof holder !== "object" && typeof holder !== "function")) continue;
          for (const k of Object.keys(holder)) if (re.test(k)) names.add(k);
        }
      } catch (_) {}
      if (names.size >= 30) break;
    }
    const nm = safe("nm", () => Object.keys(vendetta.metro.common.ReactNative.NativeModules).filter((k) => /pick|gallery|document|media|image|file/i.test(k)));
    return { names: [...names], native: nm || [] };
  }
  const isCancelErr = (e) => /cancel|dismiss|abort/i.test(String((e && (e.code || e.message)) || e));
  async function callPicker(c) {
    const m = c.mod;
    if (c.fn === "launchImageLibraryAsync") return m.launchImageLibraryAsync({ allowsEditing: false, quality: 1, allowsMultipleSelection: false });
    if (c.fn === "launchImageLibrary") {
      return new Promise((resolve, reject) => {
        try {
          const p = m.launchImageLibrary({ mediaType: "photo", selectionLimit: 1, includeBase64: false, quality: 1 }, resolve);
          if (p && typeof p.then === "function") p.then(resolve, reject);
        } catch (e) { reject(e); }
      });
    }
    if (c.fn === "getDocumentAsync") return m.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true, multiple: false });
    if (c.fn === "pickSingle") return m.pickSingle({ type: ["image/*"], copyTo: "cachesDirectory" });
    if (c.fn === "pick") return m.pick({ type: ["image/*"], copyTo: "cachesDirectory", allowMultiSelection: false });
    if (c.fn === "openPicker") return m.openPicker({ mediaType: "photo", multiple: false });
    throw new Error("selector desconocido");
  }
  // Resultado de cualquiera de los selectores -> { uri, name, mime } | { cancelled } | null
  function pickedFile(res) {
    if (!res) return null;
    if (res.canceled === true || res.didCancel === true || res.cancelled === true || res.type === "cancel") return { cancelled: true };
    const a = (res.assets && res.assets[0]) || (Array.isArray(res) ? res[0] : null) || res;
    const uri = a && (a.fileCopyUri || a.uri || a.path);
    if (!uri) return null;
    const u = String(uri);
    return { uri: /^[a-z]+:\/\//i.test(u) ? u : "file://" + u, name: a.fileName || a.name || u.split("/").pop(), mime: a.mimeType || a.type };
  }
  async function pickFromGallery(deep) {
    const cands = deep ? await deepFindPickers() : findPickers();
    importState.pickers = cands.map((c) => c.label + "." + c.fn).join(", ") || "ninguno";
    if (!cands.length) { const e = new Error("esta version de Discord no expone un selector de galeria"); e.noPicker = true; throw e; }
    let lastErr = null;
    for (const c of cands) {
      try {
        setList("pickPending", c.label + "." + c.fn); // si la app se cierra aqui, al volver se descarta este selector
        await sleep(350); // da tiempo a que el marcador se escriba antes de entrar al codigo nativo
        let res;
        try { res = await callPicker(c); } finally { setList("pickPending", ""); }
        const f = pickedFile(res);
        if (f && f.cancelled) return null;
        if (f) return f;
        lastErr = new Error("el selector no devolvio ningun archivo");
      } catch (e) {
        if (isCancelErr(e)) return null;
        lastErr = e;
      }
    }
    throw lastErr || new Error("no se pudo abrir la galeria");
  }
  // Archivo local (file:// o content://) -> bytes. RN solo deja leerlos como "blob"; de ahi se pasa a base64.
  function readLocalBytes(uri) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", uri);
      x.responseType = "blob";
      x.onload = () => {
        const blob = x.response;
        if (!blob) return reject(new Error("archivo vacio"));
        if (blob.size > LIB_MAX_SRC) return reject(new Error("el archivo pesa mas de " + Math.round(LIB_MAX_SRC / 1048576) + " MB"));
        const fr = new FileReader();
        fr.onload = () => { const s = String(fr.result || ""); resolve(b64decode(s.slice(s.indexOf(",") + 1))); };
        fr.onerror = () => reject(new Error("no se pudo leer el archivo"));
        fr.readAsDataURL(blob);
      };
      x.onerror = () => reject(new Error("no se pudo abrir el archivo"));
      x.send();
    });
  }

  // ---------- Dialogos ----------
  // Pregunta con 1 o 2 opciones + Cancelar (Alert nativo; tocar fuera cancela). Devuelve el indice o -1.
  function choose(title, message, labels) {
    return new Promise((resolve) => {
      const A = vendetta.metro.common.ReactNative?.Alert;
      if (!A) return resolve(-1);
      const btns = labels.map((text, i) => ({ text, onPress: () => resolve(i) }));
      btns.push({ text: "Cancelar", style: "cancel", onPress: () => resolve(-1) });
      A.alert(title, message, btns, { cancelable: true, onDismiss: () => resolve(-1) });
    });
  }
  // Texto con valor inicial: devuelve el texto, o null si se cancela.
  // CUADRO DE TEXTO PROPIO (dentro del ActionSheet de Discord). Ya NO usa vendetta.ui.alerts.showInputAlert:
  // en Discord 348 ese componente busca "FluxContainer(Alert)", que ya no existe, y tumba la app al dibujarse
  // (el try/catch no lo atrapaba porque el error ocurre despues, dentro del render de React).
  const INPUT_KEY = "StickerSenderInput";
  function askText(title, initial, placeholder) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      const AS = S.ActionSheet;
      if (!AS || typeof AS.openLazy !== "function") return resolve(initial); // sin hoja: se usa el valor propuesto
      try {
        const { React, ReactNative: RN } = vendetta.metro.common;
        const h = React.createElement;
        const okComp = (c) => c && (typeof c === "function" || (typeof c === "object" && c.$$typeof));
        const NS = okComp(S.NativeSheet) ? S.NativeSheet : safe("hoja input", () => findByProps("ActionSheet")?.ActionSheet);
        const closeInput = () => safe("cerrar input", () => AS.hideActionSheet?.(INPUT_KEY));
        const Input = () => {
          const [text, setText] = React.useState(String(initial == null ? "" : initial));
          // si la hoja se cierra de cualquier forma (tocar fuera, deslizar, atras) sin aceptar, cuenta como cancelar
          React.useEffect(() => () => finish(null), []);
          const ok = () => { finish(String(text).trim()); closeInput(); };
          const cancel = () => { finish(null); closeInput(); };
          const btn = (label, color, onPress) =>
            h(RN.Pressable, { onPress, style: { flex: 1, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: color } },
              h(RN.Text, { style: { color: "#fff", fontWeight: "bold", fontSize: 15 } }, label));
          const body = h(RN.View, { style: { padding: 16, paddingBottom: 24 } },
            h(RN.Text, { style: { color: "#fff", fontSize: 18, fontWeight: "bold", marginBottom: 12 } }, String(title || "")),
            h(RN.TextInput, {
              value: text, onChangeText: setText, placeholder: placeholder || "", placeholderTextColor: "#80848e",
              autoFocus: true, autoCorrect: false, autoCapitalize: "none", returnKeyType: "done", onSubmitEditing: ok,
              style: { backgroundColor: "#2b2d31", color: "#fff", borderRadius: 8, paddingHorizontal: 12, height: 44, marginBottom: 12 },
            }),
            h(RN.View, { style: { flexDirection: "row", gap: 8 } }, btn("Cancelar", "#4e5058", cancel), btn("Aceptar", "#5865f2", ok)));
          return NS ? h(NS, null, body) : h(RN.View, { style: { backgroundColor: "#1e1f22", borderTopLeftRadius: 16, borderTopRightRadius: 16 } }, body);
        };
        const comp = () => {
          const B = getBoundary(React, RN);
          return B ? h(B, null, h(Input)) : h(Input);
        };
        AS.openLazy(Promise.resolve({ default: comp }), INPUT_KEY, {});
      } catch (e) {
        console.error(TAG, "cuadro de texto fallo:", e);
        finish(initial);
      }
    });
  }
  const hasTextInput = () => typeof S.ActionSheet?.openLazy === "function";

  // ---------- Flujo de importar ----------
  let importBusy = 0;
  async function startImport(source) {
    if (importBusy && Date.now() - importBusy < 90000) { toast("Ya hay una importacion en curso"); return; }
    importBusy = Date.now();
    try {
      let src = source;
      if (!src) {
        const c = await choose("Importar imagen", "PNG, GIF, APNG, WebP o JPG, como sticker o emoji", ["Galeria", "Link"]);
        if (c < 0) return;
        src = c === 0 ? "gallery" : "link";
      }
      let bytes, fname;
      if (src === "gallery") {
        let f, deep = false;
        for (;;) {
          try { f = await pickFromGallery(deep); break; }
          catch (e) {
            if (!e.noPicker) throw e;
            const canDeep = !deep && !deepScanBad();
            const c = await choose("Sin selector de galeria",
              canDeep
                ? "No encontre un selector de galeria ya cargado en Discord. Puedo buscar a fondo (si la app se cierra, esta busqueda se desactiva sola) o importar desde un link."
                : "Esta version de Discord no permite abrir la galeria desde el plugin. ¿Importar desde un link?",
              canDeep ? ["Buscar a fondo", "Desde un link"] : ["Desde un link"]);
            if (c < 0) return;
            if (canDeep && c === 0) { deep = true; continue; }
            src = "link";
            break;
          }
        }
        if (src === "gallery") {
          if (!f) return; // cancelado
          toast("Leyendo archivo...");
          bytes = await readLocalBytes(f.uri);
          fname = f.name;
        }
      }
      if (src === "link") {
        let clip = "";
        try { clip = String((await vendetta.metro.common.clipboard.getString()) || "").trim(); } catch (_) {}
        const guess = /^https?:\/\/\S+$/i.test(clip) ? clip : "";
        let url = hasTextInput() ? await askText("Link de la imagen", guess, "https://...") : guess;
        if (url == null) return;
        url = String(url).trim();
        if (!/^https?:\/\/\S+$/i.test(url)) { toast(hasTextInput() ? "Ese no es un link valido" : "Copia primero el link de la imagen y vuelve a tocar Importar"); return; }
        toast("Descargando...");
        bytes = await xhrGetBytes(url);
        fname = url;
      }
      if (bytes.length > LIB_MAX_SRC) throw new Error("el archivo pesa mas de " + Math.round(LIB_MAX_SRC / 1048576) + " MB");
      const type = sniffImage(bytes);
      if (!type) throw new Error("no es una imagen PNG, GIF, WebP o JPG");
      const qi = quickInfo(bytes, type);
      const desc = type.toUpperCase() + (qi.w ? " " + qi.w + "x" + qi.h : "") + (qi.animated && type !== "gif" ? " animado" : "") + " | " + Math.max(1, Math.round(bytes.length / 1024)) + " KB" +
        (type === "webp" ? "\nNo se puede achicar: se manda con su tamano original" : "");
      const k = await choose("Importar como...", desc, ["Sticker", "Emoji"]);
      if (k < 0) return;
      const kind = k === 0 ? "sticker" : "emoji";
      const nm = await askText("Nombre", cleanName(fname), "nombre");
      if (nm == null) return;
      toast("Procesando...");
      const rec = await buildLibItem(bytes, nm || fname, kind);
      await addToLib(rec);
      importState.ok++;
      importState.last = "ok " + kind + " " + rec.ext + " " + rec.w + "x" + rec.h + " " + rec.bytes + " bytes";
      toast("Importado como " + kind + (rec.animated ? " animado" : "") + ": " + rec.name);
      refreshCatalog();
    } catch (e) {
      importState.fail++;
      importState.last = "fallo: " + String((e && e.message) || e);
      toast("No se pudo importar: " + String((e && e.message) || e).slice(0, 100));
    } finally {
      importBusy = 0;
    }
  }

  // ---------- Catalogo propio (stickers y emojis de todos tus servidores) ----------
  function buildCatalogRaw() {
    const guilds = safe("guilds", () => S.GuildStore?.getGuilds?.()) ?? {};
    const gname = (gid) => guilds[gid]?.name ?? "Servidor";
    const stickers = [], emojis = [], guildStickers = [];

    safe("stickers", () => {
      const map = S.StickersStore?.getAllGuildStickers?.();
      if (map) {
        const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
        for (const [gid, arr] of entries)
          for (const s of arr ?? []) {
            if (fmt(s) === 3) continue; // Lottie no se puede mandar como imagen
            const it = { kind: "sticker", key: "sticker:" + s.id, id: s.id, name: s.name ?? "", n: norm(s.name), group: gname(gid), raw: s, tag: fmt(s) === 4 ? "GIF" : fmt(s) === 2 ? "APNG" : "" };
            stickers.push(it);
            guildStickers.push(it);
          }
      }
      for (const pack of S.StickersStore?.getPremiumPacks?.() ?? [])
        for (const s of pack.stickers ?? []) {
          if (fmt(s) === 3) continue;
          stickers.push({ kind: "sticker", key: "sticker:" + s.id, id: s.id, name: s.name ?? "", n: norm(s.name), group: pack.name ?? "Discord", raw: s, tag: fmt(s) === 4 ? "GIF" : fmt(s) === 2 ? "APNG" : "" });
        }
    });

    safe("emojis", () => {
      for (const gid of Object.keys(guilds))
        for (const e of S.EmojiStore?.getGuildEmoji?.(gid) ?? [])
          emojis.push({ kind: "emoji", key: "emoji:" + e.id, id: e.id, name: e.name ?? "", n: norm(e.name), animated: !!e.animated, group: gname(gid) });
    });

    // Importados de la galeria (siempre disponibles; no dependen de la tienda de Discord ni cuentan para "live")
    safe("importados", () => {
      for (const it of libItems()) {
        const isEmoji = it.kind === "emoji";
        const e = { kind: isEmoji ? "emoji" : "sticker", key: "local:" + it.id, id: it.id, name: it.name ?? "", n: norm(it.name), group: "Importados", local: true, lib: it, animated: !!it.animated };
        if (!isEmoji) e.tag = it.animated ? (it.ext === "gif" ? "GIF" : String(it.ext).toUpperCase()) : "";
        (isEmoji ? emojis : stickers).push(e);
      }
    });

    // La tienda de stickers de Discord a veces tarda en llenarse (al abrir la app o al volver de segundo plano).
    // Mientras no haya stickers de servidores, se usa la copia guardada de la ultima vez que si cargaron
    // (mandarlos solo necesita el id y el formato). Cuando llegan los reales, los reemplazan.
    const live = guildStickers.length > 0;
    let fromCache = false;
    if (live) scheduleStickerSave(guildStickers);
    else {
      const have = new Set(stickers.map((i) => i.id));
      for (const r of getList("stickerCache")) { // [id, nombre, formato, servidor]
        if (!Array.isArray(r) || !r[0] || have.has(r[0]) || (r[2] !== 1 && r[2] !== 2 && r[2] !== 4)) continue;
        stickers.push({ kind: "sticker", key: "sticker:" + r[0], id: r[0], name: r[1] ?? "", n: norm(r[1]), group: r[3] ?? "Servidor", raw: { id: r[0], name: r[1], format_type: r[2] }, tag: r[2] === 4 ? "GIF" : r[2] === 2 ? "APNG" : "" });
        fromCache = true;
      }
    }

    const uniq = (list) => [...new Set(list.map((i) => i.group))].sort((a, b) => a.localeCompare(b));
    const byKey = {};
    for (const i of stickers) byKey[i.key] = i;
    for (const i of emojis) byKey[i.key] = i;
    return { stickers, emojis, byKey, stickerGroups: uniq(stickers), emojiGroups: uniq(emojis), live, fromCache };
  }

  // Copia guardada de los stickers de tus servidores. Se guarda 8 s despues del ultimo cambio (asi no se
  // sobrescribe con una lista a medio cargar si la app se cierra justo al abrir) y solo si cambio algo.
  let saveT = null, saveRows = null;
  function flushStickerSave() {
    if (saveT) { clearTimeout(saveT); saveT = null; }
    if (saveRows) { setList("stickerCache", saveRows); saveRows = null; }
  }
  function scheduleStickerSave(list) {
    const rows = list.map((i) => [i.id, i.name, fmt(i.raw), i.group]);
    if (JSON.stringify(rows) === JSON.stringify(getList("stickerCache"))) { saveRows = null; if (saveT) { clearTimeout(saveT); saveT = null; } return; }
    saveRows = rows;
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(flushStickerSave, 8000);
  }

  // El catalogo se reutiliza 30 s (abrir el selector es instantaneo), pero SOLO si ya tiene los stickers
  // reales: uno vacio o sacado de la copia guardada se vuelve a armar a los 2 s, y cualquier cambio en la
  // tienda de stickers lo invalida al momento (antes un catalogo vacio se quedaba 30 s).
  let catCache = null, catAt = 0;
  function getCatalog(force) {
    const ttl = catCache && catCache.live ? 30000 : 2000;
    if (force === true || !catCache || Date.now() - catAt > ttl) { catCache = buildCatalogRaw(); catAt = Date.now(); }
    return catCache;
  }
  // Revision barata: ¿la tienda de Discord ya tiene stickers de servidores? (sin armar el catalogo)
  function storeHasStickers() {
    return !!safe("tienda?", () => {
      const m = S.StickersStore?.getAllGuildStickers?.();
      if (!m) return false;
      if (m instanceof Map) { for (const a of m.values()) if (a && a.length) return true; return false; }
      for (const k of Object.keys(m)) if (m[k] && m[k].length) return true;
      return false;
    });
  }
  // El selector abierto se entera cuando los stickers terminan de cargar y se actualiza solo
  const catListeners = new Set();
  let notifyT = null;
  function onStickersChanged() {
    catAt = 0;
    if (notifyT) return;
    notifyT = setTimeout(() => {
      notifyT = null;
      safe("catalogo", () => getCatalog()); // arma el catalogo (y la copia guardada) aunque el selector este cerrado
      for (const f of [...catListeners]) safe("catalogo listener", f);
    }, 400);
  }

  // Cierre del selector: la hoja se cierra por su clave (igual que Bunny). Si el selector se pudo envolver
  // en el ActionSheet nativo, cierra de verdad (tocar fuera, deslizar, boton atras). El cierre "suave"
  // (ocultar contenido) solo se usa si NO hay ActionSheet nativo, y nunca si se cerro bien.
  const SHEET_KEY = "StickerSenderPicker";
  const softClosers = new Set();
  function closePicker() {
    safe("close key", () => S.ActionSheet?.hideActionSheet?.(SHEET_KEY));
    if (S.NativeSheet) return; // hoja nativa: hideActionSheet(clave) basta
    safe("close", () => S.ActionSheet?.hideActionSheet?.());
    for (const f of [...softClosers]) safe("soft close", f);
  }

  let lastPick = { key: "", at: 0 };
  function pickItem(item, channelId) {
    const now = Date.now();
    if (lastPick.key === item.key && now - lastPick.at < 700) return; // doble toque
    if (item.local) { // importado de la galeria: se manda como archivo
      lastPick = { key: item.key, at: now };
      if (!cfg("keepOpen")) closePicker();
      pushRecent(item.key);
      sendLocalItem(channelId, item);
      return;
    }
    const url = item.kind === "sticker" ? stickerUrl(item.raw) : emojiUrl(item.id, item.animated);
    if (!url) { toast("Ese sticker no se puede mandar como imagen"); return; }
    lastPick = { key: item.key, at: now };
    if (!cfg("keepOpen")) closePicker();
    pushRecent(item.key);
    if (item.kind === "sticker" && wantGif(item.raw)) { sendApngGif(channelId, item.raw, "", url); return; }
    sendContent(channelId, url);
  }

  // ---------- Envio nativo de stickers (cualquier funcion sendSticker*) ----------
  const hasNitro = () => !!S.UserStore?.getCurrentUser?.()?.premiumType;
  const channelGuild = (channelId) => S.ChannelStore?.getChannel?.(channelId)?.guild_id;

  function nativeStickerSend(name) {
    return (args, orig) => {
      state.spy.fnCalls[name] = (state.spy.fnCalls[name] || 0) + 1;
      if (name === "sendStickers") state.spy.sendStickers++;
      const channelId = args[0];
      if (typeof channelId !== "string" || hasNitro()) return orig(...args);
      const urls = [], sts = [];
      for (const x of [].concat(args[1] ?? [])) {
        const id = x && typeof x === "object" ? x.id : x;
        const st = S.StickersStore?.getStickerById?.(id) ?? (x && typeof x === "object" && x.id ? x : null);
        if (!st) return orig(...args);
        // Sticker del mismo servidor: el envio normal funciona y se ve mejor
        if (st.guild_id && st.guild_id === channelGuild(channelId) && st.available !== false) return orig(...args);
        const url = stickerUrl(st);
        if (!url) { toast("Los stickers Lottie no se pueden mandar como imagen"); return; }
        urls.push(url);
        sts.push(st);
      }
      if (!urls.length) return orig(...args);
      const text = typeof args[2] === "string" ? args[2].trim() : "";
      if (urls.length === 1 && wantGif(sts[0])) { sendApngGif(channelId, sts[0], text, urls[0]); return; }
      return sendContent(channelId, (text ? text + "\n" : "") + urls.join("\n"));
    };
  }

  // ---------- Selector (hoja inferior) ----------
  let CellC = null;
  function getCell(React, RN) {
    if (CellC) return CellC;
    const h = React.createElement;
    CellC = React.memo(function Cell(p) {
      const item = p.item;
      return h(RN.Pressable, {
        onPress: () => pickItem(item, p.channelId),
        onLongPress: () => { toast(toggleFav(item.key) ? "Agregado a favoritos" : "Quitado de favoritos"); p.bump(); },
        style: { width: 100 / p.cols + "%", alignItems: "center", padding: 4 },
      },
        h(RN.Image, { source: { uri: previewUrl(item) }, style: { width: p.imgSz, height: p.imgSz }, resizeMode: "contain" }),
        h(RN.Text, { numberOfLines: 1, style: { color: "#b5bac1", fontSize: 10, marginTop: 2 } }, (p.fav ? "★ " : "") + item.name),
        item.tag ? h(RN.Text, { style: { color: "#5865f2", fontSize: 9, fontWeight: "bold" } }, item.tag) : null);
    });
    return CellC;
  }

  function Picker(props) {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const h = React.createElement;
    const [tab, setTab] = React.useState(props.tab || "sticker");
    const [query, setQuery] = React.useState(props.query || "");
    const [dq, setDq] = React.useState(props.query || ""); // busqueda con retraso: filtra 150 ms despues de la ultima tecla
    const [group, setGroup] = React.useState("*");
    const [anim, setAnim] = React.useState("all"); // all | anim | static
    const [, bump] = React.useReducer((x) => x + 1, 0);
    const [closed, setClosed] = React.useState(false);
    const [full, setFull] = React.useState(false);
    const [ver, setVer] = React.useState(0);
    const [openedAt] = React.useState(Date.now);
    const cat = React.useMemo(() => getCatalog(), [ver]);
    React.useEffect(() => {
      if (dq === query) return;
      const t = setTimeout(() => setDq(query), 150);
      return () => clearTimeout(t);
    }, [query]);
    React.useEffect(() => {
      // Mientras los stickers reales no hayan llegado, mira cada 2 s (hasta 2 min) si ya aparecieron; la
      // revision es barata (solo pregunta a la tienda) y el catalogo solo se rearma cuando hay algo nuevo.
      // Ademas se actualiza al instante cuando la tienda de stickers cambia
      const f = () => setVer((v) => v + 1);
      catListeners.add(f);
      const t = setInterval(() => {
        if (Date.now() - openedAt < 120000 && !(catCache && catCache.live) && storeHasStickers()) { catAt = 0; f(); }
      }, 2000);
      return () => { catListeners.delete(f); clearInterval(t); };
    }, []);
    React.useEffect(() => {
      const f = () => setClosed(true);
      softClosers.add(f);
      return () => softClosers.delete(f);
    }, []);

    const isSticker = tab === "sticker";
    const items = isSticker ? cat.stickers : cat.emojis;
    const groups = isSticker ? cat.stickerGroups : cat.emojiGroups;
    const q = norm(query.trim());
    const special = group === "@recents" || group === "@favs" || group === "@top";
    const favSet = new Set(getList("favs"));
    // Cuantos hay en cada servidor (se muestra en el chip)
    const counts = React.useMemo(() => {
      const c = {};
      for (const i of items) c[i.group] = (c[i.group] || 0) + 1;
      return c;
    }, [items]);
    const topList = () => {
      const u = getUses();
      return Object.keys(u).filter((k) => u[k] > 0).sort((a, b) => u[b] - u[a]).map((k) => cat.byKey[k]).filter((i) => i && i.kind === tab).slice(0, 48);
    };
    const specialBase = () => (group === "@top" ? topList() : getList(group === "@recents" ? "recents" : "favs").map((k) => cat.byKey[k]).filter((i) => i && i.kind === tab));
    const isAnim = (i) => (i.kind === "sticker" ? !!i.tag : !!i.animated);
    // Busqueda: varias palabras (todas deben coincidir) en el nombre del sticker/emoji o en el del servidor;
    // primero los que coinciden exacto o por el principio del nombre
    const gOf = (i) => i._g || (i._g = norm(i.group));
    const toks = q ? q.split(/\s+/).filter(Boolean) : [];
    const score = (i) => {
      let s = 0;
      for (const t of toks) {
        if (i.n === t) s += 4;
        else if (i.n.startsWith(t)) s += 3;
        else if (i.n.includes(t)) s += 2;
        else if (gOf(i).includes(t)) s += 1;
        else return 0;
      }
      return s;
    };
    const applyFilters = (list) => {
      const byAnim = anim === "all" ? list : list.filter((i) => (anim === "anim" ? isAnim(i) : !isAnim(i)));
      return q
        ? byAnim.map((i, idx) => ({ i, idx, s: score(i) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.idx - b.idx).map((x) => x.i)
        : byAnim;
    };
    // El filtrado de la lista completa solo se rehace si cambia algo que le afecta (no en cada dibujado);
    // las listas especiales (favoritos, recientes, mas usados) son chicas y se leen siempre al dia
    const memoShown = React.useMemo(
      () => (special ? null : applyFilters(items.filter((i) => group === "*" || i.group === group))),
      [items, group, anim, q, special]);
    const shown = special ? applyFilters(specialBase()) : memoShown;
    const cols = [3, 4, 5, 6].includes(Number(cfg("pickerCols"))) ? Number(cfg("pickerCols")) : 4;
    const imgSz = { 3: 84, 4: 64, 5: 54, 6: 46 }[cols];

    const chip = (label, active, onPress, key) =>
      h(RN.Pressable, {
        key, onPress,
        style: {
          paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, marginRight: 6,
          backgroundColor: active ? "#5865f2" : "#2b2d31",
        },
      }, h(RN.Text, { style: { color: "#fff", fontSize: 13 } }, label));

    if (closed) return null;
    const boxH = Math.round(RN.Dimensions.get("window").height * 0.6);
    const statusPad = (RN.StatusBar?.currentHeight ?? 28) + 8;

    // Cada celda es un componente memorizado: al escribir o cambiar de pestana solo se redibujan las que cambian
    const Cell = getCell(React, RN);
    const cell = (item) =>
      h(Cell, { key: item.kind + item.id, item, fav: favSet.has(item.key), cols, imgSz, channelId: props.channelId, bump });

    // Modo de lista: dentro de la hoja nativa, un FlatList normal pelea con el gesto de la hoja y no baja.
    // gh = FlatList de gesture-handler (convive con la hoja) | sheet = la propia hoja hace scroll | rn = normal
    const mode = S.NativeSheet ? (cfg("scrollMode") || "gh") : "rn";
    const ListC = mode === "gh" && S.GHList ? S.GHList : RN.FlatList;
    // La fila de servidores tambien pelea con el gesto de la hoja: en modo gh/sheet usa el ScrollView de gesture-handler
    const HScroll = mode !== "rn" && S.GHScroll ? S.GHScroll : RN.ScrollView;
    const emptyMsg = group === "@favs" ? "Mant\u00e9n presionado un sticker o emoji para guardarlo aqu\u00ed"
      : group === "@recents" ? "Aqu\u00ed aparecer\u00e1n los que uses"
      : group === "@top" ? "Aqu\u00ed aparecer\u00e1n los que m\u00e1s uses"
      : items.length ? (anim === "anim" ? "No hay animados aqu\u00ed" : anim === "static" ? "No hay no animados aqu\u00ed" : "Sin resultados") : isSticker && !cat.live && Date.now() - openedAt < 120000 ? "Cargando stickers..." : "No se encontraron " + (isSticker ? "stickers" : "emojis") + " en tus servidores";
    const listNode = !shown.length
      ? h(RN.Text, { style: { color: "#b5bac1", textAlign: "center", marginTop: 24 } }, emptyMsg)
      : mode === "sheet"
        ? h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } }, ...shown.map(cell))
        : h(ListC, {
            key: "cols" + cols, data: shown, numColumns: cols, keyExtractor: (i) => i.kind + i.id,
            initialNumToRender: 24, windowSize: 5, removeClippedSubviews: false,
            keyboardShouldPersistTaps: "handled", nestedScrollEnabled: true, style: { flex: 1 },
            renderItem: ({ item }) => cell(item),
          });

    // Contenido del selector (igual para ambos modos)
    const kids = [
        h(RN.View, { style: { flexDirection: "row", marginBottom: 8 } },
          chip("Stickers", isSticker, () => { setTab("sticker"); setGroup("*"); }, "t1"),
          chip("Emojis", !isSticker, () => { setTab("emoji"); setGroup("*"); }, "t2"),
          chip(anim === "anim" ? "\u25b6 Animados" : anim === "static" ? "No animados" : "Cualquiera",
            anim !== "all", () => setAnim(anim === "all" ? "anim" : anim === "anim" ? "static" : "all"), "a_filter"),
          h(RN.View, { style: { flex: 1 } }),
          chip("Cerrar", false, closePicker, "close")),
        h(RN.TextInput, {
          value: query, onChangeText: setQuery, placeholder: "Buscar...", placeholderTextColor: "#80848e",
          style: { backgroundColor: "#2b2d31", color: "#fff", borderRadius: 8, paddingHorizontal: 12, height: 40, marginBottom: 8 },
        }),
        h(HScroll, { horizontal: true, showsHorizontalScrollIndicator: false, nestedScrollEnabled: true, keyboardShouldPersistTaps: "handled", style: { flexGrow: 0, marginBottom: 8 } },
          h(RN.Pressable, {
            key: "@import", onPress: () => startImport(),
            style: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, marginRight: 6, backgroundColor: "#248046" },
          }, h(RN.Text, { style: { color: "#fff", fontSize: 13, fontWeight: "bold" } }, "+ Importar")),
          chip("Todos", group === "*", () => setGroup("*"), "*"),
          chip("\u2605 Favoritos", group === "@favs", () => setGroup("@favs"), "@favs"),
          chip("Recientes", group === "@recents", () => setGroup("@recents"), "@recents"),
          chip("Más usados", group === "@top", () => setGroup("@top"), "@top"),
          ...groups.map((g) => chip(g + " (" + (counts[g] || 0) + ")", group === g, () => setGroup(g), g))),
        listNode
    ];

    // Modo nativo: dentro del ActionSheet de Discord. Ahi la hoja se ancla abajo, se cierra de verdad
    // (hideActionSheet(clave), tocar fuera, deslizar, atras) y no deja nada tapando la pantalla.
    const NS = S.NativeSheet;
    if (NS && mode === "sheet")
      return h(NS, { scrollable: true }, h(RN.View, { style: { paddingBottom: 16 } }, ...kids));
    if (NS)
      return h(NS, null,
        h(RN.View, { style: { height: boxH, paddingBottom: 16 } }, ...kids));

    // Modo de respaldo (sin ActionSheet nativo): contenedor propio. Si la hoja de Discord ocupa toda la
    // pantalla, el selector queda abajo y tocar arriba lo cierra.
    return h(RN.View, {
      style: { flex: 1, justifyContent: "flex-end" },
      onLayout: (e) => { const hh = e?.nativeEvent?.layout?.height ?? 0; setFull(hh > boxH + 40); },
    },
      h(RN.Pressable, { style: { flex: 1 }, onPress: closePicker }),
      h(RN.View, {
        style: {
          height: boxH,
          backgroundColor: "#1e1f22",
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          paddingTop: full ? 12 : statusPad, paddingHorizontal: 12, paddingBottom: 24,
        },
      }, ...kids));
  }

  function resolveNativeSheet() {
    S.NativeSheet = null;
    const okComp = (c) => c && (typeof c === "function" || (typeof c === "object" && c.$$typeof));
    const gh = safe("ghMod", () => findByProps("GestureHandlerRootView") ?? findByProps("FlatList", "ScrollView", "Swipeable"));
    S.GHList = okComp(gh?.FlatList) ? gh.FlatList : null;
    S.GHScroll = okComp(gh?.ScrollView) ? gh.ScrollView : null;
    if (!cfg("nativeSheet")) return;
    const c = safe("nativeSheet", () => findByProps("ActionSheet")?.ActionSheet);
    if (c && (typeof c === "function" || (typeof c === "object" && c.$$typeof))) S.NativeSheet = c;
  }

  // Si el selector llegara a fallar al dibujarse, se muestra un aviso en vez de tumbar la pantalla/la app
  let Boundary = null;
  function getBoundary(React, RN) {
    if (Boundary) return Boundary;
    Boundary = safe("boundary", () => {
      class B extends React.Component {
        constructor(p) { super(p); this.state = { err: null }; }
        static getDerivedStateFromError(err) { return { err }; }
        componentDidCatch(err) { state.pickerError = String(err?.message ?? err).slice(0, 200); console.error(TAG, "selector fallo:", err); }
        render() {
          if (!this.state.err) return this.props.children;
          return React.createElement(RN.View, { style: { padding: 24, backgroundColor: "#1e1f22" } },
            React.createElement(RN.Text, { style: { color: "#fff" } }, "El selector falló: " + String(this.state.err?.message ?? this.state.err).slice(0, 120)));
        }
      }
      return B;
    });
    return Boundary;
  }

  function openPicker(opts) {
    const { React, ReactNative: RN } = vendetta.metro.common;
    resolveNativeSheet();
    const channelId = opts.channelId ?? S.SelectedChannelStore?.getChannelId?.();
    const comp = () => {
      const pick = React.createElement(Picker, { ...opts, channelId });
      const B = getBoundary(React, RN);
      return B ? React.createElement(B, null, pick) : pick;
    };
    if (S.ActionSheet?.openLazy)
      return S.ActionSheet.openLazy(Promise.resolve({ default: comp }), SHEET_KEY, {});
    const alerts = vendetta.ui.alerts;
    if (alerts?.showCustomAlert) return alerts.showCustomAlert(comp, {});
    toast("No se pudo abrir el selector en esta version");
  }

  // ---------- Desbloqueo de selectores nativos (extra) ----------
  const UNLOCK = {
    getStickerSendability: "sendability", // devuelve SENDABLE si se conoce el enum
    isSendableSticker: () => true,
    getEmojiUnavailableReason: () => null,
    isEmojiFiltered: () => false,
  };
  const CAN_USE_RE = /^canUse(Custom|Animated)?(Emojis?|Stickers?)(Everywhere)?$/;
  const SEND_STICKER_RE = /^sendStickers?(Message)?$/i;
  const stickerFns = new Set();
  const NAME_RE = /sendab|unavailablereason|canuse(emoji|sticker|animated|custom)|emojifiltered|premiumlocked/i;

  const patchedPairs = new WeakMap(); // holder -> Set(nombres ya parcheados)
  const scanned = new Set();          // ids de modulos ya revisados
  const seenNames = new Set();
  const pending = [];                 // [holder, name] esperando el enum SENDABLE
  let enumObj = null;

  function patchHolder(holder, name, ret) {
    let set = patchedPairs.get(holder);
    if (!set) patchedPairs.set(holder, (set = new Set()));
    if (set.has(name)) return false;
    set.add(name);
    try { patches.push(instead(name, holder, ret)); return true; } catch (_) { return false; }
  }

  // Revision incremental: solo modulos nuevos desde la ultima vez
  function scanAndPatch() {
    let applied = 0;
    const mods = vendetta.metro.modules ?? globalThis.modules ?? {};
    const found = [];
    for (const id in mods) {
      if (scanned.has(id)) continue;
      try {
        const m = mods[id];
        if (!m || m.isInitialized === false) continue;
        const exp = m.publicModule?.exports;
        if (!exp) continue;
        scanned.add(id);
        for (const holder of [exp, exp.default]) {
          if (!holder || (typeof holder !== "object" && typeof holder !== "function")) continue;
          if (!enumObj && "SENDABLE" in holder && "NONSENDABLE" in holder) enumObj = holder;
          for (const k of Object.keys(holder)) {
            if (NAME_RE.test(k)) seenNames.add(k);
            if (typeof holder[k] === "function") {
              if (/sticker/i.test(k) && stickerFns.size < 80) stickerFns.add(k);
              if (SEND_STICKER_RE.test(k) && !(holder === S.StickerActions && k === "sendStickers")) found.push([holder, k]);
            }
            if ((k in UNLOCK || CAN_USE_RE.test(k)) && typeof holder[k] === "function") found.push([holder, k]);
          }
        }
      } catch (_) {}
    }
    const r = state.report;
    for (const [holder, name] of pending.splice(0).concat(found)) {
      let ret = SEND_STICKER_RE.test(name) ? nativeStickerSend(name) : (UNLOCK[name] ?? (() => true));
      if (ret === "sendability") {
        if (!enumObj) { pending.push([holder, name]); continue; }
        const ok = enumObj.SENDABLE;
        ret = () => ok;
      }
      if (patchHolder(holder, name, ret)) {
        applied++;
        if (!r.patched.includes(name)) r.patched.push(name);
      }
    }
    r.similar = [...seenNames];
    r.missing = Object.keys(UNLOCK).filter((n) => !r.patched.includes(n));
    return applied;
  }

  function reportText() {
    const r = state.report;
    return (
      "StickerSender v2.11\n" +
      "parcheados: " + (r.patched.join(", ") || "ninguno") + "\n" +
      "no encontrados: " + (r.missing.join(", ") || "ninguno") + "\n" +
      "nombres parecidos: " + (r.similar.slice(0, 60).join(", ") || "ninguno") + "\n" +
      "enum SENDABLE: " + !!enumObj + " | modulos revisados: " + scanned.size + "\n" +
      "sendMessage:" + !!S.MessageActions + " sendStickers:" + !!S.StickerActions +
      " StickersStore:" + !!S.StickersStore + " EmojiStore:" + !!S.EmojiStore +
      " GuildStore:" + !!S.GuildStore + " ActionSheet:" + !!S.ActionSheet + " hojaNativa:" + !!S.NativeSheet + " listaGH:" + !!S.GHList + " scrollH:" + !!S.GHScroll + " scroll:" + cfg("scrollMode") +
      " comandos:" + !!vendetta.commands?.registerCommand + "\n" +
      "sendMessage llamadas: " + state.spy.sendMessage + " | sendStickers llamadas: " + state.spy.sendStickers +
      " | stickers convertidos: " + state.spy.converted + "\n" +
      "ultimo sendMessage: " + (state.spy.last || "ninguno") + "\n" +
      "ultimo resultado propio: " + (state.spy.lastResult || "ninguno") + "\n" +
      "forma de envio usada: " + state.spy.shape + " | intentos fallidos: " + (state.spy.shapeLog || "ninguno") + "\n" +
      "modulos sendMessage: " + (S.msgModules ? S.msgModules.length : 0) + "\n" +
      "ultimo error del selector: " + (state.pickerError || "ninguno") + "\n" +
      "importados: " + libItems().length + " (" + (lib.mode || "sin abrir") + (lib.err ? ", error: " + lib.err : "") + ") | ok: " + importState.ok + " fallos: " + importState.fail + " enviados: " + importState.sent + "\n" +
      "ultimo importar: " + (importState.last || "ninguno") + " | selectores usados: " + (importState.pickers || "sin probar") + "\n" +
      "selectores descartados por cerrar la app: " + (getList("pickBad").join(", ") || "ninguno") + " | busqueda a fondo descartada: " + deepScanBad() + "\n" +
      "selectores de galeria disponibles: " +(safe("find", () => findPickers().map((c) => c.label + "." + c.fn).join(", ")) || "ninguno") + "\n" +
      "nombres de selector en modulos: " + (safe("scan", () => { const s = pickerScan(); return (s.names.join(", ") || "ninguno") + " | nativos: " + (s.native.join(", ") || "ninguno"); }) ?? "error") + "\n" +
      "storage: createStorage:" + (typeof vendetta.storage?.createStorage) + " createFileBackend:" + (typeof vendetta.storage?.createFileBackend) + " showInputAlert:" + (typeof vendetta.ui?.alerts?.showInputAlert) + "\n" +
      "llamadas a funciones de sticker: " + (JSON.stringify(state.spy.fnCalls) || "{}") + "\n" +
      "ultimo APNG->GIF: " + (gifState.last || "ninguno") + " | ok: " + gifState.ok + " | fallos: " + gifState.fail + "\n" +
      "ultimo contenido enviado: " + (state.spy.lastUrl || "ninguno") + "\n" +
      "funciones con 'sticker': " + ([...stickerFns].join(", ") || "ninguna") + "\n" +
      "catalogo: " + (safe("cat", () => { const c = getCatalog(true); return c.stickers.length + " stickers" + (c.live ? "" : c.fromCache ? " (de la copia guardada: la tienda de stickers esta vacia)" : " (la tienda de stickers esta vacia y no hay copia)") + ", " + c.emojis.length + " emojis | copia guardada: " + getList("stickerCache").length; }) ?? "error")
    );
  }
  function copyReport() {
    const text = reportText();
    console.log(TAG, text);
    safe("clipboard", () => vendetta.metro.common.clipboard.setString(text));
    return text;
  }

  // ---------- Ajustes ----------
  function Settings() {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const Forms = vendetta.ui.components?.Forms;
    const [, force] = React.useReducer((x) => x + 1, 0);
    const st = vendetta.plugin.storage;
    const set = (k, v) => { st[k] = v; force(); };
    const h = React.createElement;
    if (!Forms) return h(RN.Text, { style: { color: "#fff", padding: 16 } }, "Ajustes no disponibles en esta version.");
    const { FormSection, FormSwitchRow, FormRow, FormInput } = Forms;
    const num = (k, title) =>
      h(FormInput, {
        title, value: String(cfg(k)), keyboardType: "numeric",
        onChange: (t) => { const n = parseInt(t, 10); if (n) set(k, n); },
      });
    const sw = (k, label, sub) =>
      h(FormSwitchRow, { label, subLabel: sub, value: !!cfg(k), onValueChange: (v) => set(k, v) });
    return h(RN.ScrollView, null,
      h(FormSection, { title: "Selector" },
        h(FormRow, { label: "Abrir selector de stickers", subLabel: "Tambien: escribe /sticker en el chat", onPress: () => openPicker({ tab: "sticker" }) }),
        h(FormRow, { label: "Abrir selector de emojis", subLabel: "Tambien: escribe /emoji en el chat", onPress: () => openPicker({ tab: "emoji" }) })),
      h(FormSection, { title: "Importados" },
        h(FormRow, { label: "Importar de la galeria", subLabel: "PNG, GIF, APNG, WebP o JPG, como sticker o emoji (animados tambien)", onPress: () => startImport("gallery") }),
        h(FormRow, { label: "Importar desde un link", subLabel: "Copia el link de una imagen y toca aqui", onPress: () => startImport("link") }),
        getList("pickBad").length || deepScanBad() ? h(FormRow, {
          label: "Selectores de galeria descartados",
          subLabel: [...getList("pickBad"), deepScanBad() ? "busqueda a fondo" : null].filter(Boolean).join(", ") + " (cerraron la app; toca para volver a probarlos)",
          onPress: () => { setList("pickBad", []); setList("scanBad", false); setList("pickPending", ""); setList("scanPending", ""); force(); toast("Se volveran a probar"); },
        }) : null,
        ...libItems().map((it) =>
          h(FormRow, {
            key: it.id, label: (it.kind === "emoji" ? "Emoji: " : "Sticker: ") + it.name,
            subLabel: String(it.ext).toUpperCase() + (it.animated ? " animado" : "") + " | " + (it.w ? it.w + "x" + it.h + " | " : "") + Math.max(1, Math.round((it.bytes || 0) / 1024)) + " KB | toca para borrar" + (hasTextInput() ? " o renombrar" : ""),
            onPress: async () => {
              const c = await choose(it.name, "Importado como " + it.kind, hasTextInput() ? ["Borrar", "Renombrar"] : ["Borrar"]);
              if (c === 0) { await removeFromLib(it.id); toast("Borrado"); force(); }
              else if (c === 1) { const nm = await askText("Nombre", it.name, "nombre"); if (nm) { await renameInLib(it.id, cleanName(nm)); force(); } }
            },
          })),
        h(FormRow, {
          label: "Almacenamiento de importados",
          subLabel: libItems().length + " guardados | " + (libBytes() < 1048576 ? Math.round(libBytes() / 1024) + " KB" : (libBytes() / 1048576).toFixed(1) + " MB") + " de " + Math.round(libCap() / 1048576) + " MB | " + (lib.mode || "abriendo...") + (lib.mode === "respaldo" ? " (esta version no permite archivos propios: limite menor)" : ""),
          onPress: () => force(),
        })),
      h(FormSection, { title: "Tamanos (32 a 512)" },
        num("stickerSize", "Sticker (normal: 160)"),
        num("emojiSize", "Emoji (normal: 48)")),
      h(FormSection, { title: "Opciones" },
        sw("animatedStickers", "Animados", "Apagado = siempre imagen estatica"),
        h(FormRow, {
          label: "Formato de stickers APNG animados",
          subLabel: "Actual: " + cfg("apngFormat") + " (toca para cambiar: png, webp, gif). Prueba cual se anima",
          onPress: () => set("apngFormat", { png: "webp", webp: "gif", gif: "png" }[cfg("apngFormat")] || "png"),
        }),
        sw("apngAsGif", "APNG animados como GIF", "Los convierte y sube como archivo para que se vean animados. Si falla, manda el link"),
        h(FormRow, {
          label: "Columnas del selector",
          subLabel: "Actual: " + cfg("pickerCols") + " (toca para cambiar: 3, 4, 5, 6)",
          onPress: () => { const o = [3, 4, 5, 6], i = o.indexOf(Number(cfg("pickerCols"))); set("pickerCols", o[(i + 1) % o.length]); },
        }),
        h(FormRow, {
          label: "Tamano del sticker GIF en el chat",
          subLabel: "Actual: " + gifPad() + " (toca para cambiar: 1.5, 2, 2.5, 3, 4). Si se ve grande, sube el numero; si chico, bajalo",
          onPress: () => { const o = [1.5, 2, 2.5, 3, 4], i = o.indexOf(gifPad()); set("gifPad", o[(i + 1) % o.length]); },
        }),
        sw("nativeSheet", "Selector en hoja nativa", "Cierra bien. Apagar solo si el selector se ve mal"),
        sw("animatedPreview", "Vista previa animada", "Los GIF/APNG se mueven en el selector"),
        h(FormRow, {
          label: "Deslizar la lista del selector",
          subLabel: "Actual: " + cfg("scrollMode") + " (toca para cambiar: gh, sheet, rn). Si no baja, prueba otro",
          onPress: () => set("scrollMode", { gh: "sheet", sheet: "rn", rn: "gh" }[cfg("scrollMode")] || "gh"),
        }),
        sw("keepOpen", "Mantener selector abierto", "Para mandar varios seguidos"),
        sw("maskEmojiLinks", "Ocultar link de emoji", "Muestra [nombre] en vez del link"),
        sw("nativeUnlock", "Desbloquear selectores nativos", "Extra; requiere reiniciar el plugin"),
        sw("debugReport", "Copiar reporte al iniciar", "Para diagnosticar")),
      h(FormSection, { title: "Datos" },
        h(FormRow, {
          label: "Borrar recientes y más usados",
          subLabel: getList("recents").length + " recientes | " + Object.keys(getUses()).length + " con usos | " + getList("favs").length + " favoritos",
          onPress: () => { setList("recents", []); setList("uses", {}); force(); toast("Recientes y más usados borrados"); },
        }),
        h(FormRow, {
          label: "Restablecer ajustes",
          subLabel: "Vuelve a los valores normales (no borra favoritos)",
          onPress: () => { for (const k of Object.keys(DEFAULTS)) st[k] = DEFAULTS[k]; force(); toast("Ajustes restablecidos"); },
        })),
      h(FormSection, { title: "Diagnostico" },
        h(FormRow, {
          label: "Copiar reporte ahora",
          subLabel: "Modulos revisados: " + scanned.size,
          onPress: () => { if (cfg("nativeUnlock")) scanAndPatch(); copyReport(); toast("Reporte copiado"); },
        })));
  }

  // ---------- Plugin ----------
  exports.default = {
    settings: Settings,

    onLoad() {
      // Varios candidatos: el nombre de las props cambia entre versiones
      S.msgModules = [];
      for (const props of [["editMessage", "sendMessage"], ["sendMessage", "receiveMessage"], ["sendMessage"]]) {
        const mod = safe("findMsg", () => findByProps(...props));
        if (mod && typeof mod.sendMessage === "function" && !S.msgModules.includes(mod)) S.msgModules.push(mod);
      }
      S.MessageActions = S.msgModules[0];
      S.StickerActions = findByProps("sendStickers");
      S.ActionSheet = findByProps("openLazy", "hideActionSheet");
      S.StickersStore = findByStoreName("StickersStore");
      S.EmojiStore = findByStoreName("EmojiStore");
      S.GuildStore = findByStoreName("GuildStore");
      S.ChannelStore = findByStoreName("ChannelStore");
      S.UserStore = findByStoreName("UserStore");
      S.SelectedChannelStore = findByStoreName("SelectedChannelStore");
      S.PendingReplyStore = findByStoreName("PendingReplyStore");
      S.FluxDispatcher = safe("flux", () => vendetta.metro.common.FluxDispatcher);

      // Catalogo de stickers: se renueva cuando la tienda cambia y se arma al poco de iniciar,
      // para que la copia guardada exista aunque nunca abras el selector
      safe("tienda stickers", () => {
        const st = S.StickersStore;
        if (st?.addChangeListener) {
          st.addChangeListener(onStickersChanged);
          unsubs.push(() => st.removeChangeListener?.(onStickersChanged));
        }
        timers.push(setTimeout(() => safe("precarga", () => getCatalog()), 4000));
      });
      safe("selectores", settlePickCrash); // si la app se cerro en un paso de la galeria, se descarta ese paso
      safe("biblioteca", () => { ensureLib(); }); // abre la biblioteca de importados (en segundo plano)

      // 0) Comandos: /sticker [nombre] y /emoji
      safe("comandos", () => {
        const reg = vendetta.commands?.registerCommand;
        if (!reg) { console.log(TAG, "no hay registerCommand"); return; }
        const base = { applicationId: "-1", inputType: 1, type: 1 };
        const arg = (args, n) => (args ?? []).find((a) => a.name === n)?.value;
        patches.push(reg({
          ...base, name: "sticker", displayName: "sticker",
          description: "Abre el selector de stickers (o manda uno por nombre)",
          displayDescription: "Abre el selector de stickers (o manda uno por nombre)",
          options: [{
            name: "nombre", displayName: "nombre", description: "Nombre del sticker",
            displayDescription: "Nombre del sticker", required: false, type: 3,
          }],
          execute: (args, ctx) => {
            const channelId = ctx?.channel?.id;
            const raw = String(arg(args, "nombre") ?? "").trim();
            const q = norm(raw);
            if (q) {
              const all = getCatalog().stickers;
              const exact = all.filter((s) => s.n === q);
              const part = all.filter((s) => s.n.includes(q));
              const one = exact.length === 1 ? exact[0] : part.length === 1 ? part[0] : null;
              if (one) { pickItem(one, channelId); return; }
            }
            openPicker({ tab: "sticker", query: raw, channelId });
          },
        }));
        patches.push(reg({
          ...base, name: "emoji", displayName: "emoji",
          description: "Abre el selector de emojis (o manda uno por nombre)",
          displayDescription: "Abre el selector de emojis (o manda uno por nombre)",
          options: [{
            name: "nombre", displayName: "nombre", description: "Nombre del emoji",
            displayDescription: "Nombre del emoji", required: false, type: 3,
          }],
          execute: (args, ctx) => {
            const channelId = ctx?.channel?.id;
            const raw = String(arg(args, "nombre") ?? "").trim();
            const q = norm(raw);
            if (q) {
              const all = getCatalog().emojis;
              const exact = all.filter((s) => s.n === q);
              const part = all.filter((s) => s.n.includes(q));
              const one = exact.length === 1 ? exact[0] : part.length === 1 ? part[0] : null;
              if (one) { pickItem(one, channelId); return; }
            }
            openPicker({ tab: "emoji", query: raw, channelId });
          },
        }));
      });

      // 1) Desbloquear selectores nativos (extra), con reintentos por modulos que cargan tarde
      if (cfg("nativeUnlock")) safe("desbloqueo", () => {
        scanAndPatch();
        // Revision periodica de modulos que cargan tarde. Si una pasada no encuentra modulos nuevos, la
        // siguiente espera el doble (hasta 30 s); si aparecen, vuelve a 5 s. Antes recorria todo cada 5 s siempre.
        let delay = 5000;
        const loop = () => {
          scanTimer = setTimeout(() => {
            const before = scanned.size;
            safe("rescan", scanAndPatch);
            delay = scanned.size === before ? Math.min(delay * 2, 30000) : 5000;
            loop();
          }, delay);
        };
        loop();
      });

      // 2) Stickers bloqueados que llegan por el envio nativo -> link de imagen
      safe("stickers", () => {
        if (!S.StickerActions || !S.StickersStore || !S.MessageActions) return;
        patches.push(instead("sendStickers", S.StickerActions, nativeStickerSend("sendStickers")));
      });

      // 3) Hook de sendMessage: convierte stickers (llegue como llegue) y emojis bloqueados
      function convertStickers(channelId, msg, extra) {
        const found = []; // [objeto, clave, ids]
        for (const holder of [msg, extra]) {
          if (!holder || typeof holder !== "object") continue;
          for (const key of ["stickers", "stickerIds", "sticker_ids", "stickerItems", "sticker_items"]) {
            const arr = holder[key];
            if (Array.isArray(arr) && arr.length)
              found.push([holder, key, arr.map((x) => (x && typeof x === "object" ? x.id : x)).filter(Boolean)]);
          }
        }
        if (!found.length) return;
        const urls = [];
        for (const [, , ids] of found)
          for (const id of ids) {
            const st = S.StickersStore?.getStickerById?.(id);
            if (!st) return; // no lo conocemos: no tocar
            // Sticker del mismo servidor: el envio normal funciona y se ve mejor
            if (st.guild_id && st.guild_id === channelGuild(channelId) && st.available !== false) return;
            const url = stickerUrl(st);
            if (!url) { toast("Los stickers Lottie no se pueden mandar como imagen"); return; }
            if (!urls.includes(url)) urls.push(url);
          }
        for (const [holder, key] of found) { try { holder[key] = []; } catch (_) {} }
        msg.content = (typeof msg.content === "string" && msg.content.trim() ? msg.content.trim() + "\n" : "") + urls.join("\n");
        state.spy.converted += urls.length;
      }

      safe("hook sendMessage", () => {
        for (const mod of S.msgModules) {
          patches.push(
            before("sendMessage", mod, (args) => {
              const [channelId, msg, , extra] = args;
              state.spy.sendMessage++;
              state.spy.last = "msg[" + keysOf(msg) + "] extra[" + keysOf(extra) + "]";
              if (!msg || typeof msg !== "object" || hasNitro()) return;

              safe("stickers hook", () => convertStickers(channelId, msg, extra));

              if (typeof msg.content !== "string" || !msg.content.includes("<")) return;
              const gid = channelGuild(channelId);
              const isUsable = (id, animated) => {
                const e = S.EmojiStore?.getCustomEmojiById?.(id);
                return !!e && !animated && e.available !== false && e.guildId === gid;
              };
              // Solo emojis -> links crudos separados (Discord oculta el texto y muestra la imagen)
              const onlyEmojis = msg.content.replace(EMOJI_RE, "").trim() === "";
              msg.content = msg.content.replace(EMOJI_RE, (m, a, name, id) => {
                const animated = a === "a";
                if (isUsable(id, animated)) return m;
                const url = emojiUrl(id, animated);
                if (onlyEmojis) return url + "\n";
                return cfg("maskEmojiLinks") ? "[" + name + "](" + url + ")" : url;
              });
              if (onlyEmojis) msg.content = msg.content.trim();
              msg.validNonShortcutEmojis = [];
              msg.invalidEmojis = [];
            })
          );
        }
      });

      // 4) Aviso de que cargo (si no lo ves, el plugin no se esta ejecutando)
      safe("aviso", () => {
        toast("StickerSender cargado. Escribe /sticker");
        if (cfg("debugReport")) copyReport();
      });
    },

    onUnload() {
      for (const t of timers) { clearInterval(t); clearTimeout(t); }
      timers.length = 0;
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
      for (const u of unsubs) safe("quitar listener", u);
      unsubs.length = 0;
      if (notifyT) { clearTimeout(notifyT); notifyT = null; }
      safe("guardar copia", flushStickerSave);
      for (const unpatch of patches) safe("unpatch", unpatch);
      patches.length = 0;
    },
  };

  return exports;
})({})
