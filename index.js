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
  const state = { report: { patched: [], missing: [], similar: [] } };

  const safe = (label, fn) => {
    try { return fn(); } catch (e) { console.error(TAG, label, "fallo:", e); }
  };
  const toast = (msg) => safe("toast", () => vendetta.ui.toasts.showToast(msg));
  const fmt = (s) => s.format_type ?? s.formatType;

  // ---------- URLs ----------
  // format_type: 1 PNG, 2 APNG, 3 Lottie, 4 GIF
  function stickerUrl(s) {
    const base = "https://media.discordapp.net/stickers/" + s.id;
    const sz = size("stickerSize");
    const type = fmt(s);
    if (type === 3) return null; // Lottie: no existe como imagen
    if (type === 4 && cfg("animatedStickers")) return base + ".gif?size=" + sz;
    if (type === 2 && cfg("animatedStickers")) return base + ".png?size=" + sz + "&passthrough=true";
    return base + ".png?size=" + sz + "&passthrough=false";
  }
  function emojiUrl(id, animated) {
    return (
      "https://cdn.discordapp.com/emojis/" + id +
      (animated && cfg("animatedStickers") ? ".gif" : ".webp") +
      "?size=" + size("emojiSize") + "&quality=lossless"
    );
  }
  const previewUrl = (it) =>
    it.kind === "sticker"
      ? "https://media.discordapp.net/stickers/" + it.id + ".png?size=96&passthrough=false"
      : "https://cdn.discordapp.com/emojis/" + it.id + ".webp?size=64&quality=lossless";

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
  function sendContent(channelId, content) {
    if (!channelId) channelId = S.SelectedChannelStore?.getChannelId?.();
    if (!channelId || !S.MessageActions) { toast("No hay canal abierto"); return; }
    const reply = pendingReply(channelId);
    const res = S.MessageActions.sendMessage(
      channelId,
      { content, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] },
      undefined,
      reply ? reply.extra : undefined
    );
    if (reply) safe("clear reply", reply.clear);
    return res;
  }

  // ---------- Catalogo propio (stickers y emojis de todos tus servidores) ----------
  function buildCatalog() {
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
            stickers.push({ kind: "sticker", id: s.id, name: s.name ?? "", group: gname(gid), raw: s });
          }
      }
      for (const pack of S.StickersStore?.getPremiumPacks?.() ?? [])
        for (const s of pack.stickers ?? []) {
          if (fmt(s) === 3) continue;
          stickers.push({ kind: "sticker", id: s.id, name: s.name ?? "", group: pack.name ?? "Discord", raw: s });
        }
    });

    safe("emojis", () => {
      for (const gid of Object.keys(guilds))
        for (const e of S.EmojiStore?.getGuildEmoji?.(gid) ?? [])
          emojis.push({ kind: "emoji", id: e.id, name: e.name ?? "", animated: !!e.animated, group: gname(gid) });
    });

    const uniq = (list) => [...new Set(list.map((i) => i.group))].sort((a, b) => a.localeCompare(b));
    return { stickers, emojis, stickerGroups: uniq(stickers), emojiGroups: uniq(emojis) };
  }

  function pickItem(item, channelId) {
    const url = item.kind === "sticker" ? stickerUrl(item.raw) : emojiUrl(item.id, item.animated);
    if (!url) { toast("Ese sticker no se puede mandar como imagen"); return; }
    safe("hide", () => S.ActionSheet?.hideActionSheet?.());
    sendContent(channelId, url);
  }

  // ---------- Selector (hoja inferior) ----------
  function Picker(props) {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const h = React.createElement;
    const [tab, setTab] = React.useState(props.tab || "sticker");
    const [query, setQuery] = React.useState(props.query || "");
    const [group, setGroup] = React.useState("*");
    const cat = React.useMemo(buildCatalog, []);

    const isSticker = tab === "sticker";
    const items = isSticker ? cat.stickers : cat.emojis;
    const groups = isSticker ? cat.stickerGroups : cat.emojiGroups;
    const q = query.trim().toLowerCase();
    const shown = items.filter(
      (i) => (group === "*" || i.group === group) && (!q || i.name.toLowerCase().includes(q))
    );

    const chip = (label, active, onPress, key) =>
      h(RN.Pressable, {
        key, onPress,
        style: {
          paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, marginRight: 6,
          backgroundColor: active ? "#5865f2" : "#2b2d31",
        },
      }, h(RN.Text, { style: { color: "#fff", fontSize: 13 } }, label));

    return h(RN.View, {
      style: {
        height: RN.Dimensions.get("window").height * 0.72,
        backgroundColor: "#1e1f22",
        borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 12,
      },
    },
      h(RN.View, { style: { flexDirection: "row", marginBottom: 8 } },
        chip("Stickers", isSticker, () => { setTab("sticker"); setGroup("*"); }, "t1"),
        chip("Emojis", !isSticker, () => { setTab("emoji"); setGroup("*"); }, "t2")),
      h(RN.TextInput, {
        value: query, onChangeText: setQuery, placeholder: "Buscar...", placeholderTextColor: "#80848e",
        style: { backgroundColor: "#2b2d31", color: "#fff", borderRadius: 8, paddingHorizontal: 12, height: 40, marginBottom: 8 },
      }),
      h(RN.ScrollView, { horizontal: true, showsHorizontalScrollIndicator: false, style: { flexGrow: 0, marginBottom: 8 } },
        chip("Todos", group === "*", () => setGroup("*"), "*"),
        ...groups.map((g) => chip(g, group === g, () => setGroup(g), g))),
      shown.length
        ? h(RN.FlatList, {
            data: shown, numColumns: 4, keyExtractor: (i) => i.kind + i.id,
            initialNumToRender: 24, windowSize: 5, removeClippedSubviews: true,
            keyboardShouldPersistTaps: "handled",
            renderItem: ({ item }) =>
              h(RN.Pressable, {
                onPress: () => pickItem(item, props.channelId),
                style: { width: "25%", alignItems: "center", padding: 4 },
              },
                h(RN.Image, { source: { uri: previewUrl(item) }, style: { width: 64, height: 64 }, resizeMode: "contain" }),
                h(RN.Text, { numberOfLines: 1, style: { color: "#b5bac1", fontSize: 10, marginTop: 2 } }, item.name)),
          })
        : h(RN.Text, { style: { color: "#b5bac1", textAlign: "center", marginTop: 24 } },
            items.length ? "Sin resultados" : "No se encontraron " + (isSticker ? "stickers" : "emojis") + " en tus servidores"));
  }

  function openPicker(opts) {
    const { React } = vendetta.metro.common;
    const channelId = opts.channelId ?? S.SelectedChannelStore?.getChannelId?.();
    const comp = () => React.createElement(Picker, { ...opts, channelId });
    if (S.ActionSheet?.openLazy)
      return S.ActionSheet.openLazy(Promise.resolve({ default: comp }), "StickerSenderPicker", {});
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
            if ((k in UNLOCK || CAN_USE_RE.test(k)) && typeof holder[k] === "function") found.push([holder, k]);
          }
        }
      } catch (_) {}
    }
    const r = state.report;
    for (const [holder, name] of pending.splice(0).concat(found)) {
      let ret = UNLOCK[name] ?? (() => true);
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
      "StickerSender v2.0\n" +
      "parcheados: " + (r.patched.join(", ") || "ninguno") + "\n" +
      "no encontrados: " + (r.missing.join(", ") || "ninguno") + "\n" +
      "nombres parecidos: " + (r.similar.slice(0, 60).join(", ") || "ninguno") + "\n" +
      "enum SENDABLE: " + !!enumObj + " | modulos revisados: " + scanned.size + "\n" +
      "sendMessage:" + !!S.MessageActions + " sendStickers:" + !!S.StickerActions +
      " StickersStore:" + !!S.StickersStore + " EmojiStore:" + !!S.EmojiStore +
      " GuildStore:" + !!S.GuildStore + " ActionSheet:" + !!S.ActionSheet +
      " comandos:" + !!vendetta.commands?.registerCommand
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
        sw("maskEmojiLinks", "Ocultar link de emoji", "Muestra [nombre] en vez del link"),
        sw("nativeUnlock", "Desbloquear selectores nativos", "Extra; requiere reiniciar el plugin"),
        sw("debugReport", "Copiar reporte al iniciar", "Para diagnosticar")),
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
      S.MessageActions = findByProps("editMessage", "sendMessage");
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

      const hasNitro = () => !!S.UserStore?.getCurrentUser?.()?.premiumType;
      const channelGuild = (channelId) => S.ChannelStore?.getChannel?.(channelId)?.guild_id;

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
            const q = String(arg(args, "nombre") ?? "").trim().toLowerCase();
            if (q) {
              const all = buildCatalog().stickers;
              const exact = all.filter((s) => s.name.toLowerCase() === q);
              const part = all.filter((s) => s.name.toLowerCase().includes(q));
              const one = exact.length === 1 ? exact[0] : part.length === 1 ? part[0] : null;
              if (one) { pickItem(one, channelId); return; }
            }
            openPicker({ tab: "sticker", query: q, channelId });
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
        patches.push(
          instead("sendStickers", S.StickerActions, (args, orig) => {
            const [channelId, rawIds, content] = args;
            if (hasNitro()) return orig(...args);

            const urls = [];
            let needsOrig = false;
            for (const id of [].concat(rawIds)) {
              const s = S.StickersStore.getStickerById(id);
              if (!s) { needsOrig = true; break; }
              // Sticker del mismo servidor: el envio normal funciona y se ve mejor
              if (s.guild_id && s.guild_id === channelGuild(channelId) && s.available !== false) {
                needsOrig = true; break;
              }
              const url = stickerUrl(s);
              if (!url) { toast("Los stickers Lottie no se pueden mandar como imagen"); return; }
              urls.push(url);
            }
            if (needsOrig) return orig(...args);
            const text = typeof content === "string" ? content.trim() : "";
            return sendContent(channelId, (text ? text + "\n" : "") + urls.join("\n"));
          })
        );
      });

      // 3) Emojis bloqueados en el texto -> link de imagen (solo los que no puedes usar)
      safe("emojis", () => {
        if (!S.MessageActions) return;
        patches.push(
          before("sendMessage", S.MessageActions, (args) => {
            const [channelId, msg] = args;
            if (!msg || typeof msg.content !== "string" || !msg.content.includes("<")) return;
            if (hasNitro()) return;

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
