/**
 * VideoVault — app.js
 * Playlist manager + HLS/MP4 player + download engine
 */

'use strict';

/* ─── Constants ───────────────────────────────────────────────────── */
const STORAGE_KEY = 'videovault_playlist_v2';

const SPOTLIGHTR_WATCH   = /videos\.cdn\.spotlightr\.com\/watch\/([A-Za-z0-9+/=]+)/;
const SPOTLIGHTR_EMBED   = /spotlightr\.com\/v\/([A-Za-z0-9]+)/;
const HLS_URL            = /\.m3u8(\?|$)/i;
const DIRECT_VIDEO       = /\.(mp4|webm|ogg|mov|mkv)(\?|$)/i;

/* ─── State ───────────────────────────────────────────────────────── */
let playlist       = [];
let currentIndex   = -1;
let hls            = null;
let isDragging     = false;
let controlsTimer  = null;
let mediaRecorder  = null;
let recChunks      = [];
let recSize        = 0;
let currentVideoMeta = null;  // { url, srcUrl, type, title }

/* ─── DOM refs ────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const dom = {
  urlInput:        $('url-input'),
  titleInput:      $('title-input'),
  addBtn:          $('add-btn'),
  playlist:        $('playlist'),
  emptyState:      $('empty-state'),
  playlistCount:   $('playlist-count'),
  clearBtn:        $('clear-btn'),
  shuffleBtn:      $('shuffle-btn'),
  sidebarToggle:   $('sidebar-toggle'),
  sidebar:         document.querySelector('.sidebar'),
  playerContainer: $('player-container'),
  video:           $('video'),
  iframePlayer:    $('iframe-player'),
  idleScreen:      $('idle-screen'),
  loadingOverlay:  $('loading-overlay'),
  errorOverlay:    $('error-overlay'),
  errorMsg:        $('error-msg'),
  bigPlayOverlay:  $('big-play-overlay'),
  bigPlayIcon:     $('big-play-icon'),
  controls:        $('controls'),
  progressWrap:    $('progress-wrap'),
  progressFill:    $('progress-fill'),
  progressBuffered:$('progress-buffered'),
  progressThumb:   $('progress-thumb'),
  timeTooltip:     $('time-tooltip'),
  prevBtn:         $('prev-btn'),
  playBtn:         $('play-btn'),
  nextBtn:         $('next-btn'),
  playIcon:        $('play-icon'),
  pauseIcon:       $('pause-icon'),
  muteBtn:         $('mute-btn'),
  volIcon:         $('vol-icon'),
  muteIcon:        $('mute-icon'),
  volSlider:       $('vol-slider'),
  currentTime:     $('current-time'),
  duration:        $('duration'),
  speedBtn:        $('speed-btn'),
  speedMenu:       $('speed-menu'),
  downloadBtn:     $('download-btn'),
  downloadMenu:    $('download-menu'),
  dlDirect:        $('dl-direct'),
  dlRecord:        $('dl-record'),
  dlCmd:           $('dl-cmd'),
  dlCopyCmd:       $('dl-copy-cmd'),
  fsBtn:           $('fs-btn'),
  fsIcon:          $('fs-icon'),
  fsExitIcon:      $('fs-exit-icon'),
  nowPlaying:      $('now-playing'),
  npTitle:         $('np-title'),
  npType:          $('np-type'),
  recToast:        $('rec-toast'),
  recLabel:        $('rec-label'),
  recSize:         $('rec-size'),
  recStop:         $('rec-stop'),
  bulkModal:       $('bulk-modal'),
  bulkInput:       $('bulk-input'),
  showBulkBtn:     $('show-bulk-btn'),
  closeBulkBtn:    $('close-bulk-btn'),
  importBtn:       $('import-btn'),
  bkModal:          $('bookmarklet-modal'),
  showBkModal:     $('show-bk-modal'),
  closeBkBtn:      $('close-bk-btn'),
  doneBkBtn:       $('done-bk-btn'),
  customSpeed:     $('custom-speed'),
  setCustomSpeed:  $('set-custom-speed'),
  customSpeedModal: $('custom-speed-modal'),
  setCustomSpeedModal: $('set-custom-speed-modal'),
  showSpeedBtnSide: $('show-speed-btn-side'),
  extSpeedMinus:   $('ext-speed-minus'),
  extSpeedPlus:    $('ext-speed-plus'),
  extSpeedReset:   $('ext-speed-reset'),
  extSpeedDisplay: $('ext-speed-display'),
  extSpeedSlider:  $('ext-speed-slider'),
  npLink:          $('np-link'),
  toast:           $('toast'),
};

/* ─── Utility ─────────────────────────────────────────────────────── */
function formatTime(s) {
  if (isNaN(s) || !isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
}

let toastTimer = null;
function showToast(msg, duration = 3000) {
  dom.toast.textContent = msg;
  dom.toast.removeAttribute('hidden');
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove('show');
    setTimeout(() => dom.toast.setAttribute('hidden',''), 300);
  }, duration);
}

