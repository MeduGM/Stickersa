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

  // ---------- Catalogo propio (stickers y emojis de todos tus servidores) ----------
  function buildCatalogRaw() {
    const guilds = safe("guilds", () => S.GuildStore?.getGuilds?.()) ?? {};
    const gname = (gid) => guilds[gid]?.name ?? "Servidor";
    const stickers = [], emojis = [];

    safe("stickers", () => {
      const map = S.StickersStore?.getAllGuildStickers?.();
      if (map) {
        const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
        for (const [gid, arr] of entries)
          for (const s of arr ?? []) {
            if (fmt(s) === 3) continue; // Lottie no se puede mandar como imagen
            stickers.push({ kind: "sticker", key: "sticker:" + s.id, id: s.id, name: s.name ?? "", n: norm(s.name), group: gname(gid), raw: s, tag: fmt(s) === 4 ? "GIF" : fmt(s) === 2 ? "APNG" : "" });
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

    const uniq = (list) => [...new Set(list.map((i) => i.group))].sort((a, b) => a.localeCompare(b));
    const byKey = {};
    for (const i of stickers) byKey[i.key] = i;
    for (const i of emojis) byKey[i.key] = i;
    return { stickers, emojis, byKey, stickerGroups: uniq(stickers), emojiGroups: uniq(emojis) };
  }
  // El catalogo se arma una vez y se reutiliza 30 s (abrir el selector es instantaneo)
  let catCache = null, catAt = 0;
  function getCatalog(force) {
    if (force === true || !catCache || Date.now() - catAt > 30000) { catCache = buildCatalogRaw(); catAt = Date.now(); }
    return catCache;
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
      const urls = [];
      for (const x of [].concat(args[1] ?? [])) {
        const id = x && typeof x === "object" ? x.id : x;
        const st = S.StickersStore?.getStickerById?.(id) ?? (x && typeof x === "object" && x.id ? x : null);
        if (!st) return orig(...args);
        // Sticker del mismo servidor: el envio normal funciona y se ve mejor
        if (st.guild_id && st.guild_id === channelGuild(channelId) && st.available !== false) return orig(...args);
        const url = stickerUrl(st);
        if (!url) { toast("Los stickers Lottie no se pueden mandar como imagen"); return; }
        urls.push(url);
      }
      if (!urls.length) return orig(...args);
      const text = typeof args[2] === "string" ? args[2].trim() : "";
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
    const [, bump] = React.useReducer((x) => x + 1, 0);
    const [closed, setClosed] = React.useState(false);
    const [full, setFull] = React.useState(false);
    const cat = React.useMemo(getCatalog, []);
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
    const shown = q ? base.filter((i) => i.n.includes(q)) : base;

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
    const emptyMsg = group === "@favs" ? "Mant\u00e9n presionado un sticker o emoji para guardarlo aqu\u00ed"
      : group === "@recents" ? "Aqu\u00ed aparecer\u00e1n los que uses"
      : items.length ? "Sin resultados" : "No se encontraron " + (isSticker ? "stickers" : "emojis") + " en tus servidores";
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
          h(RN.View, { style: { flex: 1 } }),
          chip("Cerrar", false, closePicker, "close")),
        h(RN.TextInput, {
          value: query, onChangeText: setQuery, placeholder: "Buscar...", placeholderTextColor: "#80848e",
          style: { backgroundColor: "#2b2d31", color: "#fff", borderRadius: 8, paddingHorizontal: 12, height: 40, marginBottom: 8 },
        }),
        h(RN.ScrollView, { horizontal: true, showsHorizontalScrollIndicator: false, style: { flexGrow: 0, marginBottom: 8 } },
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
    S.GHList = safe("ghList", () => {
      const m = findByProps("GestureHandlerRootView") ?? findByProps("FlatList", "ScrollView", "Swipeable");
      const L = m?.FlatList;
      return L && (typeof L === "function" || (typeof L === "object" && L.$$typeof)) ? L : null;
    }) ?? null;
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
      "StickerSender v2.6\n" +
      "parcheados: " + (r.patched.join(", ") || "ninguno") + "\n" +
      "no encontrados: " + (r.missing.join(", ") || "ninguno") + "\n" +
      "nombres parecidos: " + (r.similar.slice(0, 60).join(", ") || "ninguno") + "\n" +
      "enum SENDABLE: " + !!enumObj + " | modulos revisados: " + scanned.size + "\n" +
      "sendMessage:" + !!S.MessageActions + " sendStickers:" + !!S.StickerActions +
      " StickersStore:" + !!S.StickersStore + " EmojiStore:" + !!S.EmojiStore +
      " GuildStore:" + !!S.GuildStore + " ActionSheet:" + !!S.ActionSheet + " hojaNativa:" + !!S.NativeSheet + " listaGH:" + !!S.GHList + " scroll:" + cfg("scrollMode") +
      " comandos:" + !!vendetta.commands?.registerCommand + "\n" +
      "sendMessage llamadas: " + state.spy.sendMessage + " | sendStickers llamadas: " + state.spy.sendStickers +
      " | stickers convertidos: " + state.spy.converted + "\n" +
      "ultimo sendMessage: " + (state.spy.last || "ninguno") + "\n" +
      "ultimo resultado propio: " + (state.spy.lastResult || "ninguno") + "\n" +
      "forma de envio usada: " + state.spy.shape + " | intentos fallidos: " + (state.spy.shapeLog || "ninguno") + "\n" +
      "modulos sendMessage: " + (S.msgModules ? S.msgModules.length : 0) + "\n" +
      "llamadas a funciones de sticker: " + (JSON.stringify(state.spy.fnCalls) || "{}") + "\n" +
      "ultimo contenido enviado: " + (state.spy.lastUrl || "ninguno") + "\n" +
      "funciones con 'sticker': " + ([...stickerFns].join(", ") || "ninguna") + "\n" +
      "catalogo: " + (safe("cat", () => { const c = getCatalog(true); return c.stickers.length + " stickers, " + c.emojis.length + " emojis"; }) ?? "error")
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
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      for (const unpatch of patches) safe("unpatch", unpatch);
      patches.length = 0;
    },
  };

  return exports;
})({})
