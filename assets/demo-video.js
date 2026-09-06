/* =========================================================
   Fynd — the demo video on the landing page

   The video is markup first: it has its poster, its sources, its
   captions and the player's own controls, so with this file blocked or
   broken the section still shows a still frame and still plays when
   somebody presses play. Which of the two recordings it holds is
   settled in index.html, next to the element, because that decision has
   to be made while the page is being parsed. Everything here is about
   not spending anybody's bytes or battery on a video they have not
   looked at yet.

   Three rules, in order:

     1. Nothing is fetched until the page has finished loading and the
        section is close to the viewport. The markup says preload="none",
        so the browser holds off on its own; this only decides when to
        stop holding off, and it waits for the load event first so that
        close to a megabyte of video is never in front of the stylesheet
        and the scripts the page needs to work at all.

     2. It starts itself only where that is both allowed and wanted.
        Muted autoplay is permitted by most browsers and refused by
        some, and `play()` reports which by rejecting — so the refusal
        is the signal to show the play button rather than something to
        predict. Two readings are taken before even trying: a reader who
        asked for less motion, and a connection asking for fewer bytes.
        Both mean the button, not the autoplay.

     3. It stops when it is not being watched. The video loops, and a
        loop running under a page nobody is looking at is a cost with no
        reader. Scrolling away pauses it; scrolling back resumes it —
        until the reader pauses it themselves, which ends the page's
        say in the matter for good.
   ========================================================= */

(function () {
  'use strict';

  const video = document.getElementById('demo-video');
  const button = document.getElementById('demo-play');
  if (!video || !button || !('IntersectionObserver' in window)) return;

  /* Reasons not to start it without being asked. Both are the reader's
     own settings, so neither is second-guessed. */
  function stillPreferred() {
    const motion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion && motion.matches) return true;
    const link = navigator.connection;
    return Boolean(link && link.saveData);
  }

  /* decided  the first look at the section has happened
     driving  the page may start and stop it as it scrolls past
     theirs   the reader paused it; the page does not touch it again
     pausing  the page is the one pausing right now, so the pause
              handler can tell a scroll from a press */
  let decided = false;
  let driving = false;
  let theirs = false;
  let pausing = false;

  const showButton = () => { button.hidden = false; };

  function start() {
    /* muted is what makes an unprompted play permissible at all, and it
       is in the markup; setting it here means a play cannot be refused
       because something else cleared it */
    video.muted = true;
    const started = video.play();
    if (started && typeof started.catch === 'function') {
      started.catch(() => { driving = false; showButton(); });
    }
  }

  button.addEventListener('click', () => {
    button.hidden = true;
    driving = true;
    theirs = false;
    start();
  });

  video.addEventListener('play', () => { button.hidden = true; });

  /* The player's own controls are the accessible path, and using them is
     the reader taking over. A pause this file did not ask for is theirs. */
  video.addEventListener('pause', () => { if (!pausing) theirs = true; });

  const watcher = new IntersectionObserver((entries) => {
    const showing = entries.some((entry) => entry.isIntersecting);

    if (!decided) {
      if (!showing) return;
      decided = true;
      if (stillPreferred()) { showButton(); return; }
      driving = true;
      start();
      return;
    }

    if (!driving || theirs) return;

    if (showing) {
      if (video.paused) start();
    } else if (!video.paused) {
      pausing = true;
      video.pause();
      pausing = false;
    }
  }, { rootMargin: '200px 0px' });

  /* The section sits just under the fold, so on a wide screen it is
     already within reach of the observer while the page is still
     loading. Waiting for the load event keeps close to a megabyte of
     video out of the way of the stylesheet, the font and the scripts
     that the page actually needs to work. */
  const watch = () => watcher.observe(video);
  if (document.readyState === 'complete') watch();
  else window.addEventListener('load', watch, { once: true });
})();