function showError(msg) {
  dom.errorOverlay.style.display = 'flex';
  dom.errorMsg.textContent = msg || 'Could not load video.';
  dom.loadingOverlay.setAttribute('hidden', '');
}

function hideError() {
  dom.errorOverlay.style.display = 'none';
}

/* ─── URL Detection ───────────────────────────────────────────────── */
function detectType(url) {
  if (SPOTLIGHTR_WATCH.test(url) || SPOTLIGHTR_EMBED.test(url)) return 'spotlightr';
  if (HLS_URL.test(url)) return 'hls';
  if (DIRECT_VIDEO.test(url)) return 'mp4';
  // Treat unknown URLs as direct (try playing them)
  return 'direct';
}

function getDisplayTitle(url, userTitle) {
  if (userTitle && userTitle.trim()) return userTitle.trim();
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || u.hostname;
    return decodeURIComponent(last).replace(/\.[^.]+$/, '') || url;
  } catch { return url; }
}

function typeBadge(type) {
  if (type === 'spotlightr') return { cls: 'spot', label: 'SPOT' };
  if (type === 'hls') return { cls: 'hls', label: 'HLS' };
  return { cls: 'mp4', label: 'MP4' };
}

/* ─── Playlist Manager ────────────────────────────────────────────── */
function savePersist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));
}

function loadPersist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) playlist = JSON.parse(raw);
  } catch { playlist = []; }
}

