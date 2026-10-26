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
  const pushRecent = (key) => setList("recents", [key, ...getList("recents").filter((x) => x !== key)].slice(0, 40));
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

  function buildMultipart(boundary, payload, filename, fileBytes) {
    const head = asciiBytes(
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n" +
      jsonAscii(payload) + "\r\n--" + boundary +
      "\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"" + filename + "\"\r\nContent-Type: image/gif\r\n\r\n"
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
  async function uploadGif(channelId, gif, name, text) {
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
      token, boundary, buildMultipart(boundary, payload, name, gif)
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
    try {
      toast("Convirtiendo sticker a GIF...");
      const t0 = Date.now();
      const bytes = await downloadApng(st.id);
      const gif = await apngToGif(bytes, size("stickerSize"));
      if (gif.length > 9 * 1024 * 1024) throw new Error("GIF demasiado grande");
      const name = (String(st.name || "sticker").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "sticker") + ".gif";
      await uploadGif(channelId, gif, name, text);
      gifState.ok++;
      gifState.last = "ok " + gif.length + " bytes en " + (Date.now() - t0) + " ms";
    } catch (e) {
      fallback(String(e?.message ?? e));
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
  function Picker(props) {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const h = React.createElement;
    const [tab, setTab] = React.useState(props.tab || "sticker");
    const [query, setQuery] = React.useState(props.query || "");
    const [group, setGroup] = React.useState("*");
    const [anim, setAnim] = React.useState("all"); // all | anim | static
    const [, bump] = React.useReducer((x) => x + 1, 0);
    const [closed, setClosed] = React.useState(false);
    const [full, setFull] = React.useState(false);
    const [ver, setVer] = React.useState(0);
    const [openedAt] = React.useState(Date.now);
    const cat = React.useMemo(() => getCatalog(), [ver]);
    React.useEffect(() => {
      // Mientras los stickers reales no hayan llegado, vuelve a mirar cada 2 s (hasta 2 min);
      // ademas se actualiza al instante cuando la tienda de stickers cambia
      const f = () => setVer((v) => v + 1);
      catListeners.add(f);
      const t = setInterval(() => { if (!getCatalog().live && Date.now() - openedAt < 120000) f(); }, 2000);
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
    const special = group === "@recents" || group === "@favs";
    const favSet = new Set(getList("favs"));
    const base = special
      ? getList(group === "@recents" ? "recents" : "favs").map((k) => cat.byKey[k]).filter((i) => i && i.kind === tab)
      : items.filter((i) => group === "*" || i.group === group);
    const isAnim = (i) => (i.kind === "sticker" ? !!i.tag : !!i.animated);
    const byAnim = anim === "all" ? base : base.filter((i) => (anim === "anim" ? isAnim(i) : !isAnim(i)));
    const shown = q ? byAnim.filter((i) => i.n.includes(q)) : byAnim;

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

    const cell = (item) =>
      h(RN.Pressable, {
        key: item.kind + item.id,
        onPress: () => pickItem(item, props.channelId),
        onLongPress: () => { toast(toggleFav(item.key) ? "Agregado a favoritos" : "Quitado de favoritos"); bump(); },
        style: { width: "25%", alignItems: "center", padding: 4 },
      },
        h(RN.Image, { source: { uri: previewUrl(item) }, style: { width: 64, height: 64 }, resizeMode: "contain" }),
        h(RN.Text, { numberOfLines: 1, style: { color: "#b5bac1", fontSize: 10, marginTop: 2 } }, (favSet.has(item.key) ? "\u2605 " : "") + item.name),
        item.tag ? h(RN.Text, { style: { color: "#5865f2", fontSize: 9, fontWeight: "bold" } }, item.tag) : null);

    // Modo de lista: dentro de la hoja nativa, un FlatList normal pelea con el gesto de la hoja y no baja.
    // gh = FlatList de gesture-handler (convive con la hoja) | sheet = la propia hoja hace scroll | rn = normal
    const mode = S.NativeSheet ? (cfg("scrollMode") || "gh") : "rn";
    const ListC = mode === "gh" && S.GHList ? S.GHList : RN.FlatList;
    // La fila de servidores tambien pelea con el gesto de la hoja: en modo gh/sheet usa el ScrollView de gesture-handler
    const HScroll = mode !== "rn" && S.GHScroll ? S.GHScroll : RN.ScrollView;
    const emptyMsg = group === "@favs" ? "Mant\u00e9n presionado un sticker o emoji para guardarlo aqu\u00ed"
      : group === "@recents" ? "Aqu\u00ed aparecer\u00e1n los que uses"
      : items.length ? (anim === "anim" ? "No hay animados aqu\u00ed" : anim === "static" ? "No hay no animados aqu\u00ed" : "Sin resultados") : isSticker && !cat.live && Date.now() - openedAt < 120000 ? "Cargando stickers..." : "No se encontraron " + (isSticker ? "stickers" : "emojis") + " en tus servidores";
    const listNode = !shown.length
      ? h(RN.Text, { style: { color: "#b5bac1", textAlign: "center", marginTop: 24 } }, emptyMsg)
      : mode === "sheet"
        ? h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } }, ...shown.map(cell))
        : h(ListC, {
            data: shown, numColumns: 4, keyExtractor: (i) => i.kind + i.id,
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
          chip("Todos", group === "*", () => setGroup("*"), "*"),
          chip("\u2605 Favoritos", group === "@favs", () => setGroup("@favs"), "@favs"),
          chip("Recientes", group === "@recents", () => setGroup("@recents"), "@recents"),
          ...groups.map((g) => chip(g, group === g, () => setGroup(g), g))),
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

  function openPicker(opts) {
    const { React } = vendetta.metro.common;
    resolveNativeSheet();
    const channelId = opts.channelId ?? S.SelectedChannelStore?.getChannelId?.();
    const comp = () => React.createElement(Picker, { ...opts, channelId });
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
      "StickerSender v2.9\n" +
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
          label: "Borrar recientes",
          subLabel: getList("recents").length + " guardados | " + getList("favs").length + " favoritos",
          onPress: () => { setList("recents", []); force(); toast("Recientes borrados"); },
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
          description: "Abre el selector de emojis de todos tus servidores",
          displayDescription: "Abre el selector de emojis de todos tus servidores",
          options: [],
          execute: (args, ctx) => { openPicker({ tab: "emoji", channelId: ctx?.channel?.id }); },
        }));
      });

      // 1) Desbloquear selectores nativos (extra), con reintentos por modulos que cargan tarde
      if (cfg("nativeUnlock")) safe("desbloqueo", () => {
        scanAndPatch();
        timers.push(setInterval(() => safe("rescan", scanAndPatch), 5000));
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
