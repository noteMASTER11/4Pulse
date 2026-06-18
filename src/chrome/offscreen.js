
(() => {
  let audio = null;
  let state = {
    station: '',
    stationName: '',
    volume: 70,
    isPlaying: false,
    lastError: ''
  };

  function getAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      // Do not set crossOrigin for raw radio streams: many stations do not send CORS headers.
      audio.onerror = () => {
        state.isPlaying = false;
        state.lastError = describeError(audio?.error);
        sendEvent('error');
      };
      audio.onplaying = () => {
        state.isPlaying = true;
        state.lastError = '';
        sendEvent('playing');
      };
      audio.onpause = () => {
        state.isPlaying = false;
        sendEvent('pause');
      };
      audio.onended = () => {
        state.isPlaying = false;
        sendEvent('pause');
      };
    }
    return audio;
  }

  function describeError(error) {
    const code = error?.code;
    if (code === 2) return 'Ошибка сети — поток недоступен';
    if (code === 3) return 'Ошибка декодирования потока';
    if (code === 4) return 'Станция не отвечает или формат не поддерживается';
    return 'Поток недоступен';
  }

  function publicState() {
    return {
      isPlaying: state.isPlaying,
      lastError: state.lastError,
      station: state.station,
      stationName: state.stationName,
      volume: state.volume
    };
  }

  function sendEvent(type) {
    try {
      chrome.runtime.sendMessage({
        action: 'radio_offscreen_event',
        type,
        ...publicState()
      });
    } catch (_) {}
  }

  function playWithTimeout(audio, timeoutMs = 12000) {
    return Promise.race([
      audio.play(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), timeoutMs))
    ]);
  }

  async function play(station, stationName, volume) {
    if (station) {
      state.station = station;
      state.stationName = stationName || '';
    }
    if (Number.isFinite(volume)) state.volume = Math.max(0, Math.min(100, volume));
    if (!state.station) {
      state.isPlaying = false;
      state.lastError = 'Станция не выбрана';
      return publicState();
    }

    const a = getAudio();
    a.volume = state.volume / 100;

    const urls = [state.station];
    if (state.station.startsWith('https://')) urls.push('http://' + state.station.slice(8));

    let lastError = null;
    for (const url of urls) {
      try {
        if (a.src !== url) {
          a.pause();
          a.src = url;
          a.load();
        }
        await playWithTimeout(a);
        state.isPlaying = true;
        state.lastError = '';
        sendEvent('playing');
        return publicState();
      } catch (e) {
        lastError = e;
        try { a.pause(); a.removeAttribute('src'); a.load(); } catch (_) {}
      }
    }

    state.isPlaying = false;
    const msg = String(lastError?.message || lastError || '');
    state.lastError = msg.includes('timeout') ? 'Нет ответа от станции (таймаут)' : 'Станция не отвечает или формат не поддерживается';
    sendEvent('error');
    return publicState();
  }

  async function pause() {
    try { if (audio) audio.pause(); } catch (_) {}
    state.isPlaying = false;
    sendEvent('pause');
    return publicState();
  }

  async function setVolume(volume) {
    state.volume = Math.max(0, Math.min(100, Number(volume) || 0));
    if (audio) audio.volume = state.volume / 100;
    return publicState();
  }


  const notifyAudioCache = {};

  async function playNotifySound(soundFile = 'notify', volume = 50) {
    const safeName = String(soundFile || 'notify').replace(/[^a-z0-9_-]/gi, '') || 'notify';
    const url = chrome.runtime.getURL(`sounds/${safeName}.ogg`);
    let a = notifyAudioCache[safeName];
    if (!a || a.error) {
      a = new Audio(url);
      a.preload = 'auto';
      notifyAudioCache[safeName] = a;
    }
    a.volume = Math.max(0, Math.min(1, (Number(volume) || 50) / 100));
    try { a.currentTime = 0; } catch (_) {}
    await a.play();
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== 'radio_offscreen_command') return;
    (async () => {
      if (message.cmd === 'play') return await play(message.station, message.stationName, message.volume);
      if (message.cmd === 'pause') return await pause();
      if (message.cmd === 'volume') return await setVolume(message.volume);
      if (message.cmd === 'state') return publicState();
      if (message.cmd === 'notifySound') return await playNotifySound(message.soundFile, message.volume);
      return publicState();
    })().then(sendResponse).catch(error => {
      state.isPlaying = false;
      state.lastError = error?.message || 'Radio error';
      sendResponse(publicState());
    });
    return true;
  });
})();