function renderPlaylist() {
  const items = dom.playlist.querySelectorAll('.playlist-item');
  items.forEach(el => el.remove());

  dom.emptyState.style.display = playlist.length ? 'none' : 'flex';
  dom.playlistCount.textContent = `${playlist.length} video${playlist.length !== 1 ? 's' : ''}`;

  playlist.forEach((item, i) => {
    const badge = typeBadge(item.type);
    const el = document.createElement('div');
    el.className = 'playlist-item' + (i === currentIndex ? ' active' : '');
    el.setAttribute('role', 'listitem');
    el.dataset.index = i;
    el.innerHTML = `
      <div class="item-index">${i + 1}</div>
      <div class="item-icon">${badge.cls === 'hls' ? '📡' : badge.cls === 'spot' ? '🎓' : '🎬'}</div>
      <div class="item-info">
        <div class="item-title">${escHtml(item.title)}</div>
        <div class="item-url">${escHtml(item.url)}</div>
      </div>
      <span class="item-badge ${badge.cls}">${badge.label}</span>
      <button class="item-del" data-del="${i}" title="Remove" aria-label="Remove video">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.item-del')) return;
      loadAndPlay(parseInt(el.dataset.index));
    });
    el.querySelector('.item-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeItem(parseInt(e.currentTarget.dataset.del));
    });
    dom.playlist.appendChild(el);
  });
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function addItem(url, userTitle = '', suppressToast = false) {
  url = url.trim();
  if (!url) { if (!suppressToast) showToast('Please enter a URL'); return false; }
  try { new URL(url); } catch { if (!suppressToast) showToast('Invalid URL — please include https://'); return false; }

  const type = detectType(url);
  const title = getDisplayTitle(url, userTitle);
  playlist.push({ url, title, type });
  savePersist();
  renderPlaylist();
  if (!suppressToast) showToast(`Added: ${title}`);

  // Auto-play first added if not already playing
  if (playlist.length === 1 && currentIndex === -1) loadAndPlay(0);
  return true;
}

function removeItem(i) {
  playlist.splice(i, 1);
  if (currentIndex === i) {
    stopPlayer();
    currentIndex = -1;
  } else if (currentIndex > i) {
    currentIndex--;
  }
  savePersist();
  renderPlaylist();
}

dom.addBtn.addEventListener('click', () => {
  addItem(dom.urlInput.value, dom.titleInput.value);
  dom.urlInput.value = '';
  dom.titleInput.value = '';
});

dom.urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') dom.addBtn.click();
});

dom.clearBtn.addEventListener('click', () => {
  if (!playlist.length) return;
  stopPlayer();
  playlist = [];
  currentIndex = -1;
  savePersist();
  renderPlaylist();
  showToast('Playlist cleared');
});

dom.shuffleBtn.addEventListener('click', () => {
  if (playlist.length < 2) return;
  for (let i = playlist.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
  }
  currentIndex = -1;
  savePersist();
  renderPlaylist();
  loadAndPlay(0);
  showToast('Shuffled!');
});

/* ─── Sidebar Toggle ──────────────────────────────────────────────── */
dom.sidebarToggle.addEventListener('click', () => {
  dom.sidebar.classList.toggle('collapsed');
});

async function resolveSpotlightrUrl(url) {
  let videoID = null;
  const match1 = url.match(SPOTLIGHTR_WATCH);
  const match2 = url.match(SPOTLIGHTR_EMBED);
  
  if (match1) videoID = match1[1];
  else if (match2) videoID = match2[1];
  
  if (!videoID) throw new Error('Could not extract Spotlightr video ID');

  return { 
    srcUrl: `https://videos.cdn.spotlightr.com/watch/${videoID}`, 
    type: 'iframe', 
    title: 'Spotlightr Secure Video' 
  };
}
/* ─── Player Engine ───────────────────────────────────────────────── */
let isLoadingIntentional = false;

function stopPlayer() {
  if (hls) { hls.destroy(); hls = null; }
  isLoadingIntentional = false;
  dom.video.pause();
  dom.video.src = '';
  dom.video.load();
  dom.video.classList.remove('loaded');
  dom.iframePlayer.src = '';
  dom.iframePlayer.style.display = 'none';
  dom.video.style.display = 'block';
  dom.loadingOverlay.setAttribute('hidden', '');
  
  // reset UI
  dom.playerContainer.classList.remove('video-loaded');
  dom.idleScreen.style.display = 'flex';
  dom.bigPlayOverlay.setAttribute('hidden', '');
  $('now-playing').setAttribute('hidden', '');
  $('current-time').textContent = '0:00';
  $('duration').textContent = '0:00';
  dom.progressFill.style.width = '0%';
  dom.progressThumb.style.left = '0%';
  dom.progressBuffered.style.width = '0%';
  dom.controls.classList.remove('iframe-mode');
}

async function loadAndPlay(index) {
  if (index < 0 || index >= playlist.length) return;
  currentIndex = index;
  renderPlaylist();
  stopPlayer();
  stopRecording();

  const item = playlist[index];
  dom.playerContainer.classList.add('video-loaded');
  dom.idleScreen.style.display = 'none';
  hideError();
  isLoadingIntentional = true;
  dom.loadingOverlay.removeAttribute('hidden');

  let srcUrl = item.url;
  let srcType = item.type;
  let resolvedTitle = item.title;

  try {
    if (item.type === 'spotlightr') {
      const resolved = await resolveSpotlightrUrl(item.url);
      srcUrl = resolved.srcUrl;
      srcType = resolved.type;
      if (resolved.title) resolvedTitle = resolved.title;
    }

    currentVideoMeta = { url: item.url, srcUrl, type: srcType, title: resolvedTitle };
    updateNowPlaying(resolvedTitle, srcType);
    updateDownloadCommand(srcUrl);

    if (srcType === 'hls') {
      dom.iframePlayer.style.display = 'none';
      dom.video.style.display = 'block';
      await loadHLS(srcUrl);
    } else if (srcType === 'iframe') {
      dom.video.style.display = 'none';
      dom.iframePlayer.style.display = 'block';
      dom.controls.classList.add('iframe-mode');
      dom.iframePlayer.src = srcUrl;
      dom.loadingOverlay.setAttribute('hidden', '');
    } else {
      dom.iframePlayer.style.display = 'none';
      dom.video.style.display = 'block';
      await loadDirect(srcUrl);
    }
  } catch (err) {
    dom.loadingOverlay.setAttribute('hidden', '');
    showError(err.message || 'Could not load video.');
  }
}

function loadHLS(m3u8Url) {
  return new Promise((resolve, reject) => {
    if (!Hls.isSupported()) {
      // Try native HLS (e.g. Safari)
      dom.video.src = m3u8Url;
      dom.video.addEventListener('canplay', resolve, { once: true });
      dom.video.addEventListener('error', (e) => reject(new Error('HLS load error')), { once: true });
      dom.video.play().catch(() => {});
      return;
    }

    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90
    });

    hls.loadSource(m3u8Url);
    hls.attachMedia(dom.video);

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        dom.loadingOverlay.setAttribute('hidden', '');
        showError(`HLS Error: ${data.details}`);
        reject(new Error(data.details));
      } else if (data.details === 'fragParsingError' || data.details === 'internalException') {
        // Handle common DRM error cases
        showToast('Stream may be encrypted or blocked by CORS.');
      }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      dom.loadingOverlay.setAttribute('hidden', '');
      dom.video.classList.add('loaded');
      dom.video.play().catch(() => {});
      resolve();
    });
  });
}

