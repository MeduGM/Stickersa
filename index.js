// StickerSender v1.3: manda stickers y emojis bloqueados como imagen.
// Formato Vendetta/Revenge Classic (IIFE con exports.default).
(function (exports) {
  "use strict";

  const { findByProps, findByStoreName } = vendetta.metro;
  const { before, instead } = vendetta.patcher;

  const TAG = "[StickerSender]";
  const DEFAULTS = {
    stickerSize: 160,      // tamaño normal de un sticker de Discord
    emojiSize: 48,         // tamaño de emoji grande
    maskEmojiLinks: true,  // emoji dentro de texto: [nombre](url) en vez del link crudo
    animatedStickers: true,// false = manda siempre PNG estático
    debugReport: false,    // copiar reporte al portapapeles en cada inicio
  };
  const cfg = (k) => {
    try { const v = vendetta.plugin.storage[k]; if (v !== undefined && v !== null) return v; } catch (_) {}
    return DEFAULTS[k];
  };
  const size = (k) => Math.min(512, Math.max(32, Math.round(Number(cfg(k))) || DEFAULTS[k]));

  const EMOJI_RE = /<(a?):(\w+):(\d+)>/g;
  const patches = [];
  const timers = [];
  const state = { report: { patched: [], missing: [], similar: [] }, notified: false };

  const safe = (label, fn) => {
    try { return fn(); } catch (e) { console.error(TAG, label, "falló:", e); }
  };
  const toast = (msg) => safe("toast", () => vendetta.ui.toasts.showToast(msg));

  // ---------- URLs ----------
  // format_type: 1 PNG, 2 APNG, 3 Lottie, 4 GIF
  function stickerUrl(s) {
    const type = s.format_type ?? s.formatType;
    const base = "https://media.discordapp.net/stickers/" + s.id;
    const sz = size("stickerSize");
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

  // ---------- Desbloqueo de pickers ----------
  // Se buscan en TODOS los módulos cargados (nombre/ubicación cambia entre versiones).
  const UNLOCK = {
    getStickerSendability: "sendability", // devuelve SENDABLE si se conoce el enum
    isSendableSticker: () => true,
    getEmojiUnavailableReason: () => null,
    isEmojiFiltered: () => false,
  };
  // Predicados booleanos tipo canUseEmojisEverywhere, canUseAnimatedEmojis, etc.
  const CAN_USE_RE = /^canUse(Custom|Animated)?(Emojis?|Stickers?)(Everywhere)?$/;
  const NAME_RE = /sendab|unavailablereason|canuse(emoji|sticker|animated|custom)|emojifiltered|premiumlocked/i;

  const patchedPairs = new WeakMap(); // holder -> Set(nombres ya parcheados)
  const scanned = new Set();          // ids de módulos ya revisados
  const seenNames = new Set();
  let enumObj = null;
  const pending = []; // [holder, name] que esperan a que aparezca el enum SENDABLE

  function patchHolder(holder, name, ret) {
    let set = patchedPairs.get(holder);
    if (!set) patchedPairs.set(holder, (set = new Set()));
    if (set.has(name)) return false;
    set.add(name);
    try { patches.push(instead(name, holder, ret)); return true; } catch (_) { return false; }
  }

  // Revisión incremental: solo módulos nuevos desde la última vez.
  // Devuelve cuántos parches nuevos se aplicaron.
  function scanAndPatch() {
    let applied = 0;
    const mods = vendetta.metro.modules ?? globalThis.modules ?? {};
    const found = []; // [holder, name]
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
    const todo = pending.splice(0).concat(found);
    for (const [holder, name] of todo) {
      let ret = UNLOCK[name] ?? (() => true);
      if (ret === "sendability") {
        if (!enumObj) { pending.push([holder, name]); continue; } // se reintenta luego
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

  function reportText(extra) {
    const r = state.report;
    return (
      "StickerSender v1.3\n" +
      "parcheados: " + (r.patched.join(", ") || "ninguno") + "\n" +
      "no encontrados: " + (r.missing.join(", ") || "ninguno") + "\n" +
      "nombres parecidos: " + (r.similar.slice(0, 60).join(", ") || "ninguno") + "\n" +
      "enum SENDABLE: " + !!enumObj + " | módulos revisados: " + scanned.size +
      (extra ? "\n" + extra : "")
    );
  }
  function copyReport(extra) {
    const text = reportText(extra);
    console.log(TAG, text);
    safe("clipboard", () => vendetta.metro.common.clipboard.setString(text));
    return text;
  }

  // ---------- Ajustes (pantalla del plugin) ----------
  function Settings() {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const Forms = vendetta.ui.components?.Forms;
    const [, force] = React.useReducer((x) => x + 1, 0);
    const st = vendetta.plugin.storage;
    const set = (k, v) => { st[k] = v; force(); };
    const h = React.createElement;
    if (!Forms) return h(RN.Text, { style: { color: "#fff", padding: 16 } }, "Ajustes no disponibles en esta versión.");
    const { FormSection, FormSwitchRow, FormRow, FormInput } = Forms;
    const num = (k, title) =>
      h(FormInput, {
        title,
        value: String(cfg(k)),
        keyboardType: "numeric",
        onChange: (t) => { const n = parseInt(t, 10); if (n) set(k, n); },
      });
    const sw = (k, label, sub) =>
      h(FormSwitchRow, { label, subLabel: sub, value: !!cfg(k), onValueChange: (v) => set(k, v) });
    return h(RN.ScrollView, null,
      h(FormSection, { title: "Tamaños (32 a 512)" },
        num("stickerSize", "Sticker (normal: 160)"),
        num("emojiSize", "Emoji (normal: 48)")),
      h(FormSection, { title: "Opciones" },
        sw("animatedStickers", "Animados", "Apagado = siempre imagen estática"),
        sw("maskEmojiLinks", "Ocultar link de emoji", "Muestra [nombre] en vez del link"),
        sw("debugReport", "Copiar reporte al iniciar", "Para diagnosticar parches")),
      h(FormSection, { title: "Diagnóstico" },
        h(FormRow, {
          label: "Copiar reporte ahora",
          subLabel: "Rescan: " + scanned.size + " módulos revisados",
          onPress: () => { scanAndPatch(); copyReport(); toast("Reporte copiado"); },
        })));
  }

  // ---------- Plugin ----------
  exports.default = {
    settings: Settings,

    onLoad() {
      const MessageActions = findByProps("editMessage", "sendMessage");
      const StickerActions = findByProps("sendStickers");
      const StickersStore = findByStoreName("StickersStore");
      const EmojiStore = findByStoreName("EmojiStore");
      const ChannelStore = findByStoreName("ChannelStore");
      const UserStore = findByStoreName("UserStore");
      const PendingReplyStore = findByStoreName("PendingReplyStore");
      const FluxDispatcher = safe("flux", () => vendetta.metro.common.FluxDispatcher);

      const hasNitro = () => !!UserStore?.getCurrentUser?.()?.premiumType;
      const channelGuild = (channelId) => ChannelStore?.getChannel?.(channelId)?.guild_id;

      // Si estás respondiendo a un mensaje, mantiene la respuesta al mandar el sticker
      function pendingReply(channelId) {
        return safe("reply", () => {
          const p = PendingReplyStore?.getPendingReply?.(channelId);
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
            clear: () => FluxDispatcher?.dispatch?.({ type: "DELETE_PENDING_REPLY", channelId }),
          };
        });
      }

      // 0) Desbloquear pickers: primera pasada + reintentos (módulos que cargan tarde)
      safe("desbloqueo", () => {
        scanAndPatch();
        const id = setInterval(() => {
          safe("rescan", () => {
            const n = scanAndPatch();
            if (n) toast("StickerSender: +" + n + " parches nuevos");
          });
        }, 5000);
        timers.push(id);
      });

      // 1) Stickers -> link de imagen
      safe("stickers", () => {
        if (!StickerActions || !StickersStore || !MessageActions) {
          console.log(TAG, "faltan módulos de stickers", {
            StickerActions: !!StickerActions, StickersStore: !!StickersStore, MessageActions: !!MessageActions,
          });
          return;
        }
        patches.push(
          instead("sendStickers", StickerActions, (args, orig) => {
            const [channelId, rawIds, content] = args;
            if (hasNitro()) return orig(...args);

            const urls = [];
            let needsOrig = false;
            for (const id of [].concat(rawIds)) {
              const s = StickersStore.getStickerById(id);
              if (!s) { needsOrig = true; break; }
              // Sticker del mismo servidor: el envío normal funciona y se ve mejor
              if (s.guild_id && s.guild_id === channelGuild(channelId) && s.available !== false) {
                needsOrig = true; break;
              }
              const url = stickerUrl(s);
              if (!url) { toast("Los stickers Lottie no se pueden mandar como imagen"); return; }
              urls.push(url);
            }
            if (needsOrig) return orig(...args);

            const text = typeof content === "string" ? content.trim() : "";
            const reply = pendingReply(channelId);
            const res = MessageActions.sendMessage(
              channelId,
              {
                content: (text ? text + "\n" : "") + urls.join("\n"),
                invalidEmojis: [],
                tts: false,
                validNonShortcutEmojis: [],
              },
              undefined,
              reply ? reply.extra : undefined
            );
            if (reply) safe("clear reply", reply.clear);
            return res;
          })
        );
      });

      // 2) Emojis bloqueados -> link de imagen (solo los que no puedes usar)
      safe("emojis", () => {
        if (!MessageActions) return;
        patches.push(
          before("sendMessage", MessageActions, (args) => {
            const [channelId, msg] = args;
            if (!msg || typeof msg.content !== "string" || !msg.content.includes("<")) return;
            if (hasNitro()) return;

            const gid = channelGuild(channelId);
            const isUsable = (id, animated) => {
              const e = EmojiStore?.getCustomEmojiById?.(id);
              return !!e && !animated && e.available !== false && e.guildId === gid;
            };

            // ¿Solo emojis? -> links crudos separados (Discord oculta el texto y muestra la imagen)
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

      // 3) Aviso + reporte (se copia solo si algo importante no se encontró o si está activado)
      safe("reporte", () => {
        const r = state.report;
        const core = r.patched.includes("getStickerSendability") && r.patched.includes("getEmojiUnavailableReason");
        toast("StickerSender: " + r.patched.length + " parches" + (core ? "" : " (faltan, ver reporte)"));
        if (cfg("debugReport") || !core) copyReport();
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
})({});
