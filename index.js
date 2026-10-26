// StickerSender v1.1: manda stickers y emojis bloqueados como imagen.
// Formato Vendetta/Revenge Classic (IIFE con exports.default).
(function (exports) {
  "use strict";

  const { findByProps, findByStoreName } = vendetta.metro;
  const { before, instead } = vendetta.patcher;

  const CONFIG = {
    stickerSize: 160, // tamaño normal de un sticker de Discord
    emojiSize: 48,    // tamaño de emoji grande
    maskEmojiLinks: true, // emoji dentro de texto: [nombre](url) en vez del link crudo
  };

  // format_type de stickers: 1 PNG, 2 APNG, 3 Lottie, 4 GIF
  const EMOJI_RE = /<(a?):(\w+):(\d+)>/g;
  const patches = [];

  const TAG = "[StickerSender]";
  const safe = (label, fn) => {
    try { fn(); } catch (e) { console.error(TAG, label, "falló:", e); }
  };
  const toast = (msg) => {
    try { vendetta.ui.toasts.showToast(msg); } catch (_) {}
  };

  function stickerUrl(s) {
    const type = s.format_type ?? s.formatType;
    const base = "https://media.discordapp.net/stickers/" + s.id;
    if (type === 3) return null; // Lottie: no existe como imagen
    if (type === 4) return base + ".gif?size=" + CONFIG.stickerSize;
    if (type === 2) return base + ".png?size=" + CONFIG.stickerSize + "&passthrough=true";
    return base + ".png?size=" + CONFIG.stickerSize;
  }

  function emojiUrl(id, animated) {
    return (
      "https://cdn.discordapp.com/emojis/" + id +
      (animated ? ".gif" : ".webp") +
      "?size=" + CONFIG.emojiSize + "&quality=lossless"
    );
  }

  exports.default = {
    onLoad() {
      const MessageActions = findByProps("editMessage", "sendMessage");
      const StickerActions = findByProps("sendStickers");
      const StickersStore = findByStoreName("StickersStore");
      const EmojiStore = findByStoreName("EmojiStore");
      const ChannelStore = findByStoreName("ChannelStore");
      const UserStore = findByStoreName("UserStore");

      const hasNitro = () => !!UserStore?.getCurrentUser?.()?.premiumType;
      const channelGuild = (channelId) => ChannelStore?.getChannel?.(channelId)?.guild_id;

      // 0) Desbloquear pickers (nombres tomados de FakeNitro de Vencord; en móvil pueden variar)
      safe("desbloqueo", () => {
        for (const fn of ["canUseEmojisEverywhere", "canUseAnimatedEmojis", "canUseStickersEverywhere"]) {
          const mod = findByProps(fn);
          if (mod && typeof mod[fn] === "function") {
            patches.push(instead(fn, mod, () => true));
            console.log(TAG, "desbloqueado:", fn);
          } else {
            console.log(TAG, "no encontrado:", fn);
          }
        }
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
            const [channelId, stickerIds, content] = args;
            if (hasNitro()) return orig(...args);

            const urls = [];
            let needsOrig = false;
            for (const id of stickerIds) {
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
            return MessageActions.sendMessage(channelId, {
              content: (text ? text + "\n" : "") + urls.join("\n"),
              invalidEmojis: [],
              tts: false,
              validNonShortcutEmojis: [],
            });
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

            // ¿El mensaje es solo emojis? -> links crudos (Discord oculta el texto y muestra la imagen)
            const onlyEmojis = msg.content.replace(EMOJI_RE, "").trim() === "";
            msg.content = msg.content.replace(EMOJI_RE, (m, a, name, id) => {
              const animated = a === "a";
              if (isUsable(id, animated)) return m;
              const url = emojiUrl(id, animated);
              if (onlyEmojis) return url + "\n";
              return CONFIG.maskEmojiLinks ? "[" + name + "](" + url + ")" : url;
            });
            if (onlyEmojis) msg.content = msg.content.trim();
            msg.validNonShortcutEmojis = [];
            msg.invalidEmojis = [];
          })
        );
      });
    },

    onUnload() {
      for (const unpatch of patches) safe("unpatch", unpatch);
      patches.length = 0;
    },
  };

  return exports;
})({});