function loadDirect(url) {
  return new Promise((resolve, reject) => {
    dom.video.src = url;
    dom.video.load();
    function onCanPlay() {
      cleanup();
      dom.loadingOverlay.setAttribute('hidden', '');
      dom.video.classList.add('loaded');
      dom.video.play().catch(() => {});
      resolve();
    }
    function onError() {
      // Ignore errors on empty src (initial state)
      if (!dom.video.src || dom.video.src === window.location.href) return;
      cleanup();
      reject(new Error('Could not load video. Check URL and CORS policy.'));
    }
    function cleanup() {
      dom.video.removeEventListener('canplay', onCanPlay);
      dom.video.removeEventListener('error', onError);
    }
    dom.video.addEventListener('canplay', onCanPlay, { once: true });
    dom.video.addEventListener('error', onError, { once: true });
  });
}

window.app = { retryLoad: () => { if (currentIndex >= 0) loadAndPlay(currentIndex); } };

/* ─── Video Event Handling ────────────────────────────────────────── */
dom.video.addEventListener('timeupdate', updateProgress);
dom.video.addEventListener('progress', updateBuffered);
dom.video.addEventListener('durationchange', () => {
  dom.duration.textContent = formatTime(dom.video.duration);
});
dom.video.addEventListener('play', () => updatePlayPauseUI(true));
dom.video.addEventListener('pause', () => updatePlayPauseUI(false));
dom.video.addEventListener('ended', () => {
  if (currentIndex < playlist.length - 1) {
    loadAndPlay(currentIndex + 1);
  } else {
    updatePlayPauseUI(false);
  }
});
dom.video.addEventListener('waiting', () => {
  if (isLoadingIntentional) dom.loadingOverlay.removeAttribute('hidden');
});
dom.video.addEventListener('playing', () => {
  dom.loadingOverlay.setAttribute('hidden', '');
});
dom.video.addEventListener('click', () => togglePlay());

