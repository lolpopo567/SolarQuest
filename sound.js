/* Solar Quest sound: music loops, ambience and effects (files in web/sound/, made by scripts/sync_sound.py from the
   SolarQuest_sound Drive folder). Web Audio, so loops are seamless and volume fades work on iPhone and iPad too.
   Browsers only allow sound after the player's first tap or key press: until then the context waits, and whatever
   should be playing starts on that first tap. Missing files stay silent. Settings → Sound turns everything off. */
"use strict";

const Snd = (() => {
  const FILES = {
    theme: "sound/home-page-theme.mp3",     // title screen (loops)
    office: "sound/office-walk.mp3",        // the agency in the morning: outside and at the desk (loops)
    walk: "sound/walk.mp3",                 // walking home to the house (loops while the house is shown)
    door_open: "sound/wood-door-open.mp3",  // the front door opens
    door_close: "sound/door-close-lock.mp3",// inside: the door closes and locks behind the player
    tv_on: "sound/tv-on.mp3",
    tv_off: "sound/tv-off.mp3",
    news: "sound/news.mp3",                 // the evening news theme (loops under the newscast)
    click: "sound/ui-click.mp3",            // every button
    dialog: "sound/dialog.mp3",             // typing chatter: loops while a dialogue line types out (own channel)
  };
  const KEY = "sq_sound";
  let on = true, ctx = null, master = null, music = null, wanted = null;
  try { on = localStorage.getItem(KEY) !== "off"; } catch { /* private mode */ }
  const buffers = {};

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = on ? 1 : 0;
    master.connect(ctx.destination);
    return ctx;
  }
  function load(name) {                                   // decoded once, kept (the service worker caches the file)
    if (!buffers[name]) buffers[name] = fetch(FILES[name])
      .then((r) => { if (!r.ok) throw new Error(name); return r.arrayBuffer(); })
      .then((a) => new Promise((ok, no) => ctx.decodeAudioData(a, ok, no)))   // callback form: older Safari
      .catch(() => null);
    return buffers[name];
  }
  function source(buf, vol, loop) {
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; s.loop = loop; g.gain.value = vol;
    s.connect(g); g.connect(master);
    return { s, g };
  }
  /* a one-shot effect; resolves when it has finished (or at once if there is no sound) */
  async function play(name, vol = 1) {
    if (!init()) return;
    const buf = await load(name);
    if (!buf) return;
    const { s } = source(buf, vol, false);
    s.start();
    return new Promise((r) => { s.onended = r; });
  }
  /* volumes are set where each sound is used (app.js), balanced from their measured loudness: the news jingle is
     much louder than the room sounds, so it plays at about a quarter */
  /* the one looping track (music or ambience): fades out whatever loops now, fades this in */
  async function loop(name, vol = 0.6, fade = 1.2) {
    if (wanted === name) return;
    wanted = name;
    if (!init()) return;
    stop(fade);
    wanted = name;
    const buf = await load(name);
    if (!buf || wanted !== name) return;                  // replaced while it was loading
    const m = source(buf, 0, true);
    m.g.gain.setValueAtTime(0, ctx.currentTime);
    m.g.gain.linearRampToValueAtTime(vol, ctx.currentTime + fade);
    m.s.start();
    music = { name, ...m };
  }
  function stop(fade = 1) {
    wanted = null;
    if (!music || !ctx) return;
    const m = music; music = null;
    m.g.gain.cancelScheduledValues(ctx.currentTime);
    m.g.gain.setValueAtTime(m.g.gain.value, ctx.currentTime);
    m.g.gain.linearRampToValueAtTime(0, ctx.currentTime + fade);
    setTimeout(() => { try { m.s.stop(); } catch { /* already stopped */ } }, fade * 1000 + 100);
  }
  /* the dialogue chatter: its own loop beside the music, on while a line types out, cut short when it ends */
  let chat = null, chatWanted = false;
  async function typing(v, vol = 0.8) {
    chatWanted = v;
    if (!v) {
      if (chat && ctx) {
        const c = chat; chat = null;
        c.g.gain.cancelScheduledValues(ctx.currentTime);
        c.g.gain.setValueAtTime(c.g.gain.value, ctx.currentTime);
        c.g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.06);
        setTimeout(() => { try { c.s.stop(); } catch { /* already stopped */ } }, 120);
      }
      return;
    }
    if (chat || !init()) return;
    const buf = await load("dialog");
    if (!buf || !chatWanted || chat) return;              // the line finished while the file was loading
    chat = source(buf, vol, true);
    chat.s.start(0, Math.random() * buf.duration);        // a random start, so lines do not all open the same way
  }
  function setOn(v) {
    on = v;
    try { localStorage.setItem(KEY, v ? "on" : "off"); } catch { /* private mode */ }
    if (master) master.gain.setTargetAtTime(v ? 1 : 0, ctx.currentTime, 0.05);
  }
  // first tap / key: let the browser start the sound, then fetch every file so the game also sounds right offline
  let warmed = false;
  const unlock = () => {
    if (!init()) return;
    if (ctx.state === "suspended") ctx.resume();
    if (!warmed) { warmed = true; Object.keys(FILES).forEach(load); }
  };
  addEventListener("pointerdown", unlock, true);
  addEventListener("keydown", unlock, true);
  // every button clicks (dialogue taps do not: they are not buttons)
  addEventListener("click", (e) => { if (e.target.closest && e.target.closest("button")) play("click", 1); }, true);

  return { play, loop, stop, typing, setOn, get on() { return on; }, get playing() { return music ? music.name : null; } };
})();