function updatePlayPauseUI(playing) {
  dom.playIcon.toggleAttribute('hidden', playing);
  dom.pauseIcon.toggleAttribute('hidden', !playing);
  // Show big icon feedback
  dom.bigPlayIcon.textContent = playing ? '▶' : '⏸';
  dom.bigPlayIcon.classList.remove('show');
  void dom.bigPlayIcon.offsetWidth; // force reflow
  dom.bigPlayIcon.classList.add('show');
}

function updateProgress() {
  const v = dom.video;
  if (!v.duration) return;
  const pct = (v.currentTime / v.duration) * 100;
  dom.progressFill.style.width = pct + '%';
  dom.progressThumb.style.left = pct + '%';
  dom.progressWrap.setAttribute('aria-valuenow', Math.round(pct));
  dom.currentTime.textContent = formatTime(v.currentTime);
}

function updateBuffered() {
  const v = dom.video;
  if (!v.duration || !v.buffered.length) return;
  const end = v.buffered.end(v.buffered.length - 1);
  dom.progressBuffered.style.width = ((end / v.duration) * 100) + '%';
}

/* ─── Controls: Play/Pause/Nav ────────────────────────────────────── */
function togglePlay() {
  if (!currentVideoMeta || dom.controls.classList.contains('iframe-mode')) return;
  if (dom.video.paused) dom.video.play().catch(() => {});
  else dom.video.pause();
}

dom.playBtn.addEventListener('click', togglePlay);
dom.prevBtn.addEventListener('click', () => {
  if (currentIndex > 0) loadAndPlay(currentIndex - 1);
  else if (playlist.length > 0) { dom.video.currentTime = 0; }
});
dom.nextBtn.addEventListener('click', () => {
  if (currentIndex < playlist.length - 1) loadAndPlay(currentIndex + 1);
});

/* ─── Controls: Seek ─────────────────────────────────────────────── */
function seekTo(e) {
  const rect = dom.progressWrap.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const pct = x / rect.width;
  if (dom.video.duration) {
    dom.video.currentTime = pct * dom.video.duration;
  }
}

function updateTooltip(e) {
  const rect = dom.progressWrap.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const pct = x / rect.width;
  const t = pct * (dom.video.duration || 0);
  dom.timeTooltip.textContent = formatTime(t);
  dom.timeTooltip.style.left = x + 'px';
}

dom.progressWrap.addEventListener('mousedown', e => {
  isDragging = true;
  seekTo(e);
});
document.addEventListener('mousemove', e => {
  if (isDragging) seekTo(e);
  if (e.target.closest('#progress-wrap')) updateTooltip(e);
});
document.addEventListener('mouseup', () => { isDragging = false; });
dom.progressWrap.addEventListener('mousemove', updateTooltip);

/* ─── Controls: Volume ───────────────────────────────────────────── */
dom.volSlider.addEventListener('input', () => {
  dom.video.volume = parseFloat(dom.volSlider.value);
  dom.video.muted = dom.video.volume === 0;
  updateVolumeUI();
});

dom.muteBtn.addEventListener('click', () => {
  dom.video.muted = !dom.video.muted;
  if (!dom.video.muted && dom.video.volume === 0) dom.video.volume = 0.5;
  updateVolumeUI();
});

function updateVolumeUI() {
  const muted = dom.video.muted || dom.video.volume === 0;
  dom.volIcon.toggleAttribute('hidden', muted);
  dom.muteIcon.toggleAttribute('hidden', !muted);
  dom.volSlider.value = muted ? 0 : dom.video.volume;
}

function setSpeed(v) {
  v = parseFloat(v);
  if (isNaN(v)) return;
  v = Math.min(16, Math.max(0.1, parseFloat(v.toFixed(2))));
  
  // If iframe is playing, we can't change speed directly due to browser security
  if (dom.video.style.display === 'none') {
    showToast('Secure Video: Use "Open Source" + Bookmarklet Hack for Speed');
    return;
  }

  dom.video.playbackRate = v;
  dom.speedBtn.textContent = v + '×';
  dom.extSpeedDisplay.textContent = v + 'x';
  dom.extSpeedSlider.value = v;
  
  dom.speedMenu.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.speed) === v);
  });
  showToast(`Speed: ${v}×`);
}

dom.setCustomSpeed.addEventListener('click', () => {
  setSpeed(dom.customSpeed.value);
  dom.speedMenu.setAttribute('hidden', '');
});

dom.customSpeed.addEventListener('keydown', e => {
  if (e.key === 'Enter') dom.setCustomSpeed.click();
});


/* ─── Controls: Speed ────────────────────────────────────────────── */
dom.speedBtn.addEventListener('click', e => {
  e.stopPropagation();
  dom.speedMenu.toggleAttribute('hidden');
  hideDownloadMenu();
});

dom.speedMenu.querySelectorAll('button[data-speed]').forEach(btn => {
  btn.addEventListener('click', () => {
    setSpeed(btn.dataset.speed);
    dom.speedMenu.setAttribute('hidden', '');
  });
});

/* ─── Controls: Fullscreen ───────────────────────────────────────── */
dom.fsBtn.addEventListener('click', () => {
  const target = dom.playerContainer;
  if (!document.fullscreenElement) {
    (target.requestFullscreen || target.webkitRequestFullscreen).call(target);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
});

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  dom.fsIcon.toggleAttribute('hidden', isFs);
  dom.fsExitIcon.toggleAttribute('hidden', !isFs);
});

/* ─── Controls: Show/hide on hover ──────────────────────────────── */
dom.playerContainer.addEventListener('mousemove', showControls);
dom.playerContainer.addEventListener('touchstart', showControls, { passive: true });

function showControls() {
  dom.playerContainer.classList.add('controls-visible');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    if (!dom.video.paused) dom.playerContainer.classList.remove('controls-visible');
  }, 3500);
}

/* ─── Close menus on outside click ──────────────────────────────── */
document.addEventListener('click', e => {
  if (!e.target.closest('.speed-wrap')) dom.speedMenu.setAttribute('hidden', '');
  if (!e.target.closest('.download-wrap')) hideDownloadMenu();
});

function hideDownloadMenu() { dom.downloadMenu.setAttribute('hidden', ''); }

/* ─── Keyboard Shortcuts ─────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': dom.video.currentTime = Math.min(dom.video.duration||0, dom.video.currentTime + 10); break;
    case 'ArrowLeft':  dom.video.currentTime = Math.max(0, dom.video.currentTime - 10); break;
    case 'ArrowUp':    dom.video.volume = Math.min(1, dom.video.volume + 0.1); updateVolumeUI(); break;
    case 'ArrowDown':  dom.video.volume = Math.max(0, dom.video.volume - 0.1); updateVolumeUI(); break;
    case 'm': case 'M': dom.muteBtn.click(); break;
    case 'f': case 'F': dom.fsBtn.click(); break;
    case 'n': case 'N': dom.nextBtn.click(); break;
    case 'p': case 'P': dom.prevBtn.click(); break;
    // Speed extensions like (shift + . and shift + ,)
    case '>': setSpeed(dom.video.playbackRate + 0.25); break;
    case '<': setSpeed(Math.max(0.25, dom.video.playbackRate - 0.25)); break;
    case 'r': case 'R': setSpeed(1); break;
  }
});

/* ─── Now Playing Info ────────────────────────────────────────────── */
function updateNowPlaying(title, type) {
  dom.nowPlaying.removeAttribute('hidden');
  dom.npTitle.textContent = title;
  const badge = typeBadge(type);
  dom.npType.textContent = badge.label;
  dom.npType.className = 'np-type-badge ' + badge.cls;
  
  if (currentVideoMeta && currentVideoMeta.srcUrl) {
    dom.npLink.href = currentVideoMeta.srcUrl;
    dom.npLink.style.display = 'flex';
  } else {
    dom.npLink.style.display = 'none';
  }
}

/* ─── Download ────────────────────────────────────────────────────── */
dom.downloadBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (!currentVideoMeta) { showToast('No video loaded'); return; }
  dom.downloadMenu.toggleAttribute('hidden');
  dom.speedMenu.setAttribute('hidden', '');
});

function updateDownloadCommand(srcUrl) {
  const cmd = `yt-dlp "${srcUrl}" -o "%(title)s.%(ext)s"`;
  dom.dlCmd.textContent = cmd;
}

dom.dlCopyCmd.addEventListener('click', () => {
  navigator.clipboard.writeText(dom.dlCmd.textContent)
    .then(() => showToast('Command copied!'))
    .catch(() => showToast('Copy failed — please copy manually'));
});

dom.dlDirect.addEventListener('click', async () => {
  hideDownloadMenu();
  if (!currentVideoMeta) return;
  const { srcUrl, type, title } = currentVideoMeta;

  if (type === 'hls') {
    showToast('HLS streams cannot be downloaded directly. Use yt-dlp command shown.', 4000);
    return;
  }

  showToast('Downloading…');
  try {
    const resp = await fetch(srcUrl);
    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (title || 'video').replace(/[<>:"/\\|?*]/g, '_') + getExt(srcUrl);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Download started!');
  } catch (err) {
    showToast('Download failed: ' + err.message, 5000);
  }
});

dom.dlRecord.addEventListener('click', () => {
  hideDownloadMenu();
  if (!currentVideoMeta) return;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    showToast('Already recording!');
    return;
  }
  startRecording();
});

dom.recStop.addEventListener('click', stopRecording);

function getExt(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.[a-z0-9]+$/i);
    return m ? m[0] : '.mp4';
  } catch { return '.mp4'; }
}

function startRecording() {
  if (!dom.video.srcObject && !dom.video.currentSrc) {
    showToast('No video to record');
    return;
  }

  let stream;
  try {
    stream = dom.video.captureStream ? dom.video.captureStream() : dom.video.mozCaptureStream();
  } catch (e) {
    showToast('captureStream not supported in this browser');
    return;
  }

  const mimeType = getSupportedMimeType();
  if (!mimeType) { showToast('MediaRecorder not supported'); return; }

  recChunks = [];
  recSize = 0;

  mediaRecorder = new MediaRecorder(stream, { mimeType });
  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
      recChunks.push(e.data);
      recSize += e.data.size;
      dom.recSize.textContent = formatBytes(recSize);
    }
  };
  mediaRecorder.onstop = saveRecording;
  mediaRecorder.start(1000);

  dom.recToast.style.display = 'flex';
  showToast('Recording started — play the video now!');

  if (dom.video.paused) dom.video.play().catch(() => {});
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  dom.recToast.style.display = 'none';
}

function saveRecording() {
  if (!recChunks.length) { showToast('Nothing was recorded'); return; }
  const mimeType = mediaRecorder.mimeType;
  const ext = mimeType.includes('webm') ? '.webm' : mimeType.includes('mp4') ? '.mp4' : '.webm';
  const blob = new Blob(recChunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const title = currentVideoMeta?.title || 'recording';
  a.href = url;
  a.download = title.replace(/[<>:"/\\|?*]/g, '_') + ext;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Saved: ${formatBytes(blob.size)}`);
  recChunks = [];
  recSize = 0;
}

function getSupportedMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
}

/* ─── Bulk Import ─────────────────────────────────────────────────── */
dom.showBulkBtn.addEventListener('click', () => {
  dom.bulkModal.removeAttribute('hidden');
  dom.bulkInput.focus();
});

dom.closeBulkBtn.addEventListener('click', () => {
  dom.bulkModal.setAttribute('hidden', '');
});

// Close modal on escape
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !dom.bulkModal.hasAttribute('hidden')) {
    dom.bulkModal.setAttribute('hidden', '');
  }
});

dom.importBtn.addEventListener('click', () => {
  const text = dom.bulkInput.value;
  if (!text.trim()) return;

  const lines = text.split('\n').map(l => l.trim());
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Detect if line is a URL
    if (line.match(/^https?:\/\//i)) {
      const url = line;
      let title = '';

      // Look for the next non-empty line that isn't a URL to use as title
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j]) continue;
        if (lines[j].match(/^https?:\/\//i)) break; // Found next URL, stop title search
        title = lines[j];
        i = j; // skip titles
        break;
      }

      if (addItem(url, title, true)) count++;
    } else {
      // It's a title without a preceding URL on this line?
      // Or maybe it's title then URL?
      // Check if next line is a URL
      if (i + 1 < lines.length && lines[i+1].match(/^https?:\/\//i)) {
        const title = line;
        const url = lines[i+1];
        if (addItem(url, title, true)) count++;
        i++; // skip url
      }
    }
  }

  if (count > 0) {
    dom.bulkModal.setAttribute('hidden', '');
    dom.bulkInput.value = '';
    showToast(`Successfully imported ${count} videos!`);
  } else {
    showToast('No valid URLs found in text.');
  }
});

/* ─── Init ────────────────────────────────────────────────────────── */
function init() {
  loadPersist();
  renderPlaylist();

  // Restore volume
  const savedVol = parseFloat(localStorage.getItem('videovault_vol') || '1');
  dom.video.volume = savedVol;
  dom.volSlider.value = savedVol;

  dom.video.addEventListener('volumechange', () => {
    localStorage.setItem('videovault_vol', dom.video.volume);
    updateVolumeUI();
  });

  // Auto play first item if playlist exists
  if (playlist.length > 0) {
    // Don't auto play on load, just show idle
    dom.idleScreen.style.display = 'flex';
  }

  console.log('%cVideoVault loaded!', 'color:#7c5cfc;font-size:16px;font-weight:bold;');
  console.log('%cPlaylist items:', 'color:#4f9eff;', playlist.length);
}

/* ─── Mobile Speed Hacker Helper ─────────────────────────────────── */
dom.showBkModal.addEventListener('click', () => {
  dom.bkModal.removeAttribute('hidden');
  dom.speedMenu.setAttribute('hidden', '');
});

dom.closeBkBtn.addEventListener('click', () => dom.bkModal.setAttribute('hidden', ''));
dom.doneBkBtn.addEventListener('click', () => dom.bkModal.setAttribute('hidden', ''));

dom.showSpeedBtnSide.addEventListener('click', () => {
  dom.bkModal.removeAttribute('hidden');
});

dom.setCustomSpeedModal.addEventListener('click', () => {
  setSpeed(dom.customSpeedModal.value);
  dom.bkModal.setAttribute('hidden', '');
});

dom.extSpeedMinus.addEventListener('click', () => setSpeed(dom.video.playbackRate - 0.25));
dom.extSpeedPlus.addEventListener('click', () => setSpeed(dom.video.playbackRate + 0.25));
dom.extSpeedReset.addEventListener('click', () => setSpeed(1));

dom.extSpeedSlider.addEventListener('input', () => {
  setSpeed(dom.extSpeedSlider.value);
});

init();
